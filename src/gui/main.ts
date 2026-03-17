const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// コンソールウィンドウの管理
let consoleWindows = new Map();

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
        backgroundColor: '#00000000'
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
    'ocr_general': { path: 'src/ocr.js', name: 'OCR（一般）' },
    'ocr_houhi':   { path: 'src/ocr.js', name: 'OCR（法匹）' },
    'merge':       { path: 'src/merge_pages.js', name: 'ページ結合' },
    'split':       { path: 'src/split_pages.js', name: '文書分割' },
    'deblank':     { path: 'src/remove_blank_pages.js', name: '白紙除去' }
};

// ファイル選択ダイアログ（コンテキストファイル用）
ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        title: 'houhi コンテキストファイルを選択'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('execute-script', async (event, {
    scriptKey,
    filePaths,
    aiProvider,
    processMode,
    ocrMode,
    preferPdfText,
    autoRename,
    batchSize,
    contextFile,
    splitJson
}) => {
    if (!SCRIPTS[scriptKey]) {
        throw new Error('無効なスクリプトキーです');
    }

    const script = SCRIPTS[scriptKey];
    const scriptPath = path.resolve(__dirname, '../../', script.path);

    const isMerge = scriptKey === 'merge';
    const isSplit = scriptKey === 'split';
    const isDeblank = scriptKey === 'deblank';
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

    // 引数を構築
    let scriptArgs = [];
    if (isSplit) {
        if (splitJsonTempFile) {
            scriptArgs.push('--json-file', splitJsonTempFile);
        }
    } else if (!isMerge && !isDeblank) {
        // ターゲット（houhi / general）
        const target = scriptKey === 'ocr_houhi' ? 'houhi' : 'general';
        scriptArgs.push('--target', target);

        // houhi モードのコンテキストファイル
        if (target === 'houhi' && contextFile) {
            scriptArgs.push('--context-file', contextFile);
        }

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
    scriptArgs.push(...filePaths);

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
    } else if (!isMerge) {
        const target = scriptKey === 'ocr_houhi' ? 'houhi' : 'general';
        const ocrLabel = ndlocrOnly ? 'ndlocr-only' : (useNdlocr ? 'ndlocr+AI' : 'AIのみ');
        const renameLabel = autoRename === false ? 'Off' : 'On';
        consoleWin.webContents.send('console-info',
            `ターゲット: ${target} / AI: ${aiProvider || 'gemini'} / モード: ${processMode === 'sync' ? '同期' : 'バッチ'} / OCR: ${ocrLabel} / PDFテキスト優先: ${preferPdfText ? 'On' : 'Off'} / 自動改名: ${renameLabel}`
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
