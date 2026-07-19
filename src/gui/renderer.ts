document.addEventListener('DOMContentLoaded', () => {
    // ---- DOM 参照 ----
    const dropZone        = document.getElementById('dropZone') as HTMLElement;
    const dropText        = document.getElementById('dropText') as HTMLElement;
    const dropSubtext     = document.getElementById('dropSubtext') as HTMLElement;
    const consoleOutput   = document.getElementById('consoleOutput') as HTMLElement;
    const progressBar     = document.getElementById('progressBar') as HTMLElement;
    const toolCards       = document.querySelectorAll<HTMLElement>('.tool-card');
    const toolHelpBtns    = document.querySelectorAll<HTMLElement>('[data-tool-help]');
    const batchSizeInput  = document.getElementById('batchSizeInput') as HTMLInputElement;
    const splitJsonRow    = document.getElementById('splitJsonRow') as HTMLElement;
    const splitJsonInput  = document.getElementById('splitJsonInput') as HTMLTextAreaElement;
    const contextRow = document.getElementById('contextRow') as HTMLElement;
    const contextInput = document.getElementById('contextInput') as HTMLTextAreaElement;
    const pdfPagesRow     = document.getElementById('pdfPagesRow') as HTMLElement;
    const pdfPagesFileList = document.getElementById('pdfPagesFileList') as HTMLElement;
    const pdfPagesRunBtn  = document.getElementById('pdfPagesRunBtn') as HTMLButtonElement;
    const stitchRow       = document.getElementById('stitchRow') as HTMLElement;
    const stitchGroupSizeInput = document.getElementById('stitchGroupSizeInput') as HTMLInputElement;
    const stitchDpiInput  = document.getElementById('stitchDpiInput') as HTMLInputElement;
    const settingsBtn     = document.getElementById('settingsBtn') as HTMLButtonElement;
    const apiHelpBtn      = document.getElementById('apiHelpBtn') as HTMLButtonElement;
    const configModal     = document.getElementById('configModal') as HTMLElement;
    const configCloseBtn  = document.getElementById('configCloseBtn') as HTMLButtonElement;
    const configCancelBtn = document.getElementById('configCancelBtn') as HTMLButtonElement;
    const configSaveBtn   = document.getElementById('configSaveBtn') as HTMLButtonElement;
    const configReloadBtn = document.getElementById('configReloadBtn') as HTMLButtonElement;
    const cfgToolsRootBrowseBtn = document.getElementById('cfgToolsRootBrowseBtn') as HTMLButtonElement;
    const configStatus    = document.getElementById('configStatus') as HTMLElement;
    const configPathLabel = document.getElementById('configPathLabel') as HTMLElement;
    const configTabBtns   = document.querySelectorAll<HTMLElement>('[data-config-tab]');
    const configSettingsPane = document.getElementById('configSettingsPane') as HTMLElement;
    const configKeysPane     = document.getElementById('configKeysPane') as HTMLElement;
    const toolHelpModal   = document.getElementById('toolHelpModal') as HTMLElement;
    const toolHelpTitle   = document.getElementById('toolHelpTitle') as HTMLElement;
    const toolHelpBody    = document.getElementById('toolHelpBody') as HTMLElement;
    const toolHelpCloseBtn = document.getElementById('toolHelpCloseBtn') as HTMLButtonElement;
    const toolHelpOkBtn   = document.getElementById('toolHelpOkBtn') as HTMLButtonElement;

    const ocrBtns      = document.querySelectorAll<HTMLElement>('[data-ocr-mode]');
    const aiBtns       = document.querySelectorAll<HTMLElement>('[data-ai]');
    const modeBtns     = document.querySelectorAll<HTMLElement>('[data-mode]');
    const pdfTextBtns  = document.querySelectorAll<HTMLElement>('[data-pdftext]');
    const autoRenameBtns = document.querySelectorAll<HTMLElement>('[data-auto-rename]');
    const formattedRenameBtns = document.querySelectorAll<HTMLElement>('[data-skip-formatted-rename]');
    const silenceTrimBtns = document.querySelectorAll<HTMLElement>('[data-silence-trim]');
    const ocrTargetBtns = document.querySelectorAll<HTMLElement>('[data-ocr-target]');
    const audioModelBtns = document.querySelectorAll<HTMLElement>('[data-audio-model]');
    const pdfPageTypeBtns = document.querySelectorAll<HTMLElement>('[data-pdf-page-type]');
    const pdfTwoUpBtns = document.querySelectorAll<HTMLElement>('[data-pdf-two-up]');
    const pdfDirectionBtns = document.querySelectorAll<HTMLElement>('[data-pdf-direction]');

    const toggleAi     = document.getElementById('toggleAi') as HTMLElement;
    const toggleMode   = document.getElementById('toggleMode') as HTMLElement;
    const toggleOcr    = document.getElementById('toggleOcr') as HTMLElement;
    const toggleOcrTarget = document.getElementById('toggleOcrTarget') as HTMLElement;
    const toggleAudioModel = document.getElementById('toggleAudioModel') as HTMLElement;
    const togglePdfText = document.getElementById('togglePdfText') as HTMLElement;
    const toggleAutoRename = document.getElementById('toggleAutoRename') as HTMLElement;
    const toggleFormattedRename = document.getElementById('toggleFormattedRename') as HTMLElement;
    const toggleSilenceTrim = document.getElementById('toggleSilenceTrim') as HTMLElement;
    const labelAi      = document.getElementById('labelAi') as HTMLElement;
    const labelMode    = document.getElementById('labelMode') as HTMLElement;
    const labelOcr     = document.getElementById('labelOcr') as HTMLElement;
    const labelOcrTarget = document.getElementById('labelOcrTarget') as HTMLElement;
    const labelAudioModel = document.getElementById('labelAudioModel') as HTMLElement;
    const labelPdfText = document.getElementById('labelPdfText') as HTMLElement;
    const labelAutoRename = document.getElementById('labelAutoRename') as HTMLElement;
    const labelFormattedRename = document.getElementById('labelFormattedRename') as HTMLElement;
    const labelSilenceTrim = document.getElementById('labelSilenceTrim') as HTMLElement;
    const labelBatch   = document.getElementById('labelBatch') as HTMLElement;

    // ---- 状態 ----
    type ScriptKey = 'ocr' | 'transcribe_audio' | 'merge' | 'split' | 'deblank' | 'stitch' | 'pdf_pages';
    type OcrTarget = 'general' | 'houhi';
    let currentScript: ScriptKey = 'ocr';
    let currentOcrTarget: OcrTarget = 'general';
    let currentAudioModel = 'gemini:gemini-3.5-flash';
    let currentAiProvider = 'gemini';
    let currentProcessMode = 'sync';
    let currentOcrMode = 'ndlocr_ai'; // ai | ndlocr_ai | ndlocr_only
    let currentPreferPdfText = false;
    let currentAutoRename = false;
    let currentSkipFormattedRename = false;
    let currentSilenceTrim = false;
    let currentPdfPageType = 'pdf';  // pdf | printed
    let currentPdfTwoUp = false;
    let currentPdfDirection = 'ltr'; // ltr | rtl
    let selectedPdfPageFiles: string[] = [];
    let pdfPageRanges: Record<string, string> = {};
    let draggedPdfPageIndex: number | null = null;
    let loadedConfig: any = null;
    let loadedUserConfig: any = {};
    let loadedDefaults: any = {};
    const GUI_STATE_KEY = 'mimi-ocr-gui-state-v2';

    const isOcrTool = (key: string) => key === 'ocr';
    const isAudioTool = (key: string) => key === 'transcribe_audio';
    const isPdfPagesTool = (key: string) => key === 'pdf_pages';
    const isStitchTool = (key: string) => key === 'stitch';

    // ツール説明（ホバー表示）
    const toolDescriptions: Record<string, string> = {
        'ocr':         'PDF / Word / ODT / PPTX / 画像をOCR処理',
        'transcribe_audio': '音声を発言者分離つきでMarkdownへ変換',
        'merge':       'OCR済みMarkdownを1本に整える',
        'split':       '_paged.md をJSONの分割定義で文書ごとに分割',
        'deblank':     'OCR結果をもとに白紙ページを除去したPDFとMDを生成',
        'stitch':      '分割スキャンPDFを重なり検出で復元',
        'pdf_pages':   'OCR結果をもとにPDFページを抽出・結合・2面割付'
    };

    type ToolHelpPage = {
        title: string;
        summary: string;
        sections: { title: string; items: string[] }[];
    };

    const toolHelpPages: Record<ScriptKey, ToolHelpPage> = {
        ocr: {
            title: 'OCR',
            summary: 'PDF、Word、画像などを読み取り、検索しやすいMarkdown文章にします。紙の資料をテキスト化したいときに使います。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        'PDF、Word、ODT、PowerPoint、画像ファイルを入れられます。',
                        'フォルダを入れると、中の対応ファイルをまとめて処理します。'
                    ]
                },
                {
                    title: '主な設定',
                    items: [
                        '出力は、ふつうの文章なら「一般」、裁判資料の形に寄せるなら「法匪」を選びます。',
                        'OCRは、既定では「ndlocr+AI」を使います。テキスト主体のPDFでは「AIのみ」も選べます。',
                        'AIは、速さや料金を重視するならGemini、必要に応じてClaudeやOpenAIを選びます。',
                        'バッチは大量ページ向けです。止まりやすいときは「同期」に戻します。'
                    ]
                },
                {
                    title: '出てくるもの',
                    items: [
                        '元ファイルと同じ場所に、ページ付きのMarkdownが作られます。',
                        '自動改名をOnにすると、変更前のファイル名と内容を併せてファイル名を付け直します。'
                    ]
                }
            ]
        },
        transcribe_audio: {
            title: '音声認識',
            summary: '録音ファイルを読み取り、話した内容をMarkdownにします。会議、面談、裁判関係の録音などを文章にしたいときに使います。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        'm4a、mp3、wavなどの音声ファイルを入れます。',
                        '長い録音は時間がかかり、API料金も増えます。まず短いファイルで試すと安心です。'
                    ]
                },
                {
                    title: '主な設定',
                    items: [
                        '音声AIは、Gemini、OpenAI、Reazon K2を選びます。',
                        '出力は、ふつうの議事録なら「一般」、反訳書風にしたいなら「法匪」を選びます。',
                        '無音カットをOnにすると、長い沈黙を先に短くしてからAIへ送ります。'
                    ]
                },
                {
                    title: '出てくるもの',
                    items: [
                        '録音内容を書き起こしたMarkdownが作られます。',
                        '話者分離に対応したモデルでは、話している人ごとに分かれた形を目指します。'
                    ]
                }
            ]
        },
        merge: {
            title: 'MD結合',
            summary: 'OCR結果に入っているページ区切りを整理し、読みやすい1本のMarkdownにまとめます。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        'OCRで作られた「_paged.md」のMarkdownを入れます。',
                        'フォルダを入れると、中の対象Markdownをまとめて処理します。'
                    ]
                },
                {
                    title: '使う場面',
                    items: [
                        'ページごとの区切りより、本文を続けて読みたいときに使います。',
                        'OCR後の文章を整理して、検索や引用をしやすくしたいときに向いています。'
                    ]
                },
                {
                    title: '注意',
                    items: [
                        '元のPDFを直接読むツールではありません。先にOCRを済ませてください。',
                        'ページ番号情報を完全に消したい用途ではなく、本文を読みやすく整える用途です。'
                    ]
                }
            ]
        },
        split: {
            title: '文書分割',
            summary: '1つの長いPDFやOCR結果を、指定したページ範囲ごとに別々の文書へ分けます。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        '分割したいPDF、またはOCR後のMarkdownを入れます。',
                        'どこで分けるかは「分割定義JSON」に書きます。'
                    ]
                },
                {
                    title: 'JSONの考え方',
                    items: [
                        '1つの文書につき、ファイル名、開始ページ、終了ページを書きます。',
                        '例は画面の入力欄にあります。まずは1件だけ書いて試すと分かりやすいです。'
                    ]
                },
                {
                    title: '注意',
                    items: [
                        'ページ番号を間違えると、違うページが別文書に入ります。',
                        '大事な資料は、分割後にページが抜けていないか確認してください。'
                    ]
                }
            ]
        },
        deblank: {
            title: '白紙除去',
            summary: 'OCR結果を見ながら、ほぼ白紙のページを取り除いたPDFとMarkdownを作ります。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        '白紙を取り除きたいPDFを入れます。',
                        '同じ場所に、そのPDFのOCR結果Markdownがある必要があります。'
                    ]
                },
                {
                    title: '使う場面',
                    items: [
                        'スキャンした資料に白紙ページが多いときに使います。',
                        '提出用や確認用に、ページ数を減らしたPDFを作りたいときに便利です。'
                    ]
                },
                {
                    title: '注意',
                    items: [
                        '少しだけ文字があるページは白紙ではないと判断されることがあります。',
                        '処理後のPDFとMarkdownを見て、必要なページが残っているか確認してください。'
                    ]
                }
            ]
        },
        stitch: {
            title: '分割復元',
            summary: 'A4スキャナで読んだB4/A3や、A3スキャナで読んだA2など、分割スキャンしたページを重なり部分から位置合わせして1ページのPDFに戻します。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        '分割スキャン済みのPDFを入れます。',
                        '既定では隣り合うページの重なりを見て、自動で1ページ分のまとまりを判定します。'
                    ]
                },
                {
                    title: '主な設定',
                    items: [
                        '分割枚数とDPIは通常autoのままで十分です。うまく分かれない場合だけ、B4左右分割なら分割枚数を2にします。',
                        '位置合わせは内蔵エンジンで行います。追加ソフトのインストールは不要です。'
                    ]
                },
                {
                    title: '出てくるもの',
                    items: [
                        '元PDFと同じ場所に、復元後のPDFと位置合わせレポートが作られます。',
                        '隣り合うスキャンに重なりがないと自動復元できません。少し重ねてスキャンしてください。'
                    ]
                }
            ]
        },
        pdf_pages: {
            title: 'PDF抽出',
            summary: 'OCR結果を手がかりにして、PDFから必要なページだけを抜き出します。複数PDFを順番に並べることもできます。',
            sections: [
                {
                    title: '入れるファイル',
                    items: [
                        '抽出したいPDFを入れます。',
                        '同じ場所に、そのPDFのOCR結果Markdownがある必要があります。'
                    ]
                },
                {
                    title: 'ページ指定',
                    items: [
                        '各PDFの右側に、取り出したいページ番号を書きます。例: 1-3,7,10',
                        '「PDF」はPDFそのもののページ番号、「印刷」は紙に印字されたページ番号を使う考え方です。',
                        '2面割付のPDFでは「2面」をOnにし、読む方向を選びます。'
                    ]
                },
                {
                    title: '出てくるもの',
                    items: [
                        '指定ページだけをまとめたPDFが作られます。',
                        '対応するMarkdownも作られ、ページ番号が抽出後の順番に直されます。'
                    ]
                }
            ]
        }
    };

    function inputValue(id: string) {
        return (document.getElementById(id) as HTMLInputElement).value.trim();
    }

    function setInputValue(id: string, value: any) {
        (document.getElementById(id) as HTMLInputElement).value = String(value ?? '');
    }

    function positiveInt(value: any, fallback: number, min = 1, max = 999) {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed) || parsed < min) return fallback;
        return Math.min(parsed, max);
    }

    function positiveNumber(value: any, fallback: number, min = 0.1, max = 0.98) {
        const parsed = Number.parseFloat(String(value ?? ''));
        if (!Number.isFinite(parsed) || parsed < min) return fallback;
        return Math.min(parsed, max);
    }

    function pdfImageFormat(value: any) {
        return String(value || '').trim().toLowerCase() === 'png' ? 'png' : 'jpeg';
    }

    function intOrAuto(value: any, fallback: number, min = 1, max = 999) {
        const text = String(value ?? '').trim().toLowerCase();
        if (text === 'auto' || text === '') return 'auto';
        return positiveInt(text, fallback, min, max);
    }

    function isPlainObject(value: any) {
        return value && typeof value === 'object' && !Array.isArray(value);
    }

    function mergeConfig(base: any, override: any): any {
        const result = JSON.parse(JSON.stringify(base || {}));
        if (!isPlainObject(override)) return result;
        Object.entries(override).forEach(([key, value]) => {
            if (isPlainObject(value) && isPlainObject(result[key])) {
                result[key] = mergeConfig(result[key], value);
            } else {
                result[key] = value;
            }
        });
        return result;
    }

    function deepEqual(a: any, b: any) {
        if (a === b) return true;
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
            return a.every((value, index) => deepEqual(value, b[index]));
        }
        if (isPlainObject(a) || isPlainObject(b)) {
            if (!isPlainObject(a) || !isPlainObject(b)) return false;
            const aKeys = Object.keys(a).sort();
            const bKeys = Object.keys(b).sort();
            if (!deepEqual(aKeys, bKeys)) return false;
            return aKeys.every(key => deepEqual(a[key], b[key]));
        }
        return false;
    }

    function assignIfObjectChanged(config: any, key: string, value: any, defaultValue: any) {
        if (isPlainObject(value) && !deepEqual(value, defaultValue)) {
            config[key] = value;
        }
    }

    function setConfigStatus(message: string, type: 'normal' | 'success' | 'error' = 'normal') {
        configStatus.textContent = message;
        configStatus.classList.toggle('success', type === 'success');
        configStatus.classList.toggle('error', type === 'error');
    }

    function showConfigTab(tab: string) {
        const selected = tab === 'keys' ? 'keys' : 'settings';
        configTabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.configTab === selected));
        configSettingsPane.classList.toggle('hidden', selected !== 'settings');
        configKeysPane.classList.toggle('hidden', selected !== 'keys');
    }

    function clearElement(element: HTMLElement) {
        while (element.firstChild) element.removeChild(element.firstChild);
    }

    function appendTextElement(parent: HTMLElement, tagName: string, className: string, text: string) {
        const element = document.createElement(tagName);
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }

    function renderToolHelp(script: ScriptKey) {
        const page = toolHelpPages[script] || toolHelpPages.ocr;
        toolHelpTitle.textContent = `${page.title} のヘルプ`;
        clearElement(toolHelpBody);
        appendTextElement(toolHelpBody, 'div', 'tool-help-summary', page.summary);

        page.sections.forEach(section => {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'tool-help-section';
            appendTextElement(sectionEl, 'h3', '', section.title);
            const list = document.createElement('ul');
            section.items.forEach(item => {
                appendTextElement(list, 'li', '', item);
            });
            sectionEl.appendChild(list);
            toolHelpBody.appendChild(sectionEl);
        });
    }

    function openToolHelp(script: ScriptKey) {
        renderToolHelp(script);
        toolHelpModal.classList.remove('hidden');
    }

    function closeToolHelpModal() {
        toolHelpModal.classList.add('hidden');
    }

    function populateConfigForm(config: any) {
        const providers = config?.providers || {};
        const gemini = providers.gemini || {};
        const openai = providers.openai || {};
        const claude = providers.claude || {};
        const ndlocrLite = config?.tools?.ndlocrLite || {};
        const stitchEngine = config?.tools?.stitchEngine || {};
        const reazonK2 = config?.tools?.reazonK2 || {};
        const toolsRootDir = config?.tools?.rootDir || '';

        setInputValue('cfgGeminiApiKey', gemini.apiKey || '');
        setInputValue('cfgGeminiChatModel', gemini.chatModel || 'gemini-2.5-flash-preview');
        setInputValue('cfgGeminiTranscriptionModel', gemini.transcriptionModel || 'gemini-3.5-flash');
        setInputValue('cfgOpenaiApiKey', openai.apiKey || '');
        setInputValue('cfgOpenaiChatModel', openai.chatModel || 'gpt-4o');
        setInputValue('cfgOpenaiTranscriptionModel', openai.transcriptionModel || 'gpt-4o-transcribe-diarize');
        setInputValue('cfgClaudeApiKey', claude.apiKey || '');
        setInputValue('cfgClaudeChatModel', claude.chatModel || 'claude-opus-4-8');

        setInputValue('cfgToolsRootDir', toolsRootDir);
        setInputValue('cfgNdlocrParallelJobs', ndlocrLite.parallelJobs || 'auto');
        setInputValue('cfgNdlocrPageChunkSize', positiveInt(ndlocrLite.pageChunkSize, 8, 1, 200));
        setInputValue('cfgNdlocrImageDpi', positiveInt(ndlocrLite.imageDpi, 300, 72, 600));
        setInputValue('cfgStitchImageDpi', stitchEngine.imageDpi === 'auto' ? 'auto' : positiveInt(stitchEngine.imageDpi, 300, 72, 600));
        setInputValue('cfgStitchPdfImageFormat', pdfImageFormat(stitchEngine.pdfImageFormat));
        setInputValue('cfgStitchJpegQuality', positiveNumber(stitchEngine.jpegQuality, 0.86, 0.1, 0.98));
        setInputValue('cfgReazonPythonPath', reazonK2.pythonPath || '');
        setInputValue('cfgReazonLanguage', reazonK2.language || 'ja');
        setInputValue('cfgReazonDevice', reazonK2.device || 'cpu');
        setInputValue('cfgReazonPrecision', reazonK2.precision || 'fp32');
        setInputValue('cfgReazonChunkSec', positiveNumber(reazonK2.chunkSeconds, 25, 5, 120));
    }

    function readConfigForm() {
        const defaults = isPlainObject(loadedDefaults) ? loadedDefaults : {};
        const previousUser = isPlainObject(loadedUserConfig) ? loadedUserConfig : {};
        const defaultProviders = defaults.providers || {};
        const defaultTools = defaults.tools || {};
        const previousTools = isPlainObject(previousUser.tools) ? previousUser.tools : {};

        const config: any = {
            providers: {},
        };

        function readProvider(providerName: string, fields: Record<string, string>) {
            const provider: any = {};
            const defaultsForProvider = defaultProviders[providerName] || {};
            const apiKey = inputValue(fields.apiKey);
            if (apiKey) provider.apiKey = apiKey;

            Object.entries(fields).forEach(([fieldName, inputId]) => {
                if (fieldName === 'apiKey') return;
                const value = inputValue(inputId);
                if (value && value !== defaultsForProvider[fieldName]) {
                    provider[fieldName] = value;
                }
            });

            if (Object.keys(provider).length > 0) {
                config.providers[providerName] = provider;
            }
        }

        readProvider('gemini', {
            apiKey: 'cfgGeminiApiKey',
            chatModel: 'cfgGeminiChatModel',
            transcriptionModel: 'cfgGeminiTranscriptionModel',
        });
        readProvider('openai', {
            apiKey: 'cfgOpenaiApiKey',
            chatModel: 'cfgOpenaiChatModel',
            transcriptionModel: 'cfgOpenaiTranscriptionModel',
        });
        readProvider('claude', {
            apiKey: 'cfgClaudeApiKey',
            chatModel: 'cfgClaudeChatModel',
        });

        if (Object.keys(config.providers).length === 0) {
            delete config.providers;
        }

        const ndlocrLite = {
            parallelJobs: inputValue('cfgNdlocrParallelJobs') || 'auto',
            pageChunkSize: positiveInt(inputValue('cfgNdlocrPageChunkSize'), 8, 1, 200),
            imageDpi: positiveInt(inputValue('cfgNdlocrImageDpi'), 300, 72, 600),
        };
        const stitchEngine = {
            imageDpi: intOrAuto(inputValue('cfgStitchImageDpi'), 300, 72, 600),
            deskew: 'auto',
            pdfImageFormat: pdfImageFormat(inputValue('cfgStitchPdfImageFormat')),
            jpegQuality: positiveNumber(inputValue('cfgStitchJpegQuality'), 0.86, 0.1, 0.98),
        };
        const reazonK2 = {
            pythonPath: inputValue('cfgReazonPythonPath'),
            basePythonPath: '',
            language: normalizeReazonLanguage(inputValue('cfgReazonLanguage')),
            device: normalizeReazonDevice(inputValue('cfgReazonDevice')),
            precision: normalizeReazonPrecision(inputValue('cfgReazonPrecision')),
            chunkSeconds: positiveNumber(inputValue('cfgReazonChunkSec'), 25, 5, 120),
            autoInstall: true,
            cacheDir: '',
        };
        const tools: any = {};
        Object.entries(previousTools).forEach(([key, value]) => {
            if (key !== 'rootDir' && key !== 'ndlocrLite' && key !== 'stitchEngine' && key !== 'reazonK2') {
                tools[key] = value;
            }
        });
        const toolsRootDir = inputValue('cfgToolsRootDir');
        if (toolsRootDir && toolsRootDir !== (defaultTools.rootDir || '')) {
            tools.rootDir = toolsRootDir;
        }
        if (!deepEqual(ndlocrLite, defaultTools.ndlocrLite || {})) {
            tools.ndlocrLite = ndlocrLite;
        }
        if (!deepEqual(stitchEngine, defaultTools.stitchEngine || {})) {
            tools.stitchEngine = stitchEngine;
        }
        if (!deepEqual(reazonK2, defaultTools.reazonK2 || {})) {
            tools.reazonK2 = reazonK2;
        }
        if (Object.keys(tools).length > 0) {
            config.tools = tools;
        }

        assignIfObjectChanged(config, 'ocr', previousUser.ocr, defaults.ocr);
        assignIfObjectChanged(config, 'transcription', previousUser.transcription, defaults.transcription);

        loadedUserConfig = config;
        loadedConfig = mergeConfig(defaults, config);
        return config;
    }

    async function loadConfigIntoModal() {
        setConfigStatus('読み込み中...');
        try {
            const result = await (window as any).electronAPI.loadConfig();
            loadedConfig = result.config || {};
            loadedUserConfig = result.userConfig || {};
            loadedDefaults = result.defaults || {};
            configPathLabel.textContent = result.path || '';
            populateConfigForm(loadedConfig);
            setConfigStatus(result.exists ? '読み込みました。' : 'config.json は未作成です。保存すると作成します。', 'success');
        } catch (err: any) {
            setConfigStatus(`読み込みに失敗しました: ${err.message}`, 'error');
        }
    }

    async function saveConfigFromModal() {
        setConfigStatus('保存中...');
        try {
            const config = readConfigForm();
            const result = await (window as any).electronAPI.saveConfig(config);
            configPathLabel.textContent = result.path || configPathLabel.textContent;
            setConfigStatus('保存しました。次の実行から反映されます。', 'success');
            log('config.json を保存しました。', 'success');
        } catch (err: any) {
            setConfigStatus(`保存に失敗しました: ${err.message}`, 'error');
        }
    }

    async function openConfigModal(tab: 'settings' | 'keys' = 'settings') {
        configModal.classList.remove('hidden');
        showConfigTab(tab);
        if (!loadedConfig) await loadConfigIntoModal();
    }

    function closeConfigModal() {
        configModal.classList.add('hidden');
    }

    settingsBtn.addEventListener('click', () => {
        openConfigModal('settings');
    });

    apiHelpBtn.addEventListener('click', () => {
        openConfigModal('keys');
    });

    function handleConfigCloseClick(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        closeConfigModal();
    }

    configCloseBtn.addEventListener('click', handleConfigCloseClick);
    configCancelBtn.addEventListener('click', handleConfigCloseClick);
    configSaveBtn.addEventListener('click', saveConfigFromModal);
    configReloadBtn.addEventListener('click', loadConfigIntoModal);
    cfgToolsRootBrowseBtn.addEventListener('click', async () => {
        try {
            const result = await (window as any).electronAPI.chooseToolsRoot({
                title: '外部ツールの保存先を選択'
            });
            if (!result?.success) {
                setConfigStatus('保存先の選択をキャンセルしました。');
                return;
            }
            setInputValue('cfgToolsRootDir', result.toolsRoot || '');
            if (result.userConfig) {
                loadedUserConfig = result.userConfig;
                loadedConfig = mergeConfig(loadedDefaults || {}, loadedUserConfig || {});
            }
            configPathLabel.textContent = result.configPath || configPathLabel.textContent;
            setConfigStatus('外部ツールの保存先を保存しました。', 'success');
        } catch (err: any) {
            setConfigStatus(`保存先を選べませんでした: ${err.message}`, 'error');
        }
    });
    toolHelpCloseBtn.addEventListener('click', closeToolHelpModal);
    toolHelpOkBtn.addEventListener('click', closeToolHelpModal);

    configModal.addEventListener('click', (event) => {
        if (event.target === configModal) closeConfigModal();
    });

    toolHelpModal.addEventListener('click', (event) => {
        if (event.target === toolHelpModal) closeToolHelpModal();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!toolHelpModal.classList.contains('hidden')) {
            closeToolHelpModal();
        } else if (!configModal.classList.contains('hidden')) {
            closeConfigModal();
        }
    });

    configTabBtns.forEach(btn => {
        btn.addEventListener('click', () => showConfigTab(btn.dataset.configTab || 'settings'));
    });

    configModal.addEventListener('click', async (event) => {
        const target = event.target as HTMLElement;
        const button = target.closest('[data-open-url]') as HTMLElement | null;
        if (!button) return;
        const url = button.dataset.openUrl || '';
        try {
            await (window as any).electronAPI.openExternalUrl(url);
        } catch (err: any) {
            setConfigStatus(`リンクを開けませんでした: ${err.message}`, 'error');
        }
    });

    toolHelpBtns.forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openToolHelp((btn.dataset.toolHelp as ScriptKey) || currentScript);
        });
    });

    // ---- ツール選択 ----
    function selectTool(script: ScriptKey, card: HTMLElement) {
        toolCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        currentScript = script;
        log(`ツール変更: ${card.querySelector<HTMLElement>('.tool-name')!.textContent}`);
        applyConstraints();
        saveGuiState();
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

    // ---- OCR出力スタイル選択 ----
    ocrTargetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            ocrTargetBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentOcrTarget = (btn.dataset.ocrTarget as OcrTarget) || 'general';
            log(`OCR出力変更: ${currentOcrTarget === 'houhi' ? '法匪' : '一般'}`);
            applyConstraints();
            saveGuiState();
        });
    });

    // ---- 音声認識モデル選択 ----
    audioModelBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            audioModelBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentAudioModel = btn.dataset.audioModel || 'gemini:gemini-3.5-flash';
            log(`音声AI変更: ${btn.textContent || currentAudioModel}`);
            saveGuiState();
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
            saveGuiState();
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
            saveGuiState();
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
            saveGuiState();
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
            saveGuiState();
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
            saveGuiState();
        });
    });

    // ---- 形式済みファイルの自動改名 ----
    formattedRenameBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            formattedRenameBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentSkipFormattedRename = btn.dataset.skipFormattedRename === 'true';
            log(`形式済みファイル: ${currentSkipFormattedRename ? 'スキップ' : '再判定'}`);
            saveGuiState();
        });
    });

    // ---- 無音カット選択 ----
    silenceTrimBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            silenceTrimBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentSilenceTrim = btn.dataset.silenceTrim === 'true';
            log(`無音カット: ${currentSilenceTrim ? 'On' : 'Off'}`);
            saveGuiState();
        });
    });

    // ---- PDFページ抽出設定 ----
    pdfPageTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            pdfPageTypeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfPageType = btn.dataset.pdfPageType || 'pdf';
            log(`ページ種別: ${currentPdfPageType === 'printed' ? '印刷ページ' : 'PDFページ'}`);
            saveGuiState();
        });
    });

    pdfTwoUpBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            pdfTwoUpBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfTwoUp = btn.dataset.pdfTwoUp === 'true';
            log(`2面割付: ${currentPdfTwoUp ? 'On' : 'Off'}`);
            applyConstraints();
            saveGuiState();
        });
    });

    pdfDirectionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('disabled')) return;
            pdfDirectionBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPdfDirection = btn.dataset.pdfDirection || 'ltr';
            log(`2面方向: ${currentPdfDirection === 'rtl' ? '右から左' : '左から右'}`);
            saveGuiState();
        });
    });

    pdfPagesRunBtn.addEventListener('click', async () => {
        if (selectedPdfPageFiles.length === 0) {
            log('先にPDFファイルをドロップまたは選択してください。', 'error');
            return;
        }
        await executeWith(selectedPdfPageFiles);
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
        const audio = isAudioTool(currentScript);
        const pdfPages = isPdfPagesTool(currentScript);
        const stitch = isStitchTool(currentScript);
        const ndlocrOnly = currentOcrMode === 'ndlocr_only';
        const aiEnabled = ocr && (!ndlocrOnly || currentAutoRename);
        const modeEnabled = (ocr && !ndlocrOnly) || audio;
        const batchEnabled = ocr || audio;
        const autoRenameEnabled = ocr || audio;

        // OCRエンジントグル
        setGroupDisabled(toggleOcr, labelOcr, ocrBtns, !ocr);
        setGroupDisabled(toggleOcrTarget, labelOcrTarget, ocrTargetBtns, !(ocr || audio));
        setGroupDisabled(toggleAudioModel, labelAudioModel, audioModelBtns, !audio);

        // AI / モード / PDFテキスト / バッチサイズ
        setGroupDisabled(toggleAi, labelAi, aiBtns, !aiEnabled);
        setGroupDisabled(toggleMode, labelMode, modeBtns, !modeEnabled);
        setGroupDisabled(togglePdfText, labelPdfText, pdfTextBtns, !ocr);
        setGroupDisabled(toggleAutoRename, labelAutoRename, autoRenameBtns, !autoRenameEnabled);
        setGroupDisabled(toggleFormattedRename, labelFormattedRename, formattedRenameBtns, !autoRenameEnabled || !currentAutoRename);
        setGroupDisabled(toggleSilenceTrim, labelSilenceTrim, silenceTrimBtns, !audio);
        batchSizeInput.disabled = !batchEnabled;
        labelBatch.classList.toggle('disabled', !batchEnabled);

        if (ocr && modeEnabled) applyModeConstraint();

        // 分割JSON入力行
        const showSplitJson = currentScript === 'split';
        splitJsonRow.classList.toggle('hidden', !showSplitJson);
        contextRow.classList.toggle('hidden', !(ocr || audio));
        stitchRow.classList.toggle('hidden', !stitch);

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

    function setActiveByData(btns: NodeListOf<HTMLElement>, dataKey: string, value: string) {
        btns.forEach(btn => {
            const active = btn.dataset[dataKey] === value;
            btn.classList.toggle('active', active);
        });
    }

    function saveGuiState() {
        try {
            localStorage.setItem(GUI_STATE_KEY, JSON.stringify({
                currentScript,
                currentOcrTarget,
                currentAudioModel,
                currentAiProvider,
                currentProcessMode,
                currentOcrMode,
                currentPreferPdfText,
                currentAutoRename,
                currentSkipFormattedRename,
                currentSilenceTrim,
                currentPdfPageType,
                currentPdfTwoUp,
                currentPdfDirection,
                stitchGroupSize: stitchGroupSizeInput.value || 'auto',
                stitchDpi: stitchDpiInput.value || 'auto',
                batchSize: batchSizeInput.value,
                contextText: contextInput.value,
            }));
        } catch (_err) {
        }
    }

    function restoreGuiState() {
        try {
            const raw = localStorage.getItem(GUI_STATE_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);
            currentScript = (state.currentScript || currentScript) as ScriptKey;
            currentOcrTarget = (state.currentOcrTarget || currentOcrTarget) as OcrTarget;
            currentAudioModel = state.currentAudioModel || currentAudioModel;
            currentAiProvider = state.currentAiProvider || currentAiProvider;
            currentProcessMode = state.currentProcessMode || currentProcessMode;
            currentOcrMode = state.currentOcrMode || currentOcrMode;
            currentPreferPdfText = state.currentPreferPdfText === true;
            currentAutoRename = state.currentAutoRename === true;
            currentSkipFormattedRename = state.currentSkipFormattedRename === true;
            currentSilenceTrim = state.currentSilenceTrim === true;
            currentPdfPageType = state.currentPdfPageType || currentPdfPageType;
            currentPdfTwoUp = state.currentPdfTwoUp === true;
            currentPdfDirection = state.currentPdfDirection || currentPdfDirection;
            stitchGroupSizeInput.value = String(state.stitchGroupSize || stitchGroupSizeInput.value || 'auto');
            stitchDpiInput.value = String(state.stitchDpi || stitchDpiInput.value || 'auto');
            batchSizeInput.value = String(state.batchSize || batchSizeInput.value || '4');
            contextInput.value = String(state.contextText || '');

            toolCards.forEach(card => card.classList.toggle('active', card.dataset.script === currentScript));
            setActiveByData(ocrTargetBtns, 'ocrTarget', currentOcrTarget);
            setActiveByData(audioModelBtns, 'audioModel', currentAudioModel);
            setActiveByData(aiBtns, 'ai', currentAiProvider);
            setActiveByData(modeBtns, 'mode', currentProcessMode);
            setActiveByData(ocrBtns, 'ocrMode', currentOcrMode);
            setActiveByData(pdfTextBtns, 'pdftext', String(currentPreferPdfText));
            setActiveByData(autoRenameBtns, 'autoRename', String(currentAutoRename));
            setActiveByData(formattedRenameBtns, 'skipFormattedRename', String(currentSkipFormattedRename));
            setActiveByData(silenceTrimBtns, 'silenceTrim', String(currentSilenceTrim));
            setActiveByData(pdfPageTypeBtns, 'pdfPageType', currentPdfPageType);
            setActiveByData(pdfTwoUpBtns, 'pdfTwoUp', String(currentPdfTwoUp));
            setActiveByData(pdfDirectionBtns, 'pdfDirection', currentPdfDirection);
        } catch (_err) {
        }
    }

    batchSizeInput.addEventListener('input', saveGuiState);
    contextInput.addEventListener('input', saveGuiState);
    stitchGroupSizeInput.addEventListener('input', saveGuiState);
    stitchDpiInput.addEventListener('input', saveGuiState);

    // 初期状態
    restoreGuiState();
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

    function currentTaskNeedsGemini() {
        if (currentScript === 'transcribe_audio') {
            return parseAudioModel(currentAudioModel).provider === 'gemini';
        }
        if (currentScript !== 'ocr') return false;
        const ndlocrOnly = currentOcrMode === 'ndlocr_only';
        return currentAiProvider === 'gemini' && (!ndlocrOnly || currentAutoRename);
    }

    function currentTaskNeedsNdlocr() {
        return currentScript === 'ocr' && (currentOcrMode === 'ndlocr_ai' || currentOcrMode === 'ndlocr_only');
    }

    async function ensureSetupBeforeExecute() {
        let status: any = null;
        try {
            status = await (window as any).electronAPI.getSetupStatus();
        } catch (err: any) {
            log(`セットアップ状態を確認できませんでした: ${err.message}`, 'error');
            return false;
        }

        if (currentTaskNeedsGemini() && !status?.hasGeminiApiKey) {
            log('Gemini APIキーが未設定です。APIキーを作成し、設定の Gemini APIキーへ貼って保存してください。', 'error');
            log('Google AI Studio の APIキー作成ページは「APIキーの取り方」タブから開けます。');
            await openConfigModal('keys');
            setConfigStatus('Gemini APIキーを作成し、config.json タブの Gemini APIキー欄へ貼って保存してください。', 'error');
            return false;
        }

        if (currentTaskNeedsNdlocr() && !status?.ndlocrInstalled) {
            log('ndlocr-lite が未準備です。アプリ標準の保存先へ自動準備します。');
            let result: any = null;
            try {
                result = await (window as any).electronAPI.prepareNdlocrRoot();
            } catch (err: any) {
                log(`ndlocr-lite の保存先を準備できませんでした: ${err.message}`, 'error');
                return false;
            }
            if (!result?.success) {
                log('ndlocr-lite の準備をキャンセルしました。', 'error');
                return false;
            }
            if (result.userConfig) {
                loadedUserConfig = result.userConfig;
                loadedConfig = isPlainObject(loadedDefaults) && Object.keys(loadedDefaults).length > 0
                    ? mergeConfig(loadedDefaults || {}, loadedUserConfig || {})
                    : null;
            }
            log(`ndlocr-lite の保存先: ${result.toolsRoot}`);
            log('このあと GitHub から ndlocr-lite を自動取得します。初回だけ時間がかかります。');
        }

        return true;
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

        if (currentScript === 'stitch') {
            if (files.some(file => !/\.pdf$/i.test(file))) {
                log('分割復元にはPDFファイルを指定してください。', 'error');
                return;
            }
            const groupSizeText = stitchGroupSizeInput.value.trim().toLowerCase();
            const dpiText = stitchDpiInput.value.trim().toLowerCase();
            if (groupSizeText !== '' && groupSizeText !== 'auto' && positiveInt(groupSizeText, 0, 2, 20) < 2) {
                log('分割枚数は auto または2以上にしてください。', 'error');
                return;
            }
            if (dpiText !== '' && dpiText !== 'auto' && positiveInt(dpiText, 0, 72, 600) < 72) {
                log('DPIは auto または72以上にしてください。', 'error');
                return;
            }
        }

        const audioOptions = parseAudioModel(currentAudioModel);

        if (!await ensureSetupBeforeExecute()) {
            return;
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
                currentSkipFormattedRename,
                parseInt(batchSizeInput.value, 10) || 4,
                currentOcrTarget,
                audioOptions,
                currentSilenceTrim,
                (currentScript === 'ocr' || currentScript === 'transcribe_audio') ? contextInput.value.trim() : null,
                currentScript === 'split' ? splitJsonInput.value.trim() : null,
                currentScript === 'pdf_pages' ? {
                    filePages: files.map(file => ({ path: file, pages: (pdfPageRanges[file] || '').trim() })),
                    pageType: currentPdfPageType,
                    twoUp: currentPdfTwoUp,
                    direction: currentPdfDirection
                } : null,
                currentScript === 'stitch' ? {
                    groupSize: intOrAuto(stitchGroupSizeInput.value, 2, 2, 20),
                    dpi: intOrAuto(stitchDpiInput.value, 300, 72, 600)
                } : null
            );
            if (result.success) {
                log('処理が正常に完了しました。', 'success');
            } else if (result.setupRequired === 'gemini-api-key') {
                log(result.message || 'Gemini APIキーが未設定です。', 'error');
                await openConfigModal('keys');
                setConfigStatus('Gemini APIキーを作成し、config.json タブの Gemini APIキー欄へ貼って保存してください。', 'error');
            } else {
                log(`処理失敗 (コード: ${result.code})`, 'error');
            }
            saveGuiState();
        } catch (err: any) {
            log(`エラー: ${err.message}`, 'error');
        } finally {
            setLoading(false);
        }
    }

    function parseAudioModel(value: string) {
        const [provider, model, postprocessAi] = String(value || 'gemini:gemini-3.5-flash').split(':');
        if (provider === 'reazon-k2') {
            return {
                provider: 'reazon-k2',
                model: normalizeReazonLanguage(model || 'ja'),
                postprocessAi: postprocessAi || 'auto',
            };
        }
        return {
            provider: provider === 'gemini' ? 'gemini' : 'openai',
            model: model || (provider === 'gemini' ? 'gemini-3.5-flash' : 'gpt-4o-transcribe-diarize'),
        };
    }

    function normalizeReazonLanguage(value: string) {
        const text = String(value || '').trim().toLowerCase();
        return text === 'ja-en' || text === 'ja-en-mls-5k' ? text : 'ja';
    }

    function normalizeReazonDevice(value: string) {
        const text = String(value || '').trim().toLowerCase();
        return text === 'cuda' || text === 'coreml' ? text : 'cpu';
    }

    function normalizeReazonPrecision(value: string) {
        const text = String(value || '').trim().toLowerCase();
        return text === 'int8' || text === 'int8-fp32' ? text : 'fp32';
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
