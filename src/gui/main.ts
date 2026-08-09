const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findConfigPath, findAppDefaultsPath, loadAppDefaults, loadUserConfig, loadConfig, getProviderModel } = require('../lib/gemini_client');
const { getScriptNodeRuntime } = require('../lib/node_runtime');

// コンソールウィンドウの管理
let consoleWindows = new Map();

// メインウィンドウの管理（設定画面を開くときに一時的に大きくする）
let mainWindow = null;
const DEFAULT_WINDOW_SIZE = { width: 480, height: 840 };
const SETTINGS_WINDOW_SIZE = { width: 800, height: 860 };

function resizeMainWindowForMode(mode) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const target = mode === 'settings' ? SETTINGS_WINDOW_SIZE : DEFAULT_WINDOW_SIZE;
    const currentBounds = mainWindow.getBounds();
    const workArea = screen.getDisplayMatching(currentBounds).workArea;
    const width = Math.min(target.width, workArea.width);
    const height = Math.min(target.height, workArea.height);
    const centerX = currentBounds.x + currentBounds.width / 2;
    const centerY = currentBounds.y + currentBounds.height / 2;
    let x = Math.round(centerX - width / 2);
    let y = Math.round(centerY - height / 2);
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
    y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
    mainWindow.setBounds({ x, y, width, height }, true);
}

function findUpFile(fileName) {
    const startDirs = [process.env.MIMI_OCR_PROJECT_ROOT, process.cwd(), __dirname, path.dirname(process.execPath)].filter(Boolean);
    const visited = new Set();

    for (const startDir of startDirs) {
        let currentDir = path.resolve(startDir);
        while (!visited.has(currentDir)) {
            visited.add(currentDir);
            const candidate = path.join(currentDir, fileName);
            if (fs.existsSync(candidate)) return candidate;
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break;
            currentDir = parentDir;
        }
    }

    return null;
}

function getProjectRootForGui() {
    const envProjectRoot = process.env.MIMI_OCR_PROJECT_ROOT;
    if (envProjectRoot && fs.existsSync(path.join(envProjectRoot, 'package.json'))) {
        return path.resolve(envProjectRoot);
    }

    const packagePath = findUpFile('package.json');
    if (packagePath) {
        return path.dirname(packagePath);
    }

    return path.resolve(__dirname, '../../');
}

function isReleaseRuntime() {
    return process.env.MIMI_OCR_RELEASE === '1';
}

function ensureReleaseConfigEnv() {
    if (!isReleaseRuntime()) return;
    if (!process.env.MIMI_OCR_CONFIG_DIR) {
        process.env.MIMI_OCR_CONFIG_DIR = app.getPath('userData');
    }
}

function getDefaultConfig() {
    ensureReleaseConfigEnv();
    return loadAppDefaults();
}

function getWritableConfigPath() {
    ensureReleaseConfigEnv();
    const envConfigPath = process.env.MIMI_OCR_CONFIG;
    if (envConfigPath) return path.resolve(envConfigPath);
    const envConfigDir = process.env.MIMI_OCR_CONFIG_DIR;
    if (envConfigDir) return path.join(path.resolve(envConfigDir), 'config.json');
    const existing = findConfigPath();
    if (existing) return existing;
    const packagePath = findUpFile('package.json');
    if (packagePath) return path.join(path.dirname(packagePath), 'config.json');
    const defaultsPath = findAppDefaultsPath();
    if (defaultsPath) return path.join(path.dirname(defaultsPath), 'config.json');
    return path.join(process.cwd(), 'config.json');
}

function loadConfigForGui() {
    ensureReleaseConfigEnv();
    const configPath = findConfigPath();
    const defaults = getDefaultConfig();
    const userConfig = loadUserConfig() || {};
    const config = loadConfig() || defaults;

    if (!configPath) {
        return { path: getWritableConfigPath(), exists: false, config, userConfig, defaults };
    }

    return {
        path: configPath,
        exists: true,
        config,
        userConfig,
        defaults
    };
}

