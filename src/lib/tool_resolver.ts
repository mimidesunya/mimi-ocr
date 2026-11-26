const AdmZip = require('adm-zip');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getProjectRoot, loadConfig } = require('./gemini_client');

const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const FFMPEG_SHA_URL = `${FFMPEG_ZIP_URL}.sha256`;
// 設定で指定された ndlocr-lite がこれより古ければ知らせる（1.4.0 から pip で入れられる形になり、--sourcepdf・--pdf-output・--json-only がそろった）。
const NDLOCR_MIN_VERSION = [1, 4, 0];
// ndlocr-lite 1.4.0・2.0.0 の CLI は Python 3.11 以上（pyproject の requires-python）。
const NDLOCR_MIN_PYTHON = [3, 11];
// 入れる ndlocr-lite の系統（設定 tools.ndlocrLite.version）。入っている版がその範囲を外れたら入れ直す。
// 既定は 1.4.0。2026-11-26 に裁判書類（準備書面・証拠説明書・判決、スキャン相当と FAX 相当の27頁）を
// ndlocr だけで読ませた比較で、2.0.0 は横組みの表の狭い欄を崩してもっともらしい誤った数字を出し、
// FAX の画質で日付を落とした（欠落 1.4.0 5.03% / 2.0.0 6.51%）。縦組みの本文は同じくらいで、
// 頁に入った写真を FAX の画質で読むと 1.4.0 は意味のない字の列を出す（2.0.0 は出さない）。
// PyPI には 2.x しかないので、1.4.0 は GitHub のタグの zip から入れる（git は要らない）。
// MIMI_NDLOCR_LITE_1_4_URL で入れ先を差し替えられる（試験・ミラー用。pip が受け付ける URL かファイルの URL）。
const NDLOCR_LITE_1_4_URL = 'https://github.com/ndl-lab/ndlocr-lite/archive/refs/tags/1.4.0.zip';
const NDLOCR_LINES = {
    '1.4': {
        label: '1.4.0',
        from: 'GitHub',
        min: [1, 4, 0],
        below: [1, 5, 0],
        spec: () => `ndlocr-lite @ ${String(process.env.MIMI_NDLOCR_LITE_1_4_URL || '').trim() || NDLOCR_LITE_1_4_URL}`,
    },
    '2': {
        label: '2.x',
        from: 'PyPI',
        min: [2, 0, 0],
        below: [3, 0, 0],
        spec: () => 'ndlocr-lite>=2.0,<3',
    },
};
const NDLOCR_DEFAULT_LINE = '1.4';

// 設定の版（"1.4.0"・"1.4"・"2"・"2.0.0"・"pypi" など）を系統の鍵にする。分からなければ既定。
function normalizeNdlocrLine(value) {
    const text = String(value ?? '').trim().toLowerCase().replace(/^v/, '');
    if (text === '2' || text.startsWith('2.') || text === 'pypi') return '2';
    return NDLOCR_DEFAULT_LINE;
}
// ndlocr-lite の依存（onnxruntime、OpenCV、numpy など）の取得量と、入れた venv の大きさ（2.0.0、Windows x64 で実測 95MB・354MB）。
const NDLOCR_PIP_DOWNLOAD_APPROX_MB = 100;
const NDLOCR_VENV_APPROX_MB = 350;
// pip 版が初回に取る文字認識モデル1つの大きさ（1.4.0・2.0.0 とも4つで約157MB）。
const NDLOCR_MODEL_APPROX_MB = 40;
// Python 3.11 以上が無い PC では、uv（astral-sh/uv の単体の実行ファイル）で外部ツール保存先へ Python を入れる。
const UV_VERSION = '0.13.8';
const UV_PYTHON_VERSION = '3.12';
// sha256 は配布元（GitHub release の *.sha256）の値。
const UV_RELEASE_ASSETS = {
    'win32-x64': { asset: 'uv-x86_64-pc-windows-msvc.zip', sha256: '529e78a9cec6cd7e3e014f7ecd8bda0c113969d4ed0f2efeedb85c30943325b8' },
    'win32-arm64': { asset: 'uv-aarch64-pc-windows-msvc.zip', sha256: '59e6d919bed1f72035e622a7c930058f08a8931c4c78ceaf9f56e7fb74dd2c48' },
    'darwin-arm64': { asset: 'uv-aarch64-apple-darwin.tar.gz', sha256: '6b71028a6b904f2ae3340ef52e595512de807d06c0a20eaef2f692581b246558' },
    'darwin-x64': { asset: 'uv-x86_64-apple-darwin.tar.gz', sha256: 'a04c2ffeac28b2003a2c13caf538ab425fcd7def3e4a41571f4a8fb370a66af3' },
};
const REAZON_K2_PACKAGE_SPEC = 'git+https://github.com/reazon-research/ReazonSpeech.git#subdirectory=pkg/k2-asr';
const VIBEASR_CPP_REPOSITORY = 'https://github.com/microsoft/VibeASR.cpp.git';
const VIBEASR_CPP_REVISION = '5cbce71c65911a7e10639ac13b6ab6929e4c8f9e';
const VIBEASR_DEFAULT_MODEL_ID = 'microsoft/VibeVoice-ASR-BitNet';
const VIBEASR_VAE_FILENAME = 'vibeasr-vae-encoder-i8_s.gguf';
const VIBEASR_LM_FILENAME = 'vibeasr-lm-i2_s-embed-q6_k.gguf';

function getToolsRoot() {
    const envDir = String(process.env.MIMI_TOOLS_DIR || '').trim();
    if (envDir) return path.resolve(envDir);

    try {
        const configuredDir = String(loadConfig()?.tools?.rootDir || '').trim();
        if (configuredDir) return path.resolve(configuredDir);
    } catch (_err) {
    }

    if (process.env.MIMI_OCR_RELEASE === '1' && process.env.MIMI_OCR_CONFIG_DIR) {
        return path.resolve(process.env.MIMI_OCR_CONFIG_DIR, 'tools');
    }

    return path.resolve(path.join(getProjectRoot(), '.mimi-tools'));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function isExecutableFile(filePath) {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_err) {
        return false;
    }
}

