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
const NDLOCR_RELEASE_API_URL = 'https://api.github.com/repos/ndl-lab/ndlocr-lite/releases/latest';
const NDLOCR_SOURCE_FALLBACK_URL = 'https://github.com/ndl-lab/ndlocr-lite/archive/refs/heads/master.zip';
// 自動で取ってきた ndlocr-lite がこれより古ければ取り直す（2.0.0 でモデルのファイル名と依存が変わった）。
const NDLOCR_MIN_VERSION = [2, 0, 0];
// ndlocr-lite 2.0.0 の CLI は Python 3.11 以上（pyproject の requires-python、Pillow 13）。
const NDLOCR_MIN_PYTHON = [3, 11];
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

    const actual = sha256File(filePath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
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

function stripFirstPathPart(entryName) {
    return entryName.replace(/\\/g, '/').split('/').slice(1).join('/');
}

function extractZipStrippingRoot(zipPath, destDir) {
    const zip = new AdmZip(zipPath);
    fs.rmSync(destDir, { recursive: true, force: true });
    ensureDir(destDir);

    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const relative = stripFirstPathPart(entry.entryName);
        if (!relative || relative.includes('..')) continue;
        const destPath = path.resolve(destDir, relative);
        if (!destPath.startsWith(path.resolve(destDir) + path.sep)) continue;
        writeZipEntry(zip, entry, destPath);
    }
}

async function getLatestNdlocrSourceUrl() {
    try {
        const text = String(await downloadText(NDLOCR_RELEASE_API_URL));
        const parsed = JSON.parse(text);
        if (parsed?.zipball_url) return parsed.zipball_url;
    } catch (err) {
        console.warn(`[tools] ndlocr-lite最新リリース情報を取得できませんでした: ${err.message}`);
    }
    return NDLOCR_SOURCE_FALLBACK_URL;
}

function getVenvPythonPath(venvDir) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

function runChecked(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd,
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

// minVersion を渡すと、それより古い Python は選ばない（[3, 11] など）。
function resolveBasePythonCommand(configuredPython = '', minVersion = null) {
    ensureDir(getToolsRoot());
    const isNewEnough = (version) => !minVersion || (version && compareVersionNumbers(version, minVersion) >= 0);
    const configured = String(configuredPython || '').trim();
    if (configured) {
        const version = getPythonVersion(configured);
        if (!version) {
            throw new Error(`設定されたPythonを起動できません: ${configured}`);
        }
        if (!isNewEnough(version)) {
            throw new Error(`設定されたPythonは ${version.join('.')} です。Python ${minVersion.join('.')} 以上を指定してください: ${configured}`);
        }
        return { command: configured, argsPrefix: [] };
    }

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
        if (isNewEnough(getPythonVersion(candidate.command, candidate.argsPrefix))) {
            return candidate;
        }
    }

    const required = minVersion ? `Python ${minVersion.join('.')} 以上` : 'Python 3';
    throw new Error(`${required} が見つかりません。ndlocr-lite の自動セットアップには Python 3.11 以上が必要です。Windowsでは https://www.python.org/downloads/windows/ から Python をインストールするか、config.json の tools.ndlocrLite.pythonPath に Python のパスを指定してください。`);
}