function writeUserConfig(config) {
    const configPath = getWritableConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    return configPath;
}

function saveToolsRootDir(rootDir) {
    const userConfig = loadUserConfig() || {};
    if (!userConfig.tools || typeof userConfig.tools !== 'object' || Array.isArray(userConfig.tools)) {
        userConfig.tools = {};
    }
    userConfig.tools.rootDir = path.resolve(rootDir);
    const configPath = writeUserConfig(userConfig);
    return { configPath, userConfig };
}

function getConfiguredToolsRoot() {
    const envDir = String(process.env.MIMI_TOOLS_DIR || '').trim();
    if (envDir) return path.resolve(envDir);
    const config = loadConfig() || {};
    const configuredDir = String(config?.tools?.rootDir || '').trim();
    if (configuredDir) return path.resolve(configuredDir);
    if (isReleaseRuntime()) return path.join(app.getPath('userData'), 'tools');
    return path.join(getProjectRootForGui(), '.mimi-tools');
}

function isNdlocrLiteInstalled(toolsRoot) {
    return fs.existsSync(path.join(toolsRoot, 'ndlocr-lite', 'src', 'ocr.py'));
}

function hasGeminiApiKey() {
    const config = loadConfig() || {};
    return Boolean(
        config?.providers?.gemini?.apiKey ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY
    );
}

function getBundledNodeRuntime(projectRoot) {
    return getScriptNodeRuntime({ projectRoot, execPath: process.execPath, env: process.env, platform: process.platform });
}

function getBundledNodePath(projectRoot) {
    return getBundledNodeRuntime(projectRoot).command;
}

function createWindow() {
    const iconPath = process.platform === 'darwin' 
        ? path.join(__dirname, '../../bin/MIMI OCR.app/Contents/Resources/app.icns')
        : path.join(__dirname, '../../bin/MIMI OCR.app/Contents/Resources/app.icns');
    
    const win = new BrowserWindow({
        width: DEFAULT_WINDOW_SIZE.width,
        height: DEFAULT_WINDOW_SIZE.height,
        minWidth: 380,
        minHeight: 480,
        resizable: true,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#74b1be'
        },
        transparent: true,
        backgroundColor: '#00000000',
        title: 'MIMI OCR'
    });

    mainWindow = win;
    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });

    win.loadFile(path.join(__dirname, 'index.html'));
    // win.webContents.openDevTools(); // デバッグ用
}

function createConsoleWindow(taskName, fileCount) {
    const iconPath = process.platform === 'darwin' 
        ? path.join(__dirname, '../../bin/MIMI OCR.app/Contents/Resources/app.icns')
        : path.join(__dirname, '../../bin/MIMI OCR.app/Contents/Resources/app.icns');
    
    const consoleWin = new BrowserWindow({
        width: 800,
        height: 500,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'console_preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#1a1a2e',
            symbolColor: '#64b5f6'
        },
        backgroundColor: '#1a1a2e',
        show: false
    });

    consoleWin.loadFile(path.join(__dirname, 'console.html'));
    consoleWin.once('ready-to-show', () => {
        consoleWin.show();
    });

    return consoleWin;
}

// アプリケーション名を設定（メニューバーのタイトルに表示）
app.setName('MIMI OCR');

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// スクリプト定義
const SCRIPTS = {
    'ocr':         { path: 'src/ocr.js', name: 'OCR' },
    'transcribe_audio': { path: 'src/transcribe_audio.js', name: '音声認識' },
    'merge':       { path: 'src/merge_pages.js', name: 'MD結合' },
    'split':       { path: 'src/split_pages.js', name: '文書分割' },
    'deblank':     { path: 'src/remove_blank_pages.js', name: '白紙除去' },
    'stitch':      { path: 'src/stitch_pages.js', name: '分割復元' },
    'pdf_pages':   { path: 'src/pdf_pages.js', name: 'PDF抽出' }
};