function pathCandidates(commandName) {
    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform === 'win32') {
        const windowsDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        for (const dir of [windowsDir, path.join(windowsDir, 'System32')]) {
            if (dir && !pathDirs.some(existing => existing.toLowerCase() === dir.toLowerCase())) {
                pathDirs.push(dir);
            }
        }
    }
    if (process.platform === 'darwin') {
        for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
            if (!pathDirs.includes(dir)) pathDirs.push(dir);
        }
    }
    const extensions = process.platform === 'win32'
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    const hasExt = path.extname(commandName) !== '';
    const names = process.platform === 'win32' && !hasExt
        ? extensions.map(ext => `${commandName}${ext.toLowerCase()}`).concat(extensions.map(ext => `${commandName}${ext.toUpperCase()}`))
        : [commandName];

    const out = [];
    for (const dir of pathDirs) {
        for (const name of names) out.push(path.join(dir, name));
    }
    return out;
}

function findOnPath(commandName) {
    for (const candidate of pathCandidates(commandName)) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

function requestStream(url, redirectCount = 0): Promise<any> {
    if (redirectCount > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'mimi-ocr-tool-resolver',
                'Accept': '*/*',
            },
        }, (res) => {
            const status = res.statusCode || 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location) {
                res.resume();
                const nextUrl = new URL(location, url).toString();
                requestStream(nextUrl, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (status < 200 || status >= 300) {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`)));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
    });
}

async function downloadFile(url, destPath) {
    ensureDir(path.dirname(destPath));
    const stream = await requestStream(url);
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        stream.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
        stream.on('error', reject);
    });
}

async function downloadText(url) {
    const stream = await requestStream(url);
    return await new Promise((resolve, reject) => {
        let text = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => { text += chunk; });
        stream.on('end', () => resolve(text));
        stream.on('error', reject);
    });
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest('hex');
}

async function verifySha256IfAvailable(filePath, shaUrl) {
    let text = '';
    try {
        text = String(await downloadText(shaUrl));
    } catch (err) {
        console.warn(`[tools] SHA256を取得できなかったため検証をスキップします: ${err.message}`);
        return;
    }

    const expected = (text.match(/[a-fA-F0-9]{64}/) || [])[0];
    if (!expected) {
        console.warn('[tools] SHA256ファイルの形式を読めなかったため検証をスキップします');
        return;
    }

    verifySha256(filePath, expected);
}

function verifySha256(filePath, expected) {
    const actual = sha256File(filePath);
    if (actual.toLowerCase() !== String(expected).toLowerCase()) {
        throw new Error(`SHA256が一致しません: expected=${expected} actual=${actual}`);
    }
}

function writeZipEntry(zip, entry, destPath) {
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, entry.getData());
}

function ensureWindowsFfmpegFromZip(zipPath, targetBinDir) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const ffmpegEntry = entries.find(entry => /\/bin\/ffmpeg\.exe$/i.test(entry.entryName.replace(/\\/g, '/')));
    const ffprobeEntry = entries.find(entry => /\/bin\/ffprobe\.exe$/i.test(entry.entryName.replace(/\\/g, '/')));

    if (!ffmpegEntry || !ffprobeEntry) {
        throw new Error('ffmpeg.exe または ffprobe.exe がzip内に見つかりませんでした');
    }

    ensureDir(targetBinDir);
    writeZipEntry(zip, ffmpegEntry, path.join(targetBinDir, 'ffmpeg.exe'));
    writeZipEntry(zip, ffprobeEntry, path.join(targetBinDir, 'ffprobe.exe'));

    const licenseEntry = entries.find(entry => /\/LICENSE\.txt$/i.test(entry.entryName.replace(/\\/g, '/')));
    if (licenseEntry) writeZipEntry(zip, licenseEntry, path.join(path.dirname(targetBinDir), 'LICENSE.txt'));
    const readmeEntry = entries.find(entry => /\/README\.txt$/i.test(entry.entryName.replace(/\\/g, '/')));
    if (readmeEntry) writeZipEntry(zip, readmeEntry, path.join(path.dirname(targetBinDir), 'README.txt'));
}

async function ensureWindowsFfmpeg() {
    const ffmpegDir = path.join(getToolsRoot(), 'ffmpeg');
    const binDir = path.join(ffmpegDir, 'bin');
    const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
    const ffprobePath = path.join(binDir, 'ffprobe.exe');

    if (isExecutableFile(ffmpegPath) && isExecutableFile(ffprobePath)) {
        return { ffmpegPath, ffprobePath };
    }

    const downloadsDir = path.join(getToolsRoot(), 'downloads');
    const zipPath = path.join(downloadsDir, 'ffmpeg-release-essentials.zip');
    ensureDir(downloadsDir);

    console.log('[tools] ffmpegを自動取得します。初回だけ時間がかかります。');
    await downloadFile(FFMPEG_ZIP_URL, zipPath);
    await verifySha256IfAvailable(zipPath, FFMPEG_SHA_URL);

    const stagingDir = `${ffmpegDir}.staging-${process.pid}-${Date.now()}`;
    try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        ensureWindowsFfmpegFromZip(zipPath, path.join(stagingDir, 'bin'));
        fs.rmSync(ffmpegDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, ffmpegDir);
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    console.log(`[tools] ffmpegを準備しました: ${ffmpegPath}`);
    return { ffmpegPath, ffprobePath };
}

async function resolveFfmpegTools(settings: any = {}) {
    const configuredFfmpeg = String(settings.ffmpegPath || '').trim();
    const configuredFfprobe = String(settings.ffprobePath || '').trim();

    if (configuredFfmpeg && isExecutableFile(configuredFfmpeg)) {
        const inferredProbe = configuredFfprobe || path.join(path.dirname(configuredFfmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        return {
            ffmpegPath: configuredFfmpeg,
            ffprobePath: isExecutableFile(inferredProbe) ? inferredProbe : (configuredFfprobe || 'ffprobe'),
        };
    }

    if (process.env.FFMPEG_PATH && isExecutableFile(process.env.FFMPEG_PATH)) {
        const probe = process.env.FFPROBE_PATH || path.join(path.dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        return {
            ffmpegPath: process.env.FFMPEG_PATH,
            ffprobePath: isExecutableFile(probe) ? probe : (process.env.FFPROBE_PATH || 'ffprobe'),
        };
    }

    const pathFfmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const pathFfprobe = findOnPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (pathFfmpeg) {
        return {
            ffmpegPath: pathFfmpeg,
            ffprobePath: pathFfprobe || 'ffprobe',
        };
    }

    if (process.platform === 'win32') {
        return await ensureWindowsFfmpeg();
    }

    if (process.platform === 'darwin') {
        throw new Error('ffmpeg が見つかりません。Mac では Homebrew などで ffmpeg をインストールしてください: brew install ffmpeg');
    }

    throw new Error('ffmpeg が見つかりません。PATH 上に ffmpeg と ffprobe をインストールしてください。');
}

function getVenvPythonPath(venvDir) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

// venv に pip で入れたコマンド（Windows は Scripts/<name>.exe、mac / Linux は bin/<name>）。
function getVenvScriptPath(venvDir, name) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', `${name}.exe`)
        : path.join(venvDir, 'bin', name);
}

function readTextIfExists(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch (_err) {
        return '';
    }
}

function formatElapsed(ms) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function runChecked(command, args, cwd, env = undefined) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} exited with code ${result.status}`);
    }
}

function probePythonCommand(command, argsPrefix = []) {
    ensureDir(getToolsRoot());
    const result = spawnSync(command, [...argsPrefix, '--version'], {
        cwd: getToolsRoot(),
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
    });
    return !result.error && result.status === 0;
}

function parseVersionNumbers(text) {
    const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function compareVersionNumbers(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// 起動できなければ null。起動できれば [major, minor, patch]。
function getPythonVersion(command, argsPrefix = []) {
    ensureDir(getToolsRoot());
    const result = spawnSync(command, [...argsPrefix, '--version'], {
        cwd: getToolsRoot(),
        encoding: 'utf-8',
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) return null;
    return parseVersionNumbers(`${result.stdout || ''} ${result.stderr || ''}`.replace(/^\D*/, ''));
}

// pyproject.toml の [project] の version。読めなければ null。
function readNdlocrVersion(repoPath) {
    try {
        const text = fs.readFileSync(path.join(repoPath, 'pyproject.toml'), 'utf-8');
        const match = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
        return match ? parseVersionNumbers(match[1]) : null;
    } catch (_err) {
        return null;
    }
}

function isNdlocrOlderThanMinimum(repoPath) {
    const version = readNdlocrVersion(repoPath);
    return !version || compareVersionNumbers(version, NDLOCR_MIN_VERSION) < 0;
}

function fileSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getWindowsPythonInstallCandidates() {
    if (process.platform !== 'win32') return [];
    const roots = [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
        process.env.ProgramFiles || '',
        process.env['ProgramFiles(x86)'] || '',
    ].filter(Boolean);

    const candidates = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/^Python\d+/i.test(entry.name)) continue;
                const pythonPath = path.join(root, entry.name, 'python.exe');
                if (isExecutableFile(pythonPath)) candidates.push(pythonPath);
            }
        } catch (_err) {
        }
    }

    return candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
}

