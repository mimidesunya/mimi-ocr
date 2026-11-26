const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { resolveNdlocrLite, _internal } = require('../dist/src/lib/tool_resolver.js');
const { buildNdlocrArgs, getNdlocrLaunch } = require('../dist/src/lib/ndlocr_runner.js');

const isWindows = process.platform === 'win32';

function makeFakeRepo(root, version, requirements) {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'ocr.py'), 'print("fake")\n');
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), `[project]\nname = "ndlocr-lite"\nversion = "${version}"\n`);
    fs.writeFileSync(path.join(repo, 'requirements.txt'), requirements);
    return repo;
}

// 環境変数を差し替え、試験の終わりに戻す
function setEnv(t, values) {
    const saved = {};
    for (const [key, value] of Object.entries(values)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

function makeTempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ndlocr-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

async function captureLogs(fn) {
    const lines = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...args) => { lines.push(args.join(' ')); };
    console.warn = (...args) => { lines.push(args.join(' ')); };
    try {
        return { result: await fn(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
    }
}

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// PyPI 版 ndlocr-lite を真似た wheel（ネットワークに出ずに pip で入れるため）。
// cli:main は受け取った引数を表示し、model_download は MODELS と保存先だけを持つ（取得はしない）。
function makeFakeNdlocrWheel(wheelDir, version, modelCacheDir, models) {
    const distInfo = `ndlocr_lite-${version}.dist-info`;
    const modelsPy = Object.entries(models)
        .map(([option, [name, digest]]) => `${JSON.stringify(option)}: (${JSON.stringify(name)}, ${JSON.stringify(digest)})`)
        .join(', ');
    const files = {
        'cli.py': 'import sys\n\ndef main():\n    print("fake-ndlocr " + " ".join(sys.argv[1:]))\n',
        'model_download.py': [
            'import pathlib',
            `MODELS = {${modelsPy}}`,
            'def model_cache_dir():',
            `    return pathlib.Path(${JSON.stringify(modelCacheDir)})`,
            'def get_model_path(filename, expected_hash, bundled_dir):',
            '    raise RuntimeError("tests do not download models")',
            '',
        ].join('\n'),
        [`${distInfo}/METADATA`]: `Metadata-Version: 2.1\nName: ndlocr-lite\nVersion: ${version}\n`,
        [`${distInfo}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: mimi-ocr-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        [`${distInfo}/entry_points.txt`]: '[console_scripts]\nndlocr-lite = cli:main\n',
    };
    const zip = new AdmZip();
    const record = [];
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text, 'utf-8');
        zip.addFile(name, data);
        const digest = crypto.createHash('sha256').update(data).digest('base64url');
        record.push(`${name},sha256=${digest},${data.length}`);
    }
    record.push(`${distInfo}/RECORD,,`);
    zip.addFile(`${distInfo}/RECORD`, Buffer.from(`${record.join('\n')}\n`, 'utf-8'));
    fs.mkdirSync(wheelDir, { recursive: true });
    zip.writeZip(path.join(wheelDir, `ndlocr_lite-${version}-py3-none-any.whl`));
}

test('a configured ndlocr-lite repo with its own Python runs src/ocr.py as is, even when older than 1.4.0', async (t) => {
    const root = makeTempRoot(t);
    const repo = makeFakeRepo(root, '1.3.1', '# none\n');
    const python = process.execPath; // 起動できる実行ファイルなら何でもよい（pythonPath を指定すると venv を作らない）
    const resolved = await resolveNdlocrLite({ repoPath: repo, pythonPath: python });
    assert.deepEqual(resolved, { kind: 'repo', repoPath: repo, pythonPath: python });
    assert.ok(fs.existsSync(path.join(repo, 'src', 'ocr.py')));

    const launch = getNdlocrLaunch(resolved);
    assert.equal(launch.command, python);
    assert.deepEqual(launch.args, [path.join(repo, 'src', 'ocr.py')]);
    assert.equal(launch.cwd, path.join(repo, 'src'));
});

test('ndlocr-lite arguments are built apart from how it is started', () => {
    assert.deepEqual(buildNdlocrArgs('in', 'out', true), ['--sourcedir', 'in', '--output', 'out']);
    assert.deepEqual(buildNdlocrArgs('a.png', 'out'), ['--sourceimg', 'a.png', '--output', 'out']);
    assert.deepEqual(buildNdlocrArgs('a.pdf', 'out', 'pdf', ['--pdf-output', 'b.pdf', '--json-only']),
        ['--sourcepdf', 'a.pdf', '--output', 'out', '--pdf-output', 'b.pdf', '--json-only']);

    const command = process.execPath;
    assert.deepEqual(getNdlocrLaunch({ kind: 'pip', command, pythonPath: 'unused' }), { command, args: [], cwd: undefined });
    assert.throws(() => getNdlocrLaunch({ kind: 'pip', command: path.join(os.tmpdir(), 'no-such-ndlocr-lite') }), /ndlocr-lite が見つかりません/);
});

test('without Python 3.11 the venv is made with uv; a configured Python is still used', (t) => {
    const root = makeTempRoot(t);
    setEnv(t, { MIMI_TOOLS_DIR: path.join(root, 'tools'), MIMI_TOOLS_IGNORE_SYSTEM_PYTHON: '1' });

    assert.equal(_internal.findSystemPython([3, 11]), null);
    assert.deepEqual(_internal.chooseNdlocrVenvBase(''), { kind: 'uv' });
    // process.execPath は "v24.x.y" を返すので、3.11 以上の Python の代わりになる
    assert.deepEqual(_internal.chooseNdlocrVenvBase(process.execPath), { kind: 'python', command: process.execPath, argsPrefix: [] });
    assert.throws(() => _internal.chooseNdlocrVenvBase(path.join(root, 'no-such-python.exe')), /設定されたPythonを起動できません/);

    const win = _internal.getUvRelease('win32', 'x64');
    assert.equal(win.url, `https://github.com/astral-sh/uv/releases/download/${_internal.UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`);
    assert.match(win.sha256, /^[0-9a-f]{64}$/);
    assert.equal(win.exeName, 'uv.exe');
    const mac = _internal.getUvRelease('darwin', 'arm64');
    assert.match(mac.url, /uv-aarch64-apple-darwin\.tar\.gz$/);
    assert.equal(mac.exeName, 'uv');
    assert.equal(_internal.getUvRelease('linux', 'x64'), null);
});

test('the uv route installs Python into the tools folder without touching PATH or the registry', { skip: !_internal.getUvRelease() && 'uv is fetched only on Windows and macOS' }, async (t) => {
    const root = makeTempRoot(t);
    const toolsDir = path.join(root, 'tools');
    setEnv(t, { MIMI_TOOLS_DIR: toolsDir, MIMI_TOOLS_IGNORE_SYSTEM_PYTHON: '1' });

    // 偽の uv: node の実行ファイルを uv の名前で置き、版の印も付けておく（取りにいかない）。
    // uv は作業フォルダ（外部ツール保存先）で起動されるので、"uv python ..." は python.js を、"uv venv ..." は venv.js を動かす。
    const release = _internal.getUvRelease();
    const uvDir = path.join(toolsDir, 'uv');
    fs.mkdirSync(uvDir, { recursive: true });
    const fakeUv = path.join(uvDir, release.exeName);
    try { fs.linkSync(process.execPath, fakeUv); } catch (_err) { fs.copyFileSync(process.execPath, fakeUv); }
    fs.writeFileSync(path.join(uvDir, '.mimi-version'), release.version);
    const callLog = path.join(toolsDir, 'uv-calls.jsonl');
    const recordCall = `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({
    args: [require('path').basename(__filename, '.js'), ...process.argv.slice(2)],
    installDir: process.env.UV_PYTHON_INSTALL_DIR, cacheDir: process.env.UV_CACHE_DIR, preference: process.env.UV_PYTHON_PREFERENCE,
}) + '\\n');
`;
    fs.writeFileSync(path.join(toolsDir, 'python.js'), recordCall);
    fs.writeFileSync(path.join(toolsDir, 'venv.js'), `${recordCall}
const path = require('path');
const venvDir = process.argv[process.argv.length - 1];
const python = ${JSON.stringify(isWindows)} ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
fs.mkdirSync(path.dirname(python), { recursive: true });
try { fs.linkSync(process.execPath, python); } catch (_err) { fs.copyFileSync(process.execPath, python); }
`);

    const venvDir = path.join(toolsDir, 'ndlocr-lite-venv');
    const venvPython = await _internal.ensureNdlocrVenvPython(venvDir, '');
    assert.ok(fs.existsSync(venvPython));

    const calls = fs.readFileSync(callLog, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    const pythonVersion = _internal.UV_PYTHON_VERSION;
    assert.deepEqual(calls.map(call => call.args), [
        isWindows
            ? ['python', 'install', '--no-bin', '--no-registry', pythonVersion]
            : ['python', 'install', '--no-bin', pythonVersion],
        ['venv', '--seed', '--python', pythonVersion, venvDir],
    ]);
    for (const call of calls) {
        assert.equal(call.installDir, path.join(toolsDir, 'uv-python'));
        assert.equal(call.cacheDir, path.join(toolsDir, 'uv-cache'));
        assert.equal(call.preference, 'only-managed');
    }

    // 二度目は作らない
    await _internal.ensureNdlocrVenvPython(venvDir, '');
    assert.equal(fs.readFileSync(callLog, 'utf-8').trim().split('\n').length, 2);
});

// 以下は PC の Python 3.11 以上で本物の venv を作る（無ければ飛ばす。uv で取りにいかない）。
function skipWithoutPython(t) {
    if (_internal.findSystemPython([3, 11])) return false;
    t.skip('Python 3.11 以上が無い');
    return true;
}

test('the ndlocr-lite version setting picks 1.4.0 from GitHub by default and 2.x from PyPI on request', () => {
    const { normalizeNdlocrLine, isNdlocrPipVersionInRange, NDLOCR_LINES, NDLOCR_LITE_1_4_URL } = _internal;
    for (const value of [undefined, '', '1.4.0', '1.4', '1', 'v1.4.0', 'unknown']) {
        assert.equal(normalizeNdlocrLine(value), '1.4', String(value));
    }
    for (const value of ['2', '2.0', '2.0.0', 'v2', 'PyPI']) {
        assert.equal(normalizeNdlocrLine(value), '2', String(value));
    }
    assert.equal(NDLOCR_LINES['1.4'].spec(), `ndlocr-lite @ ${NDLOCR_LITE_1_4_URL}`);
    assert.match(NDLOCR_LITE_1_4_URL, /^https:\/\/github\.com\/ndl-lab\/ndlocr-lite\/archive\/refs\/tags\/1\.4\.0\.zip$/);
    assert.equal(NDLOCR_LINES['2'].spec(), 'ndlocr-lite>=2.0,<3');
    assert.equal(isNdlocrPipVersionInRange([1, 4, 0], '1.4'), true);
    assert.equal(isNdlocrPipVersionInRange([2, 0, 0], '1.4'), false);
    assert.equal(isNdlocrPipVersionInRange([2, 0, 0], '2'), true);
    assert.equal(isNdlocrPipVersionInRange([1, 4, 0], '2'), false);
    assert.equal(isNdlocrPipVersionInRange(null, '1.4'), false);
});

test('pip ndlocr-lite is installed into the venv, its version is recorded, and it is reinstalled when the version line changes', async (t) => {
    const root = makeTempRoot(t);
    const toolsDir = path.join(root, 'tools');
    const wheelDir = path.join(root, 'wheels');
    const wheel14Dir = path.join(root, 'wheel-1.4');
    const modelCache = path.join(root, 'model-cache');
    // 1.4.0 は GitHub のタグの zip の代わりに、手元の wheel を指す（ネットワークに出ない）。
    makeFakeNdlocrWheel(wheel14Dir, '1.4.0', modelCache, {});
    setEnv(t, {
        MIMI_TOOLS_DIR: toolsDir,
        MIMI_TOOLS_IGNORE_SYSTEM_PYTHON: undefined,
        MIMI_NDLOCR_LITE_1_4_URL: require('node:url').pathToFileURL(path.join(wheel14Dir, 'ndlocr_lite-1.4.0-py3-none-any.whl')).href,
        PIP_NO_INDEX: '1',
        PIP_FIND_LINKS: wheelDir,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
    });
    if (skipWithoutPython(t)) return;

    // 前の版で GitHub から取った写し（src/model にモデルがある）。消さずに残し、モデルは写す。
    const oldCopy = path.join(toolsDir, 'ndlocr-lite');
    const model = Buffer.from('fake det weights');
    fs.mkdirSync(path.join(oldCopy, 'src', 'model'), { recursive: true });
    fs.writeFileSync(path.join(oldCopy, 'src', 'ocr.py'), 'print("old")\n');
    fs.writeFileSync(path.join(oldCopy, 'src', 'model', 'fake-det.onnx'), model);
    makeFakeNdlocrWheel(wheelDir, '2.0.0', modelCache, { det_weights: ['fake-det.onnx', sha256Hex(model)] });

    // 既定は 1.4.0
    const first = await captureLogs(() => resolveNdlocrLite({}));
    const venvDir = path.join(toolsDir, 'ndlocr-lite-venv');
    const command = isWindows ? path.join(venvDir, 'Scripts', 'ndlocr-lite.exe') : path.join(venvDir, 'bin', 'ndlocr-lite');
    assert.equal(first.result.kind, 'pip');
    assert.equal(first.result.command, command);
    const marker = path.join(venvDir, '.mimi-installed');
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'ndlocr-lite==1.4.0');
    assert.ok(first.lines.some(line => line.includes('ndlocr-lite 1.4.0 を GitHub から入れます')), first.lines.join('\n'));
    assert.ok(first.lines.some(line => line.includes('ndlocr-lite 1.4.0 を入れました')), first.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(oldCopy, 'src', 'ocr.py')), 'the old GitHub copy is kept');

    // 入った ndlocr-lite が、作った引数で起動できる
    const run = spawnSync(command, buildNdlocrArgs('in-dir', 'out-dir', true), { encoding: 'utf-8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /fake-ndlocr --sourcedir in-dir --output out-dir/);

    // 範囲内の印なら入れ直さない
    const second = await captureLogs(() => resolveNdlocrLite({ version: '1.4.0' }));
    assert.deepEqual(second.result, first.result);
    assert.ok(!second.lines.some(line => line.includes('を入れました')), second.lines.join('\n'));

    // 版の設定を 2 にすると PyPI の 2.x へ入れ替え、モデルは前の写しから写す
    const third = await captureLogs(() => resolveNdlocrLite({ version: '2' }));
    assert.ok(third.lines.some(line => line.includes('2.x（PyPI）に入れ替えます')), third.lines.join('\n'));
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'ndlocr-lite==2.0.0');
    assert.ok(third.lines.some(line => line.includes('モデル（1個）を写します')), third.lines.join('\n'));
    assert.deepEqual(fs.readFileSync(path.join(modelCache, 'fake-det.onnx')), model);

    // 既定に戻すと 1.4.0 に入れ替える
    const fourth = await captureLogs(() => resolveNdlocrLite({}));
    assert.ok(fourth.lines.some(line => line.includes('1.4.0（GitHub）に入れ替えます')), fourth.lines.join('\n'));
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'ndlocr-lite==1.4.0');

    // 前の版の印（GitHub 版の requirements）も入れ替えの対象
    fs.writeFileSync(marker, `requirements-sha256:${'0'.repeat(64)}`, 'utf-8');
    const fifth = await captureLogs(() => resolveNdlocrLite({}));
    assert.ok(fifth.lines.some(line => line.includes('入れ替えます')), fifth.lines.join('\n'));
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'ndlocr-lite==1.4.0');
});

test('ndlocr-lite venv is reinstalled when the configured repo requirements.txt changes', async (t) => {
    const root = makeTempRoot(t);
    setEnv(t, { MIMI_TOOLS_DIR: path.join(root, 'tools'), MIMI_TOOLS_IGNORE_SYSTEM_PYTHON: undefined });
    if (skipWithoutPython(t)) return;

    // 依存は空（コメントだけ）。pip はネットワークに出ない。
    const repo = makeFakeRepo(root, '2.0.0', '# none\n');
    const resolved = await resolveNdlocrLite({ repoPath: repo, pythonPath: '' });
    assert.equal(resolved.kind, 'repo');
    assert.equal(resolved.repoPath, repo);
    const marker = path.join(process.env.MIMI_TOOLS_DIR, 'ndlocr-lite-venv', '.mimi-installed');
    const first = fs.readFileSync(marker, 'utf-8');
    assert.match(first, /^requirements-sha256:[0-9a-f]{64}$/);

    // 同じ依存なら入れ直さない（印はそのまま）
    await resolveNdlocrLite({ repoPath: repo, pythonPath: '' });
    assert.equal(fs.readFileSync(marker, 'utf-8'), first);

    // 依存が変われば入れ直して、印が新しい sha256 になる
    fs.writeFileSync(path.join(repo, 'requirements.txt'), '# none\n# changed\n');
    await resolveNdlocrLite({ repoPath: repo, pythonPath: '' });
    const second = fs.readFileSync(marker, 'utf-8');
    assert.match(second, /^requirements-sha256:[0-9a-f]{64}$/);
    assert.notEqual(second, first);

    // 前の版の印（日時だけ）は入れ直しの対象
    fs.writeFileSync(marker, '2026-07-06T12:46:46.068Z', 'utf-8');
    await resolveNdlocrLite({ repoPath: repo, pythonPath: '' });
    assert.equal(fs.readFileSync(marker, 'utf-8'), second);
});