ipcMain.handle('load-config', async () => {
    try {
        return { success: true, ...loadConfigForGui() };
    } catch (err) {
        return {
            success: false,
            path: getWritableConfigPath(),
            exists: false,
            config: getDefaultConfig(),
            error: err.message || String(err)
        };
    }
});

ipcMain.handle('save-config', async (_event, config) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('設定データの形式が不正です');
    }

    const configPath = writeUserConfig(config);
    return { success: true, path: configPath };
});

ipcMain.handle('resize-main-window', async (_event, mode) => {
    resizeMainWindowForMode(mode === 'settings' ? 'settings' : 'default');
    return { success: true };
});

ipcMain.handle('open-external-url', async (_event, url) => {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') {
        throw new Error('https のリンクだけ開けます');
    }
    await shell.openExternal(parsed.toString());
    return { success: true };
});

ipcMain.handle('get-setup-status', async () => {
    ensureReleaseConfigEnv();
    const toolsRoot = getConfiguredToolsRoot();
    return {
        success: true,
        configPath: getWritableConfigPath(),
        toolsRoot,
        ndlocrInstalled: isNdlocrLiteInstalled(toolsRoot),
        hasGeminiApiKey: hasGeminiApiKey(),
        nodePath: getBundledNodePath(getProjectRootForGui()),
        releaseRuntime: isReleaseRuntime()
    };
});

