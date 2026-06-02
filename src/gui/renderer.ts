document.addEventListener('DOMContentLoaded', () => {
    // ---- DOM 参照 ----
    const dropZone        = document.getElementById('dropZone') as HTMLElement;
    const dropText        = document.getElementById('dropText') as HTMLElement;
    const dropSubtext     = document.getElementById('dropSubtext') as HTMLElement;
    const consoleOutput   = document.getElementById('consoleOutput') as HTMLElement;
    const progressBar     = document.getElementById('progressBar') as HTMLElement;
    const toolCards       = document.querySelectorAll<HTMLElement>('.tool-card');
    const contextRow      = document.getElementById('contextRow') as HTMLElement;
    const contextFileInput = document.getElementById('contextFileInput') as HTMLInputElement;
    const contextBrowseBtn = document.getElementById('contextBrowseBtn') as HTMLButtonElement;
    const batchSizeInput  = document.getElementById('batchSizeInput') as HTMLInputElement;
    const splitJsonRow    = document.getElementById('splitJsonRow') as HTMLElement;
    const splitJsonInput  = document.getElementById('splitJsonInput') as HTMLTextAreaElement;
    const pdfPagesRow     = document.getElementById('pdfPagesRow') as HTMLElement;
    const pdfPagesFileList = document.getElementById('pdfPagesFileList') as HTMLElement;
    const pdfPagesRunBtn  = document.getElementById('pdfPagesRunBtn') as HTMLButtonElement;

    const ocrBtns      = document.querySelectorAll<HTMLElement>('[data-ocr-mode]');
    const aiBtns       = document.querySelectorAll<HTMLElement>('[data-ai]');
    const modeBtns     = document.querySelectorAll<HTMLElement>('[data-mode]');
    const pdfTextBtns  = document.querySelectorAll<HTMLElement>('[data-pdftext]');
    const autoRenameBtns = document.querySelectorAll<HTMLElement>('[data-auto-rename]');
    const pdfPageTypeBtns = document.querySelectorAll<HTMLElement>('[data-pdf-page-type]');
    const pdfTwoUpBtns = document.querySelectorAll<HTMLElement>('[data-pdf-two-up]');
    const pdfDirectionBtns = document.querySelectorAll<HTMLElement>('[data-pdf-direction]');

    const toggleAi     = document.getElementById('toggleAi') as HTMLElement;
    const toggleMode   = document.getElementById('toggleMode') as HTMLElement;
    const toggleOcr    = document.getElementById('toggleOcr') as HTMLElement;
    const togglePdfText = document.getElementById('togglePdfText') as HTMLElement;
    const toggleAutoRename = document.getElementById('toggleAutoRename') as HTMLElement;
    const labelAi      = document.getElementById('labelAi') as HTMLElement;
    const labelMode    = document.getElementById('labelMode') as HTMLElement;
    const labelOcr     = document.getElementById('labelOcr') as HTMLElement;
    const labelPdfText = document.getElementById('labelPdfText') as HTMLElement;
    const labelAutoRename = document.getElementById('labelAutoRename') as HTMLElement;
    const labelBatch   = document.getElementById('labelBatch') as HTMLElement;

    // ---- 状態 ----
    type ScriptKey = 'ocr_general' | 'ocr_houhi' | 'merge' | 'split' | 'deblank' | 'pdf_pages';
    let currentScript: ScriptKey = 'ocr_general';
    let currentAiProvider = 'gemini';
    let currentProcessMode = 'sync';
    let currentOcrMode = 'ai';       // ai | ndlocr_ai | ndlocr_only
    let currentPreferPdfText = false;
    let currentAutoRename = false;
    let currentPdfPageType = 'pdf';  // pdf | printed
    let currentPdfTwoUp = false;
    let currentPdfDirection = 'ltr'; // ltr | rtl
    let selectedPdfPageFiles: string[] = [];
    let pdfPageRanges: Record<string, string> = {};
    let draggedPdfPageIndex: number | null = null;

    const isOcrTool = (key: string) => key === 'ocr_general' || key === 'ocr_houhi';
    const isPdfPagesTool = (key: string) => key === 'pdf_pages';

    // ツール説明（ホバー表示）
    const toolDescriptions: Record<string, string> = {
        'ocr_general': '一般文書をOCR処理（PDF / Word / ODT / PPTX / 画像）',
        'ocr_houhi':   '裁判文書を法匪書式でOCR処理',
        'merge':       'OCR済み _paged.md のページマーカーを結合',
        'split':       '_paged.md をJSONの分割定義で文書ごとに分割',
        'deblank':     'OCR結果をもとに白紙ページを除去したPDFとMDを生成',
        'pdf_pages':   'OCR結果をもとにPDFページを抽出・結合・2面割付'
    };

    // ---- ツール選択 ----
    function selectTool(script: ScriptKey, card: HTMLElement) {
        toolCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        currentScript = script;
        log(`ツール変更: ${card.querySelector<HTMLElement>('.tool-name')!.textContent}`);
        applyConstraints();
    }

    async function handleFilesForCurrentTool(files: string[]) {
        if (files.length === 0) return;
        if (currentScript === 'pdf_pages') {
            setPdfPageFiles(files);
            return;
        }
        await executeWith(files);
    }

    toolCards.forEach(card => {
        const script = card.dataset.script as ScriptKey;

        card.addEventListener('mouseenter', () => {
            dropText.textContent = toolDescriptions[script] || 'ここにファイルをドロップ';
            dropSubtext.textContent = '';
        });

        card.addEventListener('mouseleave', () => {
            dropText.textContent = 'ここにファイルをドロップ';
            dropSubtext.textContent = 'または クリックして選択';
        });

        card.addEventListener('click', () => {
            selectTool(script, card);
        });

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.add('drag-over');
        });

        card.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-over');
        });

        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer!.files).map(f => (window as any).electronAPI.getPathForFile(f));
            selectTool(script, card);
            await handleFilesForCurrentTool(files);
        });
    });

    // ---- OCRエンジン選択 ----
    ocrBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            ocrBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentOcrMode = btn.dataset.ocrMode || 'ai';
            const labels = { ai: 'AIのみ', ndlocr_ai: 'ndlocr+AI', ndlocr_only: 'ndlocr-only' };
            log(`OCRエンジン変更: ${labels[currentOcrMode] || currentOcrMode}`);
            applyConstraints();
        });
    });

    // ---- AI プロバイダー選択 ----
    aiBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            aiBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentAiProvider = btn.dataset.ai || 'gemini';
            log(`AIプロバイダー変更: ${currentAiProvider}`);
            applyModeConstraint();
        });
    });

    // ---- 処理モード選択 ----
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            modeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentProcessMode = btn.dataset.mode || 'sync';
            log(`処理モード変更: ${currentProcessMode === 'sync' ? '同期' : 'バッチ'}`);
        });
    });

    // ---- PDFテキスト優先選択 ----
    pdfTextBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            pdfTextBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPreferPdfText = btn.dataset.pdftext === 'true';
            log(`PDFテキスト優先: ${currentPreferPdfText ? 'On' : 'Off'}`);
        });
    });

    // ---- 自動改名選択 ----
    autoRenameBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            autoRenameBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentAutoRename = btn.dataset.autoRename !== 'false';
            log(`自動改名: ${currentAutoRename ? 'On' : 'Off'}`);
            applyConstraints();
        });
    });

    // ---- PDFページ抽出設定 ----
    pdfPageTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            pdfPageTypeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfPageType = btn.dataset.pdfPageType || 'pdf';
            log(`ページ種別: ${currentPdfPageType === 'printed' ? '印刷ページ' : 'PDFページ'}`);
        });
    });

    pdfTwoUpBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            pdfTwoUpBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfTwoUp = btn.dataset.pdfTwoUp === 'true';
            log(`2面割付: ${currentPdfTwoUp ? 'On' : 'Off'}`);
            applyConstraints();
        });
    });

    pdfDirectionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            pdfDirectionBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfDirection = btn.dataset.pdfDirection || 'ltr';
            log(`2面方向: ${currentPdfDirection === 'rtl' ? '右から左' : '左から右'}`);
        });
    });

    pdfPagesRunBtn.addEventListener('click', async () => {
        if (selectedPdfPageFiles.length === 0) {
            log('先にPDFファイルをドロップまたは選択してください。', 'error');
            return;
        }
        await executeWith(selectedPdfPageFiles);
    });

    // ---- コンテキストファイル参照 ----
    contextBrowseBtn.addEventListener('click', async () => {
        const filePath = await (window as any).electronAPI.openFileDialog();
        if (filePath) {
            contextFileInput.value = filePath;
            log(`コンテキストファイル設定: ${filePath}`);
        }
    });

    // ---- UI制約適用 ----
    function applyModeConstraint() {
        if (!isOcrTool(currentScript)) return;
        if (currentOcrMode === 'ndlocr_only') return; // applyConstraints が制御

        const claudeForced = currentAiProvider === 'claude';
        toggleMode.classList.toggle('disabled', claudeForced);
        labelMode.classList.toggle('disabled', claudeForced);
        modeBtns.forEach(b => {
            if (claudeForced) {
                b.classList.add('disabled');
            } else {
                b.classList.remove('disabled');
            }
        });

        if (claudeForced) {
            // Claude は同期固定
            modeBtns.forEach(b => b.classList.remove('active'));
            const syncBtn = document.querySelector<HTMLElement>('[data-mode="sync"]');
            if (syncBtn) syncBtn.classList.add('active');
            currentProcessMode = 'sync';
        }
    }

    function applyConstraints() {
        const ocr = isOcrTool(currentScript);
        const pdfPages = isPdfPagesTool(currentScript);
        const ndlocrOnly = currentOcrMode === 'ndlocr_only';
        const aiEnabled = ocr && (!ndlocrOnly || currentAutoRename);
        const modeEnabled = ocr && !ndlocrOnly;

        // OCRエンジントグル
        setGroupDisabled(toggleOcr, labelOcr, ocrBtns, !ocr);

        // AI / モード / PDFテキスト / バッチサイズ
        setGroupDisabled(toggleAi, labelAi, aiBtns, !aiEnabled);
        setGroupDisabled(toggleMode, labelMode, modeBtns, !modeEnabled);
        setGroupDisabled(togglePdfText, labelPdfText, pdfTextBtns, !ocr);
        setGroupDisabled(toggleAutoRename, labelAutoRename, autoRenameBtns, !ocr);
        batchSizeInput.disabled = !ocr;
        labelBatch.classList.toggle('disabled', !ocr);

        if (modeEnabled) applyModeConstraint();

        // houhi コンテキストファイル行
        const showContext = currentScript === 'ocr_houhi';
        contextRow.classList.toggle('hidden', !showContext);

        // 分割JSON入力行
        const showSplitJson = currentScript === 'split';
        splitJsonRow.classList.toggle('hidden', !showSplitJson);

        const showPdfPages = pdfPages;
        pdfPagesRow.classList.toggle('hidden', !showPdfPages);
        pdfDirectionBtns.forEach(b => b.classList.toggle('disabled', !currentPdfTwoUp));
        renderPdfPageFileList();
    }

    function setGroupDisabled(
        group: HTMLElement,
        label: HTMLElement,
        btns: NodeListOf<HTMLElement>,
        disabled: boolean
    ) {
        group.classList.toggle('disabled', disabled);
        label.classList.toggle('disabled', disabled);
        btns.forEach(b => b.classList.toggle('disabled', disabled));
    }

    // 初期状態
    applyConstraints();

    // ---- ドラッグ＆ドロップ ----
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer!.files).map(f => (window as any).electronAPI.getPathForFile(f));
        await handleFilesForCurrentTool(files);
    });

    // クリックでファイル選択
    dropZone.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async (e) => {
            const target = e.target as HTMLInputElement;
            const files = Array.from(target.files || []).map(f => (window as any).electronAPI.getPathForFile(f));
            if (files.length > 0) {
                await handleFilesForCurrentTool(files);
            }
        };
        input.click();
    });

    function basename(filePath: string): string {
        return String(filePath || '').split(/[\\/]/).pop() || filePath;
    }

    function setPdfPageFiles(files: string[]) {
        selectedPdfPageFiles = files
            .filter(f => /\.pdf$/i.test(f))
            .sort((a, b) => basename(a).localeCompare(basename(b), 'ja'));
        const nextRanges: Record<string, string> = {};
        for (const file of selectedPdfPageFiles) {
            nextRanges[file] = pdfPageRanges[file] || '';
        }
        pdfPageRanges = nextRanges;
        renderPdfPageFileList();
        if (selectedPdfPageFiles.length === 0) {
            log('PDFファイルを選択してください。', 'error');
        } else {
            log(`${selectedPdfPageFiles.length} 個のPDFをファイル名順で登録しました。ページ指定を確認して実行してください。`);
        }
    }

    function movePdfPageFile(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= selectedPdfPageFiles.length) return;
        if (toIndex < 0 || toIndex >= selectedPdfPageFiles.length) return;
        const [item] = selectedPdfPageFiles.splice(fromIndex, 1);
        selectedPdfPageFiles.splice(toIndex, 0, item);
        renderPdfPageFileList();
    }

    function removePdfPageFile(index: number) {
        const [removed] = selectedPdfPageFiles.splice(index, 1);
        if (removed) delete pdfPageRanges[removed];
        renderPdfPageFileList();
    }

    function renderPdfPageFileList() {
        if (!pdfPagesFileList) return;
        pdfPagesFileList.innerHTML = '';
        if (currentScript !== 'pdf_pages') return;

        if (selectedPdfPageFiles.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pdf-pages-empty';
            empty.textContent = 'PDFファイルをここへドロップ、または下のドロップゾーンで選択してください。';
            pdfPagesFileList.appendChild(empty);
            return;
        }

        for (let index = 0; index < selectedPdfPageFiles.length; index++) {
            const filePath = selectedPdfPageFiles[index];
            const row = document.createElement('div');
            row.className = 'pdf-pages-file-row';
            row.draggable = true;
            row.dataset.index = String(index);

            row.addEventListener('dragstart', () => {
                draggedPdfPageIndex = index;
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                row.classList.add('drag-over');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('drag-over');
                if (draggedPdfPageIndex === null) return;
                movePdfPageFile(draggedPdfPageIndex, index);
                draggedPdfPageIndex = null;
            });

            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'pdf-pages-icon-btn pdf-pages-drag-handle';
            handle.textContent = '≡';
            handle.title = 'ドラッグして並べ替え';

            const name = document.createElement('div');
            name.className = 'pdf-pages-file-name';
            name.title = filePath;
            name.textContent = basename(filePath);

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'context-input';
            input.placeholder = '1-3,7,8';
            input.value = pdfPageRanges[filePath] || '';
            input.addEventListener('input', () => {
                pdfPageRanges[filePath] = input.value.trim();
            });

            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'pdf-pages-icon-btn';
            upBtn.textContent = '↑';
            upBtn.title = '上へ移動';
            upBtn.disabled = index === 0;
            upBtn.addEventListener('click', () => movePdfPageFile(index, index - 1));

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'pdf-pages-icon-btn';
            downBtn.textContent = '↓';
            downBtn.title = '下へ移動';
            downBtn.disabled = index === selectedPdfPageFiles.length - 1;
            downBtn.addEventListener('click', () => movePdfPageFile(index, index + 1));

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'pdf-pages-icon-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'リストから外す';
            removeBtn.addEventListener('click', () => removePdfPageFile(index));

            row.appendChild(handle);
            row.appendChild(name);
            row.appendChild(input);
            row.appendChild(upBtn);
            row.appendChild(downBtn);
            row.appendChild(removeBtn);
            pdfPagesFileList.appendChild(row);
        }
    }

    async function executeWith(files: string[]) {
        log(`${files.length} 個のファイルを処理中 (${currentScript})...`);

        // 分割ツールの場合、JSONバリデーション
        if (currentScript === 'split') {
            const jsonText = splitJsonInput.value.trim();
            if (!jsonText) {
                log('分割定義JSONを入力してください。', 'error');
                return;
            }
            try {
                const parsed = JSON.parse(jsonText);
                if (!Array.isArray(parsed) || parsed.length === 0) {
                    log('JSONは空でない配列である必要があります。', 'error');
                    return;
                }
            } catch {
                log('JSONの形式が不正です。', 'error');
                return;
            }
        }

        if (currentScript === 'pdf_pages') {
            const pageInputs = files.map(file => (pdfPageRanges[file] || '').trim());
            if (pageInputs.some(value => !value)) {
                log('各PDFのページ指定を入力してください。例: 1-3,7,8', 'error');
                return;
            }
            if (pageInputs.some(value => !/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(value))) {
                log('ページ指定の形式が不正です。例: 1-3,7,8', 'error');
                return;
            }
        }

        setLoading(true);
        try {
            const result = await (window as any).electronAPI.executeScript(
                currentScript,
                files,
                currentAiProvider,
                currentProcessMode,
                currentOcrMode,
                currentPreferPdfText,
                currentAutoRename,
                parseInt(batchSizeInput.value, 10) || 4,
                contextFileInput.value.trim() || null,
                currentScript === 'split' ? splitJsonInput.value.trim() : null,
                currentScript === 'pdf_pages' ? {
                    filePages: files.map(file => ({ path: file, pages: (pdfPageRanges[file] || '').trim() })),
                    pageType: currentPdfPageType,
                    twoUp: currentPdfTwoUp,
                    direction: currentPdfDirection
                } : null
            );
            if (result.success) {
                log('処理が正常に完了しました。', 'success');
            } else {
                log(`処理失敗 (コード: ${result.code})`, 'error');
            }
        } catch (err: any) {
            log(`エラー: ${err.message}`, 'error');
        } finally {
            setLoading(false);
        }
    }

    // ---- IPC ログ受信 ----
    (window as any).electronAPI.onLog((msg: string) => log(msg));
    (window as any).electronAPI.onError((msg: string) => log(msg, 'error'));

    // ---- ログ出力ヘルパー ----
    function log(message: string, type = 'normal') {
        message.split('\n').forEach(subMsg => {
            if (!subMsg.trim()) return;
            const line = document.createElement('div');
            line.classList.add('log-line');
            if (type === 'error') line.classList.add('log-error');
            if (type === 'success') line.classList.add('log-success');
            line.textContent = subMsg;
            consoleOutput.appendChild(line);
        });
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    function setLoading(isLoading: boolean) {
        progressBar.style.width = isLoading ? '100%' : '0%';
    }
});
