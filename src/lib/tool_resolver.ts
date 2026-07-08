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
const REAZON_K2_PACKAGE_SPEC = 'git+https://github.com/reazon-research/ReazonSpeech.git#subdirectory=pkg/k2-asr';

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

function resolveBasePythonCommand(configuredPython = '') {
    ensureDir(getToolsRoot());
    const configured = String(configuredPython || '').trim();
    if (configured) {
        if (!probePythonCommand(configured)) {
            throw new Error(`設定されたPythonを起動できません: ${configured}`);
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
        if (probePythonCommand(candidate.command, candidate.argsPrefix)) {
            return candidate;
        }
    }

    throw new Error('Python 3 が見つかりません。ndlocr-lite の自動セットアップには Python 3.10 以上が必要です。Windowsでは https://www.python.org/downloads/windows/ から Python をインストールするか、config.json の tools.ndlocrLite.pythonPath に Python のパスを指定してください。');
}

function ensureNdlocrVenv(repoPath, basePython) {
    const venvDir = path.join(getToolsRoot(), 'ndlocr-lite-venv');
    const venvPython = getVenvPythonPath(venvDir);
    const markerPath = path.join(venvDir, '.mimi-installed');

    if (isExecutableFile(venvPython) && !probePythonCommand(venvPython)) {
        console.warn('[tools] ndlocr-lite用のPython環境を起動できないため作り直します。');
        fs.rmSync(venvDir, { recursive: true, force: true });
    }

    if (!isExecutableFile(venvPython)) {
        console.log('[tools] ndlocr-lite用のPython環境を作ります。');
        const python = resolveBasePythonCommand(basePython);
        runChecked(python.command, [...python.argsPrefix, '-m', 'venv', venvDir], getToolsRoot());
    }

    if (!fs.existsSync(markerPath)) {
        const requirementsPath = path.join(repoPath, 'requirements.txt');
        if (fs.existsSync(requirementsPath)) {
            console.log('[tools] ndlocr-liteのPython依存パッケージを入れます。初回だけ時間がかかります。');
            runChecked(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], repoPath);
        }
        fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
    }

    return venvPython;
}

async function resolveNdlocrLite(settings: any = {}) {
    const configuredRepo = String(settings.repoPath || '').trim();
    const configuredPython = String(settings.pythonPath || '').trim();

    if (configuredRepo && fs.existsSync(path.join(configuredRepo, 'src', 'ocr.py'))) {
        const pythonPath = configuredPython || ensureNdlocrVenv(configuredRepo, configuredPython);
        return { repoPath: configuredRepo, pythonPath };
    }

    const repoPath = path.join(getToolsRoot(), 'ndlocr-lite');
    if (!fs.existsSync(path.join(repoPath, 'src', 'ocr.py'))) {
        const downloadsDir = path.join(getToolsRoot(), 'downloads');
        const zipPath = path.join(downloadsDir, 'ndlocr-lite.zip');
        ensureDir(downloadsDir);

        const sourceUrl = await getLatestNdlocrSourceUrl();
        console.log('[tools] ndlocr-liteを自動取得します。初回だけ時間がかかります。');
        await downloadFile(sourceUrl, zipPath);

        const stagingDir = `${repoPath}.staging-${process.pid}-${Date.now()}`;
        try {
            extractZipStrippingRoot(zipPath, stagingDir);
            if (!fs.existsSync(path.join(stagingDir, 'src', 'ocr.py'))) {
                throw new Error('展開したndlocr-lite内に src/ocr.py が見つかりませんでした');
            }
            fs.rmSync(repoPath, { recursive: true, force: true });
            fs.renameSync(stagingDir, repoPath);
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
        console.log(`[tools] ndlocr-liteを準備しました: ${repoPath}`);
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

module.exports = {
    getToolsRoot,
    resolveFfmpegTools,
    resolveNdlocrLite,
    resolveReazonK2,
};