ipcMain.handle('choose-tools-root', async (_event, options: any = {}) => {
    ensureReleaseConfigEnv();
    const currentToolsRoot = getConfiguredToolsRoot();
    const title = options?.title || '外部ツールの保存先を選択';
    const result = await dialog.showOpenDialog({
        title,
        defaultPath: fs.existsSync(currentToolsRoot) ? currentToolsRoot : app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
    }

    const toolsRoot = result.filePaths[0];
    const saved = saveToolsRootDir(toolsRoot);
    process.env.MIMI_TOOLS_DIR = path.resolve(toolsRoot);
    return {
        success: true,
        toolsRoot: path.resolve(toolsRoot),
        configPath: saved.configPath,
        userConfig: saved.userConfig,
        ndlocrInstalled: isNdlocrLiteInstalled(path.resolve(toolsRoot))
    };
});

ipcMain.handle('prepare-ndlocr-root', async () => {
    ensureReleaseConfigEnv();
    const currentToolsRoot = getConfiguredToolsRoot();
    fs.mkdirSync(currentToolsRoot, { recursive: true });
    process.env.MIMI_TOOLS_DIR = currentToolsRoot;

    if (isNdlocrLiteInstalled(currentToolsRoot)) {
        return { success: true, toolsRoot: currentToolsRoot, alreadyInstalled: true };
    }

    return {
        success: true,
        toolsRoot: currentToolsRoot,
        alreadyInstalled: false
    };
});

ipcMain.handle('execute-script', async (event, {
    scriptKey,
    filePaths,
    aiProvider,
    processMode,
    ocrMode,
    preferPdfText,
    autoRename,
    skipFormattedRename,
    batchSize,
    ocrTarget,
    audioOptions,
    silenceTrim,
    contextText,
    splitJson,
    pdfPageOptions,
    stitchOptions
}) => {
    if (!SCRIPTS[scriptKey]) {
        throw new Error('無効なスクリプトキーです');
    }

    const script = SCRIPTS[scriptKey];
    const scriptRoot = path.resolve(__dirname, '../../');
    const projectRoot = getProjectRootForGui();
    const scriptPath = path.resolve(scriptRoot, script.path);

    const isMerge = scriptKey === 'merge';
    const isSplit = scriptKey === 'split';
    const isDeblank = scriptKey === 'deblank';
    const isStitch = scriptKey === 'stitch';
    const isPdfPages = scriptKey === 'pdf_pages';
    const isAudio = scriptKey === 'transcribe_audio';
    const selectedOcrMode = ocrMode || 'ndlocr_ai';
    const useNdlocr = selectedOcrMode === 'ndlocr_ai' || selectedOcrMode === 'ndlocr_only';
    const ndlocrOnly = selectedOcrMode === 'ndlocr_only';
    const ocrUsesAi = !isMerge && !isDeblank && !isSplit && !isPdfPages && !isStitch && (!ndlocrOnly || autoRename === true);
    const needsGeminiApiKey = (isAudio && audioOptions?.provider === 'gemini') ||
        (ocrUsesAi && (aiProvider || 'gemini') === 'gemini');

    ensureReleaseConfigEnv();
    if (needsGeminiApiKey && !hasGeminiApiKey()) {
        return {
            success: false,
            setupRequired: 'gemini-api-key',
            code: -2,
            message: 'Gemini APIキーが未設定です。設定画面で APIキーを保存してください。'
        };
    }

    // 分割ツール: JSONを一時ファイルに書き出し
    let splitJsonTempFile = null;
    if (isSplit && splitJson) {
        const os = require('os');
        splitJsonTempFile = path.join(os.tmpdir(), `mimi-ocr-split-${Date.now()}.json`);
        require('fs').writeFileSync(splitJsonTempFile, splitJson, 'utf-8');
    }

    let contextTempFile = null;
    const context = String(contextText || '').trim();
    if ((isAudio || (!isMerge && !isDeblank && !isSplit && !isPdfPages && !isStitch)) && context) {
        const os = require('os');
        contextTempFile = path.join(os.tmpdir(), `mimi-ocr-context-${Date.now()}.txt`);
        require('fs').writeFileSync(contextTempFile, context, 'utf-8');
    }

    // 引数を構築
    let scriptArgs = [];
    if (isSplit) {
        if (splitJsonTempFile) {
            scriptArgs.push('--json-file', splitJsonTempFile);
        }
    } else if (isPdfPages) {
        const pages = (pdfPageOptions?.pages || '').trim();
        const filePages = Array.isArray(pdfPageOptions?.filePages) ? pdfPageOptions.filePages : [];
        if (filePages.length === 0 && pages) {
            scriptArgs.push('--pages', pages);
        }
        scriptArgs.push('--page-type', pdfPageOptions?.pageType === 'printed' ? 'printed' : 'pdf');
        if (pdfPageOptions?.twoUp) {
            scriptArgs.push('--two-up');
            scriptArgs.push('--direction', pdfPageOptions?.direction === 'rtl' ? 'rtl' : 'ltr');
        }
    } else if (isStitch) {
        const groupSizeRaw = String(stitchOptions?.groupSize || 'auto').trim();
        const dpiRaw = String(stitchOptions?.dpi || 'auto').trim();
        const groupSize = parseInt(groupSizeRaw, 10);
        const dpi = parseInt(dpiRaw, 10);
        scriptArgs.push('--group-size', groupSizeRaw === 'auto' ? 'auto' : String(!isNaN(groupSize) && groupSize >= 2 ? groupSize : 2));
        scriptArgs.push('--dpi', dpiRaw === 'auto' ? 'auto' : String(!isNaN(dpi) && dpi >= 72 ? dpi : 300));
        if (stitchOptions?.keepTemp) {
            scriptArgs.push('--keep-temp');
        }
    } else if (isAudio) {
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        const provider = audioOptions?.provider === 'reazon-k2'
            ? 'reazon-k2'
            : audioOptions?.provider === 'vibevoice-asr'
                ? 'vibevoice-asr'
                : audioOptions?.provider === 'gemini'
                    ? 'gemini'
                    : 'openai';
        const defaultModel = provider === 'gemini'
            ? getProviderModel('gemini', 'transcription') || 'gemini-3.5-flash'
            : provider === 'reazon-k2'
                ? 'ja'
                : provider === 'vibevoice-asr'
                    ? 'auto'
                    : getProviderModel('openai', 'transcription') || 'gpt-4o-transcribe-diarize';
        scriptArgs.push(`--target=${target}`);
        scriptArgs.push(`--provider=${provider}`);
        scriptArgs.push(`--model=${audioOptions?.model || defaultModel}`);
        if (provider === 'reazon-k2') {
            scriptArgs.push(`--postprocess-ai=${audioOptions?.postprocessAi || 'auto'}`);
            scriptArgs.push(`--reazon-language=${audioOptions?.model || 'ja'}`);
        }
        if (provider === 'vibevoice-asr') {
            scriptArgs.push(`--postprocess-ai=${audioOptions?.postprocessAi || 'off'}`);
        }
        scriptArgs.push(`--mode=${processMode === 'batch' ? 'batch' : 'sync'}`);
        const bs = parseInt(batchSize, 10);
        if (!isNaN(bs) && bs > 0) {
            scriptArgs.push(`--batch_size=${String(bs)}`);
        }
        scriptArgs.push(autoRename === true ? '--auto_rename' : '--no_auto_rename');
        scriptArgs.push(skipFormattedRename === true ? '--skip_formatted_rename' : '--no_skip_formatted_rename');
        scriptArgs.push(silenceTrim === true ? '--trim_silence' : '--no_trim_silence');
        if (contextTempFile) {
            scriptArgs.push(`--context-file=${contextTempFile}`);
        }
    } else if (!isMerge && !isDeblank && !isStitch) {
        // ターゲット（houhi / general）
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        scriptArgs.push('--target', target);

        // OCRエンジン設定
        if (ndlocrOnly) {
            scriptArgs.push('--ndlocr_only');
        } else if (useNdlocr) {
            scriptArgs.push('--ndlocr');
        } else {
            scriptArgs.push('--no_ndlocr');
        }

        // PDFテキスト優先
        if (preferPdfText) {
            scriptArgs.push('--prefer_pdf_text');
        }

        if (autoRename === true) {
            scriptArgs.push('--auto_rename');
        }
        scriptArgs.push(skipFormattedRename === true ? '--skip_formatted_rename' : '--no_skip_formatted_rename');

        if (contextTempFile) {
            scriptArgs.push('--context-file-text', contextTempFile);
        }

        // AI プロバイダー・処理モード
        scriptArgs.push('--ai', aiProvider || 'gemini');
        scriptArgs.push('--mode', processMode || 'sync');

        // バッチサイズ
        const bs = parseInt(batchSize, 10);
        if (!isNaN(bs) && bs > 0) {
            scriptArgs.push('--batch_size', String(bs));
        }
    }

    // ファイルパスを末尾に追加
    if (isPdfPages && Array.isArray(pdfPageOptions?.filePages) && pdfPageOptions.filePages.length > 0) {
        for (const item of pdfPageOptions.filePages) {
            const filePath = item?.path;
            const pages = item?.pages;
            if (filePath && pages) {
                scriptArgs.push(`${filePath}::${pages}`);
            }
        }
    } else {
        scriptArgs.push(...filePaths);
    }

    // コンソールウィンドウを作成
    const consoleWin = createConsoleWindow(script.name, filePaths.length);

    await new Promise(resolve => {
        consoleWin.webContents.once('did-finish-load', () => {
            setTimeout(resolve, 100);
        });
    });

    // タスク情報を送信
    consoleWin.webContents.send('console-task-info', {
        taskName: script.name,
        fileCount: filePaths.length,
        files: filePaths.map(p => path.basename(p))
    });

    // 実行コマンドをログに表示
    const nodeRuntime = getBundledNodeRuntime(projectRoot);
    const nodeCommand = nodeRuntime.command;
    const cmdSummary = `${path.basename(nodeCommand)} ${path.basename(scriptPath)} ${scriptArgs.filter(a => !filePaths.includes(a)).join(' ')} ...`;
    consoleWin.webContents.send('console-command', `実行コマンド: ${cmdSummary}`);
    consoleWin.webContents.send('console-info', `作業ディレクトリ: ${projectRoot}`);
    consoleWin.webContents.send('console-info', `Node: ${nodeCommand}`);

    if (isSplit) {
        consoleWin.webContents.send('console-info', '分割定義JSONに基づいてファイルを分割します');
    } else if (isDeblank) {
        consoleWin.webContents.send('console-info', 'OCR結果をもとに白紙ページを除去します');
    } else if (isStitch) {
        consoleWin.webContents.send('console-info', `分割スキャンを復元します: group-size=${stitchOptions?.groupSize || 'auto'} / dpi=${stitchOptions?.dpi || 'auto'}`);
    } else if (isPdfPages) {
        const pageTypeLabel = pdfPageOptions?.pageType === 'printed' ? '印刷ページ' : 'PDFページ';
        const twoUpLabel = pdfPageOptions?.twoUp
            ? `2面割付 (${pdfPageOptions?.direction === 'rtl' ? '右から左' : '左から右'})`
            : '通常抽出';
        consoleWin.webContents.send('console-info', `ページ指定: ${pdfPageOptions?.pages || '(未指定)'} / 種別: ${pageTypeLabel} / ${twoUpLabel}`);
    } else if (isAudio) {
        const target = ocrTarget === 'houhi' ? '法匪' : '一般';
        const providerId = audioOptions?.provider === 'reazon-k2'
            ? 'reazon-k2'
            : audioOptions?.provider === 'vibevoice-asr'
                ? 'vibevoice-asr'
                : audioOptions?.provider === 'gemini'
                    ? 'gemini'
                    : 'openai';
        const provider = providerId === 'reazon-k2'
            ? 'Reazon K2'
            : providerId === 'vibevoice-asr'
                ? 'VibeVoice ASR (CPU)'
                : providerId === 'gemini'
                    ? 'Gemini'
                    : 'OpenAI';
        const effectiveAudioModel = audioOptions?.model || (providerId === 'reazon-k2'
            ? 'ja'
            : providerId === 'vibevoice-asr'
                ? 'microsoft/VibeVoice-ASR-BitNet'
                : getProviderModel(providerId, 'transcription') || '(未設定)');
        const postprocessLabel = (audioOptions?.provider === 'reazon-k2' || audioOptions?.provider === 'vibevoice-asr')
            ? ` / AI後処理: ${audioOptions?.postprocessAi || (audioOptions?.provider === 'vibevoice-asr' ? 'off' : 'auto')}`
            : '';
        const modeLabel = processMode === 'batch' ? `バッチ (サイズ ${batchSize || 4})` : '同期';
        const renameLabel = autoRename === true ? 'On' : 'Off';
        const formattedLabel = skipFormattedRename === true ? 'スキップ' : '再判定';
        const trimLabel = silenceTrim === true ? 'On' : 'Off';
        const contextLabel = context ? 'あり' : 'なし';
        consoleWin.webContents.send('console-info', `音声認識: ${target} / ${provider} / モデル: ${effectiveAudioModel}${postprocessLabel} / モード: ${modeLabel} / 自動改名: ${renameLabel} / 形式済み: ${formattedLabel} / 無音カット: ${trimLabel} / コンテキスト: ${contextLabel}`);
    } else if (!isMerge && !isStitch) {
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        const ocrLabel = ndlocrOnly ? 'ndlocr-only' : (useNdlocr ? 'ndlocr+AI' : 'AIのみ');
        const renameLabel = autoRename === false ? 'Off' : 'On';
        const formattedLabel = skipFormattedRename === true ? 'スキップ' : '再判定';
        const selectedProvider = aiProvider || 'gemini';
        const effectiveModel = getProviderModel(selectedProvider, 'chat') || '(未設定)';
        const aiLabel = ndlocrOnly && autoRename !== true
            ? '使用しない'
            : `${selectedProvider} / モデル: ${effectiveModel}${ndlocrOnly ? '（自動改名のみ）' : ''}`;
        consoleWin.webContents.send('console-info',
            `ターゲット: ${target} / AI: ${aiLabel} / モード: ${processMode === 'sync' ? '同期' : 'バッチ'} / OCR: ${ocrLabel} / PDFテキスト優先: ${preferPdfText ? 'On' : 'Off'} / 自動改名: ${renameLabel} / 形式済み: ${formattedLabel}`
            + ` / コンテキスト: ${context ? 'あり' : 'なし'}`
        );
    }

    event.sender.send('script-log', `実行: ${cmdSummary}\n`);

    return new Promise((resolve) => {
        const childEnv: any = {
            ...process.env,
            MIMI_OCR_PROJECT_ROOT: projectRoot,
            MIMI_OCR_CONFIG_DIR: process.env.MIMI_OCR_CONFIG_DIR || '',
            MIMI_TOOLS_DIR: getConfiguredToolsRoot()
        };
        if (nodeRuntime.electronAsNode) {
            childEnv.ELECTRON_RUN_AS_NODE = '1';
        } else {
            delete childEnv.ELECTRON_RUN_AS_NODE;
        }
        const childProcess = spawn(nodeCommand, [scriptPath, ...scriptArgs], {
            cwd: projectRoot,
            shell: false,
            windowsHide: true,
            env: childEnv
        });

        let stdout = '';
        let stderr = '';

        const safeSend = (channel, data) => {
            if (consoleWin && !consoleWin.isDestroyed()) {
                consoleWin.webContents.send(channel, data);
            }
        };

        let lineBuffer = '';
        childProcess.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            lineBuffer += text;

            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                if (line.includes('エラー') || line.includes('Error') || line.includes('error')) {
                    safeSend('console-error', line);
                } else if (line.includes('警告') || line.includes('Warning') || line.includes('warning')) {
                    safeSend('console-warning', line);
                } else if (line.includes('完了') || line.includes('成功') || line.includes('Success')) {
                    safeSend('console-success', line);
                } else if (line.includes('処理中') || line.includes('開始') || line.includes('...')) {
                    safeSend('console-info', line);
                } else {
                    safeSend('console-log', line);
                }
            }
        });

        childProcess.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            text.split('\n').forEach(line => {
                if (!line.trim()) return;
                if (nodeRuntime.electronAsNode && /crashpad\\.*registration_protocol_win\.cc/i.test(line)) return;
                safeSend('console-error', line);
            });
        });

        childProcess.on('close', (code) => {
            const setAutoClose = () => {
                if (!consoleWin.isDestroyed()) {
                    consoleWin.webContents.send('console-info', 'このウィンドウは10分後に自動的に閉じます');
                    setTimeout(() => {
                        if (!consoleWin.isDestroyed()) consoleWin.close();
                    }, 10 * 60 * 1000);
                }
            };

            // 分割ツールの一時ファイルを削除
            if (splitJsonTempFile) {
                try { require('fs').unlinkSync(splitJsonTempFile); } catch (_) {}
            }
            if (contextTempFile) {
                try { require('fs').unlinkSync(contextTempFile); } catch (_) {}
            }

            if (code === 0) {
                safeSend('console-success', '─'.repeat(50));
                safeSend('console-success', '✅ 処理が正常に完了しました');
                safeSend('console-complete', true);
                setAutoClose();
                resolve({ success: true, output: stdout });
            } else {
                safeSend('console-error', '─'.repeat(50));
                safeSend('console-error', `❌ 処理がエラーで終了しました (コード: ${code})`);
                safeSend('console-complete', false);
                setAutoClose();
                resolve({ success: false, output: stdout, error: stderr, code });
            }
        });

        childProcess.on('error', (error) => {
            safeSend('console-error', `プロセスエラー: ${error.message}`);
            safeSend('console-complete', false);
            resolve({ success: false, output: stdout, error: error.message, code: -1 });
        });
    });
});
