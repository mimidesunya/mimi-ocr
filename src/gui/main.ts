const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findConfigPath, findAppDefaultsPath, loadAppDefaults, loadUserConfig, loadConfig } = require('../lib/gemini_client');

// コンソールウィンドウの管理
let consoleWindows = new Map();

function findUpFile(fileName) {
    const startDirs = [process.cwd(), __dirname, path.dirname(process.execPath)].filter(Boolean);
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

function getDefaultConfig() {
    return loadAppDefaults();
}

function getWritableConfigPath() {
    const existing = findConfigPath();
    if (existing) return existing;
    const packagePath = findUpFile('package.json');
    if (packagePath) return path.join(path.dirname(packagePath), 'config.json');
    const defaultsPath = findAppDefaultsPath();
    if (defaultsPath) return path.join(path.dirname(defaultsPath), 'config.json');
    return path.join(process.cwd(), 'config.json');
}

function loadConfigForGui() {
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

function createWindow() {
    const win = new BrowserWindow({
        width: 480,
        height: 760,
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

    win.loadFile(path.join(__dirname, 'index.html'));
    // win.webContents.openDevTools(); // デバッグ用
}

function createConsoleWindow(taskName, fileCount) {
    const consoleWin = new BrowserWindow({
        width: 800,
        height: 500,
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
    'merge':       { path: 'src/merge_pages.js', name: 'ページ結合' },
    'split':       { path: 'src/split_pages.js', name: '文書分割' },
    'deblank':     { path: 'src/remove_blank_pages.js', name: '白紙除去' },
    'pdf_pages':   { path: 'src/pdf_pages.js', name: 'PDFページ抽出・結合' }
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

    const configPath = getWritableConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    return { success: true, path: configPath };
});

ipcMain.handle('open-external-url', async (_event, url) => {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') {
        throw new Error('https のリンクだけ開けます');
    }
    await shell.openExternal(parsed.toString());
    return { success: true };
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
    pdfPageOptions
}) => {
    if (!SCRIPTS[scriptKey]) {
        throw new Error('無効なスクリプトキーです');
    }

    const script = SCRIPTS[scriptKey];
    const scriptPath = path.resolve(__dirname, '../../', script.path);

    const isMerge = scriptKey === 'merge';
    const isSplit = scriptKey === 'split';
    const isDeblank = scriptKey === 'deblank';
    const isPdfPages = scriptKey === 'pdf_pages';
    const isAudio = scriptKey === 'transcribe_audio';
    const selectedOcrMode = ocrMode || 'ai';
    const useNdlocr = selectedOcrMode === 'ndlocr_ai' || selectedOcrMode === 'ndlocr_only';
    const ndlocrOnly = selectedOcrMode === 'ndlocr_only';

    // 分割ツール: JSONを一時ファイルに書き出し
    let splitJsonTempFile = null;
    if (isSplit && splitJson) {
        const os = require('os');
        splitJsonTempFile = path.join(os.tmpdir(), `mimi-ocr-split-${Date.now()}.json`);
        require('fs').writeFileSync(splitJsonTempFile, splitJson, 'utf-8');
    }

    let contextTempFile = null;
    const context = String(contextText || '').trim();
    if ((isAudio || (!isMerge && !isDeblank && !isSplit && !isPdfPages)) && context) {
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
    } else if (isAudio) {
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        const provider = audioOptions?.provider === 'gemini' ? 'gemini' : 'openai';
        const defaultModel = provider === 'gemini' ? 'gemini-3.5-flash' : 'gpt-4o-transcribe-diarize';
        scriptArgs.push(`--target=${target}`);
        scriptArgs.push(`--provider=${provider}`);
        scriptArgs.push(`--model=${audioOptions?.model || defaultModel}`);
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
    } else if (!isMerge && !isDeblank) {
        // ターゲット（houhi / general）
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        scriptArgs.push('--target', target);

        // OCRエンジン設定
        if (ndlocrOnly) {
            scriptArgs.push('--ndlocr_only');
        } else if (useNdlocr) {
            scriptArgs.push('--ndlocr');
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
    const cmdSummary = `node ${path.basename(scriptPath)} ${scriptArgs.filter(a => !filePaths.includes(a)).join(' ')} ...`;
    consoleWin.webContents.send('console-command', `実行コマンド: ${cmdSummary}`);
    consoleWin.webContents.send('console-info', `作業ディレクトリ: ${path.resolve(__dirname, '../../')}`);

    if (isSplit) {
        consoleWin.webContents.send('console-info', '分割定義JSONに基づいてファイルを分割します');
    } else if (isDeblank) {
        consoleWin.webContents.send('console-info', 'OCR結果をもとに白紙ページを除去します');
    } else if (isPdfPages) {
        const pageTypeLabel = pdfPageOptions?.pageType === 'printed' ? '印刷ページ' : 'PDFページ';
        const twoUpLabel = pdfPageOptions?.twoUp
            ? `2面割付 (${pdfPageOptions?.direction === 'rtl' ? '右から左' : '左から右'})`
            : '通常抽出';
        consoleWin.webContents.send('console-info', `ページ指定: ${pdfPageOptions?.pages || '(未指定)'} / 種別: ${pageTypeLabel} / ${twoUpLabel}`);
    } else if (isAudio) {
        const target = ocrTarget === 'houhi' ? '法匪' : '一般';
        const provider = audioOptions?.provider === 'gemini' ? 'Gemini' : 'OpenAI';
        const modeLabel = processMode === 'batch' ? `バッチ (サイズ ${batchSize || 4})` : '同期';
        const renameLabel = autoRename === true ? 'On' : 'Off';
        const formattedLabel = skipFormattedRename === true ? 'スキップ' : '再判定';
        const trimLabel = silenceTrim === true ? 'On' : 'Off';
        const contextLabel = context ? 'あり' : 'なし';
        consoleWin.webContents.send('console-info', `音声認識: ${target} / ${provider} / モデル: ${audioOptions?.model || '(既定)'} / モード: ${modeLabel} / 自動改名: ${renameLabel} / 形式済み: ${formattedLabel} / 無音カット: ${trimLabel} / コンテキスト: ${contextLabel}`);
    } else if (!isMerge) {
        const target = ocrTarget === 'houhi' ? 'houhi' : 'general';
        const ocrLabel = ndlocrOnly ? 'ndlocr-only' : (useNdlocr ? 'ndlocr+AI' : 'AIのみ');
        const renameLabel = autoRename === false ? 'Off' : 'On';
        const formattedLabel = skipFormattedRename === true ? 'スキップ' : '再判定';
        consoleWin.webContents.send('console-info',
            `ターゲット: ${target} / AI: ${aiProvider || 'gemini'} / モード: ${processMode === 'sync' ? '同期' : 'バッチ'} / OCR: ${ocrLabel} / PDFテキスト優先: ${preferPdfText ? 'On' : 'Off'} / 自動改名: ${renameLabel} / 形式済み: ${formattedLabel}`
            + ` / コンテキスト: ${context ? 'あり' : 'なし'}`
        );
    }

    event.sender.send('script-log', `実行: ${cmdSummary}\n`);

    return new Promise((resolve) => {
        const childProcess = spawn('node', [scriptPath, ...scriptArgs], {
            cwd: path.resolve(__dirname, '../../'),
            shell: false,
            windowsHide: true,
            env: { ...process.env }
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
                if (line.trim()) safeSend('console-error', line);
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