function isPythonNewEnough(version, minVersion) {
    return !minVersion || (!!version && compareVersionNumbers(version, minVersion) >= 0);
}

// PC に入っている Python を探す。minVersion を渡すと、それより古い Python は選ばない（[3, 11] など）。
// 見つからなければ null。MIMI_TOOLS_IGNORE_SYSTEM_PYTHON=1 なら探さない（uv の経路を試すため）。
function findSystemPython(minVersion = null) {
    if (process.env.MIMI_TOOLS_IGNORE_SYSTEM_PYTHON === '1') return null;
    ensureDir(getToolsRoot());
    const candidates = [];
    if (process.platform === 'win32') {
        for (const pythonPath of getWindowsPythonInstallCandidates()) {
            candidates.push({ command: pythonPath, argsPrefix: [] });
        }
        const pyLauncher = findOnPath('py.exe') || findOnPath('py');
        if (pyLauncher) candidates.push({ command: pyLauncher, argsPrefix: ['-3'] });
        candidates.push({ command: 'py', argsPrefix: ['-3'] });
    }
    candidates.push({ command: process.platform === 'win32' ? 'python' : 'python3', argsPrefix: [] });
    candidates.push({ command: 'python3', argsPrefix: [] });
    candidates.push({ command: 'python', argsPrefix: [] });

    for (const candidate of candidates) {
        if (isPythonNewEnough(getPythonVersion(candidate.command, candidate.argsPrefix), minVersion)) {
            return candidate;
        }
    }
    return null;
}

// 設定された Python か、PC に入っている Python。見つからなければ投げる。
function resolveBasePythonCommand(configuredPython = '', minVersion = null) {
    ensureDir(getToolsRoot());
    const configured = String(configuredPython || '').trim();
    if (configured) {
        const version = getPythonVersion(configured);
        if (!version) {
            throw new Error(`設定されたPythonを起動できません: ${configured}`);
        }
        if (!isPythonNewEnough(version, minVersion)) {
            throw new Error(`設定されたPythonは ${version.join('.')} です。Python ${minVersion.join('.')} 以上を指定してください: ${configured}`);
        }
        return { command: configured, argsPrefix: [] };
    }

    const found = findSystemPython(minVersion);
    if (found) return found;

    const required = minVersion ? `Python ${minVersion.join('.')} 以上` : 'Python 3';
    throw new Error(`${required} が見つかりません。Windowsでは https://www.python.org/downloads/windows/ から Python をインストールするか、設定に Python のパスを指定してください。`);
}