function ensureNdlocrVenv(repoPath, basePython) {
    const venvDir = path.join(getToolsRoot(), 'ndlocr-lite-venv');
    const venvPython = getVenvPythonPath(venvDir);
    // 入れた requirements.txt の sha256。ndlocr-lite を取り直して依存が変わったら入れ直す。
    const markerPath = path.join(venvDir, '.mimi-installed');

    if (isExecutableFile(venvPython)) {
        const version = getPythonVersion(venvPython);
        if (!version) {
            console.warn('[tools] ndlocr-lite用のPython環境を起動できないため作り直します。');
            fs.rmSync(venvDir, { recursive: true, force: true });
        } else if (compareVersionNumbers(version, NDLOCR_MIN_PYTHON) < 0) {
            console.warn(`[tools] ndlocr-lite用のPython環境が Python ${version.join('.')} なので、${NDLOCR_MIN_PYTHON.join('.')} 以上で作り直します。`);
            fs.rmSync(venvDir, { recursive: true, force: true });
        }
    }

    if (!isExecutableFile(venvPython)) {
        console.log('[tools] ndlocr-lite用のPython環境を作ります。');
        const python = resolveBasePythonCommand(basePython, NDLOCR_MIN_PYTHON);
        runChecked(python.command, [...python.argsPrefix, '-m', 'venv', venvDir], getToolsRoot());
    }

    const requirementsPath = path.join(repoPath, 'requirements.txt');
    const stamp = fs.existsSync(requirementsPath) ? `requirements-sha256:${fileSha256(requirementsPath)}` : 'no-requirements';
    const installed = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf-8').trim() : '';
    if (installed !== stamp) {
        if (fs.existsSync(requirementsPath)) {
            console.log(installed
                ? '[tools] ndlocr-liteの依存パッケージが変わったので入れ直します。'
                : '[tools] ndlocr-liteのPython依存パッケージを入れます。初回だけ時間がかかります。');
            runChecked(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], repoPath);
        }
        fs.writeFileSync(markerPath, stamp, 'utf-8');
    }

    return venvPython;
}

async function resolveNdlocrLite(settings: any = {}) {
    const configuredRepo = String(settings.repoPath || '').trim();
    const configuredPython = String(settings.pythonPath || '').trim();

    if (configuredRepo && fs.existsSync(path.join(configuredRepo, 'src', 'ocr.py'))) {
        // 指定された場所は書き換えない。古ければ知らせるだけ。
        if (isNdlocrOlderThanMinimum(configuredRepo)) {
            console.warn(`[tools] 設定の ndlocr-lite が ${NDLOCR_MIN_VERSION.join('.')} より古いようです: ${configuredRepo}`);
        }
        const pythonPath = configuredPython || ensureNdlocrVenv(configuredRepo, configuredPython);
        return { repoPath: configuredRepo, pythonPath };
    }

    const repoPath = path.join(getToolsRoot(), 'ndlocr-lite');
    const present = fs.existsSync(path.join(repoPath, 'src', 'ocr.py'));
    if (!present || isNdlocrOlderThanMinimum(repoPath)) {
        const downloadsDir = path.join(getToolsRoot(), 'downloads');
        const zipPath = path.join(downloadsDir, 'ndlocr-lite.zip');
        ensureDir(downloadsDir);

        const stagingDir = `${repoPath}.staging-${process.pid}-${Date.now()}`;
        try {
            const sourceUrl = await getLatestNdlocrSourceUrl();
            console.log(present
                ? `[tools] ndlocr-liteが古いので ${NDLOCR_MIN_VERSION.join('.')} 以上に取り直します。`
                : '[tools] ndlocr-liteを自動取得します。初回だけ時間がかかります。');
            await downloadFile(sourceUrl, zipPath);
            extractZipStrippingRoot(zipPath, stagingDir);
            if (!fs.existsSync(path.join(stagingDir, 'src', 'ocr.py'))) {
                throw new Error('展開したndlocr-lite内に src/ocr.py が見つかりませんでした');
            }
            fs.rmSync(repoPath, { recursive: true, force: true });
            fs.renameSync(stagingDir, repoPath);
            console.log(`[tools] ndlocr-liteを準備しました: ${repoPath}`);
        } catch (err) {
            // 取り直しに失敗しても、前の写しがあればそれで続ける（オフラインなど）。
            if (!present) throw err;
            console.warn(`[tools] ndlocr-liteを取り直せなかったので、今の写しを使います: ${err.message}`);
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
    }

    const pythonPath = ensureNdlocrVenv(repoPath, configuredPython);
    return { repoPath, pythonPath };
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
};
