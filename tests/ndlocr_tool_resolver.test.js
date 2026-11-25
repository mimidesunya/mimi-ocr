const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveNdlocrLite } = require('../dist/src/lib/tool_resolver.js');

function makeFakeRepo(root, version, requirements) {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'ocr.py'), 'print("fake")\n');
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), `[project]\nname = "ndlocr-lite"\nversion = "${version}"\n`);
    fs.writeFileSync(path.join(repo, 'requirements.txt'), requirements);
    return repo;
}

test('ndlocr-lite venv is reinstalled when requirements.txt changes', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ndlocr-'));
    const savedToolsDir = process.env.MIMI_TOOLS_DIR;
    process.env.MIMI_TOOLS_DIR = path.join(root, 'tools');
    t.after(() => {
        if (savedToolsDir === undefined) delete process.env.MIMI_TOOLS_DIR;
        else process.env.MIMI_TOOLS_DIR = savedToolsDir;
        fs.rmSync(root, { recursive: true, force: true });
    });

    // 依存は空（コメントだけ）。pip はネットワークに出ない。
    const repo = makeFakeRepo(root, '2.0.0', '# none\n');
    let resolved;
    try {
        resolved = await resolveNdlocrLite({ repoPath: repo, pythonPath: '' });
    } catch (err) {
        if (/Python 3\.11 以上 が見つかりません/.test(err.message)) {
            t.skip('Python 3.11 以上が無い');
            return;
        }
        throw err;
    }
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

test('a configured ndlocr-lite is used as is, even when it is older than 2.0.0', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ndlocr-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeFakeRepo(root, '1.4.0', '# none\n');
    const python = process.execPath; // 起動できる実行ファイルなら何でもよい（pythonPath を指定すると venv を作らない）
    const resolved = await resolveNdlocrLite({ repoPath: repo, pythonPath: python });
    assert.deepEqual(resolved, { repoPath: repo, pythonPath: python });
    assert.ok(fs.existsSync(path.join(repo, 'src', 'ocr.py')));
});