function getUvRelease(platform = process.platform, arch = process.arch) {
    const entry = UV_RELEASE_ASSETS[`${platform}-${arch}`];
    if (!entry) return null;
    return {
        version: UV_VERSION,
        asset: entry.asset,
        sha256: entry.sha256,
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${entry.asset}`,
        exeName: platform === 'win32' ? 'uv.exe' : 'uv',
    };
}

function findFileNamed(dir, name, depth = 2) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return fullPath;
        if (entry.isDirectory() && depth > 0) {
            const found = findFileNamed(fullPath, name, depth - 1);
            if (found) return found;
        }
    }
    return null;
}

// 配布物から uv の実行ファイルだけを destDir に出す。Windows は zip の直下、macOS は tar.gz の uv-<target>/uv。
function extractUvExecutable(archivePath, destDir, exeName) {
    const destPath = path.join(destDir, exeName);
    if (/\.zip$/i.test(archivePath)) {
        const zip = new AdmZip(archivePath);
        const entry = zip.getEntries().find(e => !e.isDirectory && path.posix.basename(e.entryName.replace(/\\/g, '/')) === exeName);
        if (!entry) throw new Error(`${exeName} がzip内に見つかりませんでした`);
        writeZipEntry(zip, entry, destPath);
    } else {
        const unpackDir = path.join(destDir, 'unpack');
        ensureDir(unpackDir);
        runChecked('tar', ['-xzf', archivePath, '-C', unpackDir], destDir);
        const found = findFileNamed(unpackDir, exeName);
        if (!found) throw new Error(`${exeName} が配布物の中に見つかりませんでした`);
        fs.copyFileSync(found, destPath);
        fs.rmSync(unpackDir, { recursive: true, force: true });
    }
    fs.chmodSync(destPath, 0o755);
}

// 版を固定した uv を外部ツール保存先の uv/ に用意する（ffmpeg と同じく downloads/ に落とし、sha256 を確かめて置き換える）。
async function ensureUv() {
    const release = getUvRelease();
    if (!release) {
        const onPath = findOnPath('uv');
        if (onPath) return onPath;
        throw new Error(`Python ${NDLOCR_MIN_PYTHON.join('.')} 以上が見つかりません。Python ${NDLOCR_MIN_PYTHON.join('.')} 以上を入れるか、uv を入れてください（curl -LsSf https://astral.sh/uv/install.sh | sh）。config.json の tools.ndlocrLite.pythonPath に Python のパスを指定することもできます。`);
    }

    const toolsRoot = getToolsRoot();
    const uvDir = path.join(toolsRoot, 'uv');
    const uvPath = path.join(uvDir, release.exeName);
    if (isExecutableFile(uvPath) && readTextIfExists(path.join(uvDir, '.mimi-version')) === release.version) {
        return uvPath;
    }

    const downloadsDir = path.join(toolsRoot, 'downloads');
    const archivePath = path.join(downloadsDir, release.asset);
    ensureDir(downloadsDir);
    console.log(`[tools] uv ${release.version} を取得します（約16MB）。`);
    await downloadFile(release.url, archivePath);
    verifySha256(archivePath, release.sha256);

    const stagingDir = `${uvDir}.staging-${process.pid}-${Date.now()}`;
    try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        ensureDir(stagingDir);
        extractUvExecutable(archivePath, stagingDir, release.exeName);
        fs.writeFileSync(path.join(stagingDir, '.mimi-version'), release.version, 'utf-8');
        fs.rmSync(uvDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, uvDir);
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    fs.rmSync(archivePath, { force: true });
    console.log(`[tools] uvを準備しました: ${uvPath}`);
    return uvPath;
}

// uv が入れる Python と uv のキャッシュは外部ツール保存先に置く。PATH や Windows のレジストリには登録しない。
function getUvEnv(toolsRoot) {
    return {
        ...process.env,
        UV_PYTHON_INSTALL_DIR: path.join(toolsRoot, 'uv-python'),
        UV_CACHE_DIR: path.join(toolsRoot, 'uv-cache'),
        UV_PYTHON_PREFERENCE: 'only-managed',
    };
}

async function createVenvWithUv(venvDir) {
    const toolsRoot = getToolsRoot();
    const uv = await ensureUv();
    const env = getUvEnv(toolsRoot);
    console.log(`[tools] Python ${NDLOCR_MIN_PYTHON.join('.')} 以上が見つからないので、uv で Python ${UV_PYTHON_VERSION} を外部ツール保存先へ入れます（PC の設定は変えません）: ${env.UV_PYTHON_INSTALL_DIR}`);
    const installArgs = ['python', 'install', '--no-bin'];
    if (process.platform === 'win32') installArgs.push('--no-registry');
    runChecked(uv, [...installArgs, UV_PYTHON_VERSION], toolsRoot, env);
    // --seed で pip も入れる（あとは PC の Python で作った venv と同じに扱う）。
    runChecked(uv, ['venv', '--seed', '--python', UV_PYTHON_VERSION, venvDir], toolsRoot, env);
}

// ndlocr-lite 用 venv を作る元。設定の Python → PC の Python 3.11 以上 → uv で入れる Python の順。
function chooseNdlocrVenvBase(configuredBasePython = '') {
    const configured = String(configuredBasePython || '').trim();
    if (configured) return { kind: 'python', ...resolveBasePythonCommand(configured, NDLOCR_MIN_PYTHON) };
    const found = findSystemPython(NDLOCR_MIN_PYTHON);
    return found ? { kind: 'python', ...found } : { kind: 'uv' };
}

// ndlocr-lite 用 venv の Python。起動できない、または 3.11 より古ければ作り直す。
async function ensureNdlocrVenvPython(venvDir, configuredBasePython = '') {
    const venvPython = getVenvPythonPath(venvDir);
    if (isExecutableFile(venvPython)) {
        const version = getPythonVersion(venvPython);
        if (!version) {
            console.warn('[tools] ndlocr-lite用のPython環境を起動できないため作り直します。');
            fs.rmSync(venvDir, { recursive: true, force: true });
        } else if (compareVersionNumbers(version, NDLOCR_MIN_PYTHON) < 0) {
            console.warn(`[tools] ndlocr-lite用のPython環境が Python ${version.join('.')} なので、${NDLOCR_MIN_PYTHON.join('.')} 以上で作り直します。`);
            fs.rmSync(venvDir, { recursive: true, force: true });
        } else {
            return venvPython;
        }
    }

    // 作りかけの残りがあれば消してから作る
    fs.rmSync(venvDir, { recursive: true, force: true });
    const base = chooseNdlocrVenvBase(configuredBasePython);
    if (base.kind === 'python') {
        console.log('[tools] ndlocr-lite用のPython環境を作ります。');
        runChecked(base.command, [...base.argsPrefix, '-m', 'venv', venvDir], getToolsRoot());
    } else {
        await createVenvWithUv(venvDir);
    }
    if (!isExecutableFile(venvPython)) {
        throw new Error(`ndlocr-lite用のPython環境を作れませんでした: ${venvDir}`);
    }
    return venvPython;
}

// 自分で clone した ndlocr-lite（設定の repoPath）用。requirements.txt の sha256 を印にし、変わったら入れ直す。
async function ensureNdlocrRepoVenv(repoPath) {
    const venvDir = path.join(getToolsRoot(), 'ndlocr-lite-venv');
    const markerPath = path.join(venvDir, '.mimi-installed');
    const venvPython = await ensureNdlocrVenvPython(venvDir);

    const requirementsPath = path.join(repoPath, 'requirements.txt');
    const stamp = fs.existsSync(requirementsPath) ? `requirements-sha256:${fileSha256(requirementsPath)}` : 'no-requirements';
    const installed = readTextIfExists(markerPath);
    if (installed !== stamp) {
        if (fs.existsSync(requirementsPath)) {
            console.log(installed
                ? '[tools] ndlocr-liteの依存パッケージが変わったので入れ直します。'
                : '[tools] ndlocr-liteのPython依存パッケージを入れます。初回だけ時間がかかります。');
            runChecked(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], repoPath);
        }
        fs.writeFileSync(markerPath, stamp, 'utf-8');
    }

    return venvPython;
}

// 印に書いた pip 版の版（"ndlocr-lite==1.4.0"・"ndlocr-lite==2.0.0"）。前の版の印（requirements の sha256、日時）なら null。
function readNdlocrPipMarker(markerPath) {
    const match = readTextIfExists(markerPath).match(/^ndlocr-lite==(\S+)$/);
    return match ? parseVersionNumbers(match[1]) : null;
}

function isNdlocrPipVersionInRange(version, lineKey = NDLOCR_DEFAULT_LINE) {
    const line = NDLOCR_LINES[lineKey] || NDLOCR_LINES[NDLOCR_DEFAULT_LINE];
    return !!version
        && compareVersionNumbers(version, line.min) >= 0
        && compareVersionNumbers(version, line.below) < 0;
}

function readInstalledNdlocrVersion(venvPython) {
    const result = spawnSync(venvPython, ['-I', '-c', 'from importlib.metadata import version; print(version("ndlocr-lite"))'], {
        cwd: getToolsRoot(),
        encoding: 'utf-8',
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) return '';
    return String(result.stdout || '').trim();
}

// pip 版のモデル（model_download.MODELS）を OS のキャッシュ（Windows は %LOCALAPPDATA%\ndlocr-lite\models の下）へ先に取る。1.4.0 も 2.x も同じ作り。
// 前の版で GitHub から取った ndlocr-lite の src/model に同じモデルがあれば、取らずに写す。
// 出力は最後の行の JSON: {"cache": 保存先, "missing": [{"name", "seed": 写せるか}]}（"fetch" では取る前の状態）。
const NDLOCR_MODEL_SCRIPT = [
    'import hashlib, json, pathlib, shutil, sys',
    'import model_download as m',
    'def sha256(p):',
    '    h = hashlib.sha256()',
    '    with p.open("rb") as f:',
    '        for chunk in iter(lambda: f.read(1 << 20), b""):',
    '            h.update(chunk)',
    '    return h.hexdigest()',
    'action, seed = sys.argv[1], pathlib.Path(sys.argv[2])',
    'cache = m.model_cache_dir()',
    'missing = []',
    'for name, expected in m.MODELS.values():',
    '    dest = cache / name',
    '    if dest.is_file() and sha256(dest) == expected:',
    '        continue',
    '    src = seed / name',
    '    use_seed = src.is_file() and sha256(src) == expected',
    '    missing.append({"name": name, "seed": use_seed})',
    '    if action != "fetch":',
    '        continue',
    '    if use_seed:',
    '        cache.mkdir(parents=True, exist_ok=True)',
    '        part = cache / (name + ".mimi-part")',
    '        shutil.copyfile(src, part)',
    '        part.replace(dest)',
    '    else:',
    '        m.get_model_path(name, expected, cache / "__no_bundled_models__")',
    'print(json.dumps({"cache": str(cache), "missing": missing}))',
].join('\n');

function runNdlocrModelScript(venvPython, action, seedDir) {
    const result = spawnSync(venvPython, ['-I', '-c', NDLOCR_MODEL_SCRIPT, action, seedDir], {
        cwd: getToolsRoot(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) return null;
    const lines = String(result.stdout || '').trim().split(/\r?\n/);
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch (_err) {
        return null;
    }
}

// 並行して起動する読み取りがそれぞれモデルを取りにいかないよう、入れた直後に一度だけ取る。
// 失敗しても止めない（最初の読み取りのときに ndlocr-lite が自分で取る）。
function prefetchNdlocrModels(venvPython, seedDir) {
    const probe = runNdlocrModelScript(venvPython, 'probe', seedDir);
    if (!probe) {
        console.warn('[tools] ndlocr-liteのモデルの保存先を調べられませんでした。最初の読み取りのときに ndlocr-lite が取得します。');
        return;
    }
    const missing = Array.isArray(probe.missing) ? probe.missing : [];
    if (missing.length === 0) return;

    const downloads = missing.filter(item => !item.seed).length;
    if (downloads > 0) {
        console.log(`[tools] ndlocr-liteの文字認識モデル（${downloads}個、約${downloads * NDLOCR_MODEL_APPROX_MB}MB）を取得します。初回だけ時間がかかります。保存先: ${probe.cache}`);
    }
    if (missing.length > downloads) {
        console.log(`[tools] 前に取った ndlocr-lite のモデル（${missing.length - downloads}個）を写します: ${seedDir} → ${probe.cache}`);
    }
    const started = Date.now();
    if (runNdlocrModelScript(venvPython, 'fetch', seedDir)) {
        console.log(`[tools] ndlocr-liteのモデルを準備しました（${formatElapsed(Date.now() - started)}）。`);
    } else {
        console.warn('[tools] ndlocr-liteのモデルを取得できませんでした。最初の読み取りのときに ndlocr-lite がもう一度取得します。');
    }
}

// ndlocr-lite（設定の系統。既定は GitHub の 1.4.0、"2" なら PyPI の 2.x）を外部ツール保存先の ndlocr-lite-venv に pip で入れる。
// 前の版で GitHub 版の依存を入れた venv はそのまま使い、ndlocr-lite だけを足す（依存は取り直さない）。系統を替えれば入れ替える。
async function ensureNdlocrPip(configuredBasePython = '', lineKey = NDLOCR_DEFAULT_LINE) {
    const line = NDLOCR_LINES[lineKey] || NDLOCR_LINES[NDLOCR_DEFAULT_LINE];
    const spec = line.spec();
    const toolsRoot = getToolsRoot();
    const venvDir = path.join(toolsRoot, 'ndlocr-lite-venv');
    const markerPath = path.join(venvDir, '.mimi-installed');
    const venvPython = await ensureNdlocrVenvPython(venvDir, configuredBasePython);
    const command = getVenvScriptPath(venvDir, 'ndlocr-lite');

    if (isNdlocrPipVersionInRange(readNdlocrPipMarker(markerPath), lineKey) && isExecutableFile(command)) {
        return { venvPython, command };
    }

    console.log(fs.existsSync(markerPath)
        ? `[tools] ndlocr-liteを ${line.label}（${line.from}）に入れ替えます。入っている依存パッケージはそのまま使います: ${spec}`
        : `[tools] ndlocr-lite ${line.label} を ${line.from} から入れます。初回だけ、依存パッケージを約${NDLOCR_PIP_DOWNLOAD_APPROX_MB}MB取り（入れると約${NDLOCR_VENV_APPROX_MB}MB）、数分かかります: ${venvDir}`);
    const started = Date.now();
    runChecked(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', spec], toolsRoot);
    const installed = readInstalledNdlocrVersion(venvPython);
    if (!isNdlocrPipVersionInRange(parseVersionNumbers(installed), lineKey) || !isExecutableFile(command)) {
        throw new Error(`ndlocr-lite ${line.label} を入れられませんでした（入った版: ${installed || '不明'}）。上の pip の表示を確認してください。`);
    }
    fs.writeFileSync(markerPath, `ndlocr-lite==${installed}`, 'utf-8');
    console.log(`[tools] ndlocr-lite ${installed} を入れました（${formatElapsed(Date.now() - started)}）: ${command}`);

    const oldCopy = path.join(toolsRoot, 'ndlocr-lite');
    prefetchNdlocrModels(venvPython, path.join(oldCopy, 'src', 'model'));
    if (fs.existsSync(path.join(oldCopy, 'src', 'ocr.py'))) {
        console.log(`[tools] 前の版で GitHub から取った ndlocr-lite はもう使いません。要らなければ消してかまいません: ${oldCopy}`);
    }
    return { venvPython, command };
}

async function resolveNdlocrLiteUncached(settings: any = {}) {
    const configuredRepo = String(settings.repoPath || '').trim();
    const configuredPython = String(settings.pythonPath || '').trim();

    if (configuredRepo) {
        if (fs.existsSync(path.join(configuredRepo, 'src', 'ocr.py'))) {
            // 自分で clone した ndlocr-lite は従来どおり src/ocr.py で動かす。指定された場所は書き換えない。古ければ知らせるだけ。
            if (isNdlocrOlderThanMinimum(configuredRepo)) {
                console.warn(`[tools] 設定の ndlocr-lite が ${NDLOCR_MIN_VERSION.join('.')} より古いようです: ${configuredRepo}`);
            }
            const pythonPath = configuredPython || await ensureNdlocrRepoVenv(configuredRepo);
            return { kind: 'repo', repoPath: configuredRepo, pythonPath };
        }
        console.warn(`[tools] 設定の ndlocr-lite に src/ocr.py が無いので、pip で入れた版を使います: ${configuredRepo}`);
    }

    // repoPath なしの pythonPath は、venv を作る元の Python として使う。
    const { venvPython, command } = await ensureNdlocrPip(configuredPython, normalizeNdlocrLine(settings.version));
    return { kind: 'pip', command, pythonPath: venvPython };
}

// 並行して始まった読み取り（ai_ocr のジョブ）が同時に uv や ndlocr-lite を取りにいかないよう、準備中の約束を共有する。
const ndlocrInFlight = new Map();

/**
 * ndlocr-lite の起動の仕方を決める（必要なら入れる）。
 * - { kind: 'pip', command, pythonPath }: pip で venv に入れた版（既定は GitHub の 1.4.0、設定 version が "2" なら PyPI の 2.x）。command は venv の ndlocr-lite。
 * - { kind: 'repo', repoPath, pythonPath }: 設定の repoPath（自分で clone した版）。python src/ocr.py で動かす。
 */
function resolveNdlocrLite(settings: any = {}) {
    const key = JSON.stringify([getToolsRoot(), String(settings.repoPath || '').trim(), String(settings.pythonPath || '').trim(), normalizeNdlocrLine(settings.version)]);
    let pending = ndlocrInFlight.get(key);
    if (!pending) {
        pending = resolveNdlocrLiteUncached(settings).finally(() => ndlocrInFlight.delete(key));
        ndlocrInFlight.set(key, pending);
    }
    return pending;
}

function canImportReazonK2(pythonPath) {
    const result = spawnSync(pythonPath, ['-c', 'import reazonspeech.k2.asr; import sherpa_onnx'], {
        cwd: getToolsRoot(),
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
    });
    return !result.error && result.status === 0;
}

function ensureReazonK2Venv(settings: any = {}) {
    const configuredPython = String(settings.pythonPath || '').trim();
    if (configuredPython) {
        if (!probePythonCommand(configuredPython)) {
            throw new Error(`設定されたReazon K2用Pythonを起動できません: ${configuredPython}`);
        }
        if (!canImportReazonK2(configuredPython)) {
            throw new Error('設定されたPythonには reazonspeech.k2.asr または sherpa_onnx が入っていません。pip install sherpa-onnx sherpa-onnx-bin と reazonspeech-k2-asr を入れるか、tools.reazonK2.pythonPath を空にして自動準備を使ってください。');
        }
        return configuredPython;
    }

    const venvDir = path.join(getToolsRoot(), 'reazon-k2-venv');
    const venvPython = getVenvPythonPath(venvDir);
    const autoInstall = settings.autoInstall !== false;

    if (isExecutableFile(venvPython) && !probePythonCommand(venvPython)) {
        console.warn('[tools] ReazonSpeech K2用のPython環境を起動できないため作り直します。');
        fs.rmSync(venvDir, { recursive: true, force: true });
    }

    if (!isExecutableFile(venvPython)) {
        console.log('[tools] ReazonSpeech K2用のPython環境を作ります。');
        const python = resolveBasePythonCommand(String(settings.basePythonPath || ''));
        runChecked(python.command, [...python.argsPrefix, '-m', 'venv', venvDir], getToolsRoot());
    }

    if (!canImportReazonK2(venvPython)) {
        if (!autoInstall) {
            throw new Error('ReazonSpeech K2 のPythonパッケージが未準備です。tools.reazonK2.autoInstall を true にするか、tools.reazonK2.pythonPath に準備済みPythonを指定してください。');
        }
        const packageSpec = String(settings.packageSpec || REAZON_K2_PACKAGE_SPEC).trim();
        console.log('[tools] ReazonSpeech K2 / sherpa-onnx をPython環境へインストールします。初回だけ時間がかかります。');
        runChecked(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], getToolsRoot());
        runChecked(venvPython, ['-m', 'pip', 'install', 'sherpa-onnx', 'sherpa-onnx-bin'], getToolsRoot());
        runChecked(venvPython, ['-m', 'pip', 'install', packageSpec], getToolsRoot());
    }

    if (!canImportReazonK2(venvPython)) {
        throw new Error('ReazonSpeech K2 のPythonパッケージを読み込めませんでした。インストールログを確認してください。');
    }
    return venvPython;
}

async function resolveReazonK2(settings: any = {}) {
    ensureDir(getToolsRoot());
    const pythonPath = ensureReazonK2Venv(settings);
    const cacheDir = String(settings.cacheDir || '').trim()
        ? path.resolve(String(settings.cacheDir).trim())
        : path.join(getToolsRoot(), 'huggingface');
    ensureDir(cacheDir);
    return {
        pythonPath,
        cacheDir,
    };
}

function positiveInt(value, fallback, min = 1, max = 256) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function findVibeAsrBinary(sourceDir) {
    const filename = process.platform === 'win32' ? 'asr_stream_server.exe' : 'asr_stream_server';
    const candidates = [
        path.join(sourceDir, 'build', 'bin', filename),
        path.join(sourceDir, 'build', 'bin', 'Release', filename),
        path.join(sourceDir, 'build', 'Release', filename),
    ];
    return candidates.find(isExecutableFile) || candidates[0];
}

function requireTool(commandName, message) {
    const resolved = findOnPath(process.platform === 'win32' ? `${commandName}.exe` : commandName)
        || findOnPath(commandName);
    if (!resolved) throw new Error(message);
    return resolved;
}

function ensureVibeAsrSource(sourceDir) {
    const cmakeFile = path.join(sourceDir, 'CMakeLists.txt');
    if (fs.existsSync(cmakeFile)) return;
    if (fs.existsSync(sourceDir)) {
        throw new Error(`VibeASR.cpp の保存先が不完全です。削除して再実行するか tools.vibeVoiceAsr.sourceDir を変更してください: ${sourceDir}`);
    }

    const git = requireTool('git', 'VibeASR.cpp の自動準備には Git が必要です。Gitをインストールするか、tools.vibeVoiceAsr.binaryPath にビルド済み asr_stream_server を指定してください。');
    console.log('[tools] Microsoft VibeASR.cpp を取得します。');
    ensureDir(path.dirname(sourceDir));
    const stagingDir = `${sourceDir}.staging-${process.pid}`;
    try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        runChecked(git, ['clone', '--recurse-submodules', VIBEASR_CPP_REPOSITORY, stagingDir], path.dirname(sourceDir));
        runChecked(git, ['checkout', '--detach', VIBEASR_CPP_REVISION], stagingDir);
        runChecked(git, ['submodule', 'update', '--init', '--recursive'], stagingDir);
        if (!fs.existsSync(sourceDir)) fs.renameSync(stagingDir, sourceDir);
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
}

function buildVibeAsr(sourceDir, settings) {
    const cmake = requireTool('cmake', 'VibeASR.cpp のビルドには CMake 3.14 以上が必要です。CMakeをインストールするか、tools.vibeVoiceAsr.binaryPath にビルド済み asr_stream_server を指定してください。');
    const buildDir = path.join(sourceDir, 'build');
    const configureArgs = [
        '-S', sourceDir,
        '-B', buildDir,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DGGML_CCACHE=OFF',
    ];

    if (process.platform === 'win32') {
        const cCompiler = String(settings.cCompiler || '').trim() || requireTool('gcc', 'Windows版 VibeASR.cpp のビルドには MinGW-w64 GCC が必要です。');
        const cxxCompiler = String(settings.cxxCompiler || '').trim() || requireTool('g++', 'Windows版 VibeASR.cpp のビルドには MinGW-w64 G++ が必要です。');
        const makeProgram = String(settings.makePath || '').trim() || requireTool('mingw32-make', 'Windows版 VibeASR.cpp のビルドには mingw32-make が必要です。');
        configureArgs.push(
            '-G', 'MinGW Makefiles',
            `-DCMAKE_C_COMPILER=${cCompiler}`,
            `-DCMAKE_CXX_COMPILER=${cxxCompiler}`,
            `-DCMAKE_MAKE_PROGRAM=${makeProgram}`,
        );
    }

    console.log('[tools] VibeASR.cpp のCPU推論ランタイムをビルドします。');
    runChecked(cmake, configureArgs, sourceDir);
    const buildThreads = positiveInt(settings.buildThreads, Math.max(1, Math.min(os.cpus().length, 8)), 1, 64);
    runChecked(cmake, ['--build', buildDir, '--target', 'asr_stream_server', '--config', 'Release', '-j', String(buildThreads)], sourceDir);
}

async function downloadFileAtomic(url, destPath, label) {
    if (isExecutableFile(destPath)) return;
    ensureDir(path.dirname(destPath));
    const partialPath = `${destPath}.part-${process.pid}`;
    console.log(`[tools] ${label} を取得します（初回のみ、完了まで時間がかかります）。`);
    try {
        await downloadFile(url, partialPath);
        const size = fs.statSync(partialPath).size;
        if (size < 1024 * 1024) {
            throw new Error(`${label} のダウンロードサイズが不正です: ${size} bytes`);
        }
        if (isExecutableFile(destPath)) {
            fs.rmSync(partialPath, { force: true });
        } else {
            fs.renameSync(partialPath, destPath);
        }
    } finally {
        try { fs.rmSync(partialPath, { force: true }); } catch (_err) {}
    }
}

async function resolveVibeVoiceAsr(settings: any = {}) {
    const toolsRoot = getToolsRoot();
    ensureDir(toolsRoot);
    const sourceDir = String(settings.sourceDir || '').trim()
        ? path.resolve(String(settings.sourceDir).trim())
        : path.join(toolsRoot, 'vibeasr-cpp');
    const modelDir = String(settings.modelDir || '').trim()
        ? path.resolve(String(settings.modelDir).trim())
        : path.join(toolsRoot, 'vibeasr-models', 'vibeasr');
    const configuredBinary = String(settings.binaryPath || '').trim();
    const binaryPath = configuredBinary ? path.resolve(configuredBinary) : findVibeAsrBinary(sourceDir);
    const vaeModelPath = String(settings.vaeModelPath || '').trim()
        ? path.resolve(String(settings.vaeModelPath).trim())
        : path.join(modelDir, VIBEASR_VAE_FILENAME);
    const lmModelPath = String(settings.lmModelPath || '').trim()
        ? path.resolve(String(settings.lmModelPath).trim())
        : path.join(modelDir, VIBEASR_LM_FILENAME);
    const missing = [
        !isExecutableFile(binaryPath) ? `CPUランタイム: ${binaryPath}` : '',
        !isExecutableFile(vaeModelPath) ? `VAEモデル: ${vaeModelPath}` : '',
        !isExecutableFile(lmModelPath) ? `LMモデル: ${lmModelPath}` : '',
    ].filter(Boolean);

    if (missing.length > 0 && settings.autoInstall === false) {
        throw new Error(`VibeVoice ASR (CPU) が未準備です。${missing.join(' / ')}。tools.vibeVoiceAsr.autoInstall を true にするか各パスを設定してください。`);
    }

    if (!isExecutableFile(binaryPath)) {
        if (configuredBinary) throw new Error(`設定された VibeASR.cpp ランタイムが見つかりません: ${binaryPath}`);
        ensureVibeAsrSource(sourceDir);
        buildVibeAsr(sourceDir, settings);
        if (!isExecutableFile(binaryPath)) {
            throw new Error(`VibeASR.cpp のビルド後に asr_stream_server が見つかりません: ${binaryPath}`);
        }
    }

    const modelId = String(settings.modelId || VIBEASR_DEFAULT_MODEL_ID).trim();
    if (!isExecutableFile(vaeModelPath)) {
        if (String(settings.vaeModelPath || '').trim()) throw new Error(`設定されたVAEモデルが見つかりません: ${vaeModelPath}`);
        await downloadFileAtomic(`https://huggingface.co/${modelId}/resolve/main/${VIBEASR_VAE_FILENAME}?download=true`, vaeModelPath, 'VibeVoice ASR BitNet VAEモデル（約0.7GB）');
    }
    if (!isExecutableFile(lmModelPath)) {
        if (String(settings.lmModelPath || '').trim()) throw new Error(`設定されたLMモデルが見つかりません: ${lmModelPath}`);
        await downloadFileAtomic(`https://huggingface.co/${modelId}/resolve/main/${VIBEASR_LM_FILENAME}?download=true`, lmModelPath, 'VibeVoice ASR BitNet LMモデル（約1.0GB）');
    }

    return {
        binaryPath,
        vaeModelPath,
        lmModelPath,
        threads: positiveInt(settings.threads, 4, 1, 256),
    };
}

module.exports = {
    getToolsRoot,
    resolveFfmpegTools,
    resolveNdlocrLite,
    resolveReazonK2,
    resolveVibeVoiceAsr,
    // 試験用
    _internal: {
        UV_VERSION,
        UV_PYTHON_VERSION,
        NDLOCR_LINES,
        NDLOCR_LITE_1_4_URL,
        normalizeNdlocrLine,
        isNdlocrPipVersionInRange,
        findSystemPython,
        chooseNdlocrVenvBase,
        ensureNdlocrVenvPython,
        getUvRelease,
    },
};
