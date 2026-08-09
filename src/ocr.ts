/**
 * mimi-ocr: 日本語文書の OCR・テキスト抽出ツール。
 * AIプロバイダーとして Gemini / Claude / OpenAI を利用できます。
 *
 * 入力:
 * - `.pdf`
 * - `.docx`
 * - `.doc`
 * - `.odt`
 * - `.pptx`
 * - 画像ファイル（`.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, `.webp`）
 * - 上記ファイルを含むディレクトリ
 *
 * 出力:
 * - PDF は `<元ファイル名>_paged.md` を作成します。
 * - 途中失敗時は `<元ファイル名>_ERROR_paged.md` を使って再開します。
 * - Word / ODT / PowerPoint は対応する Markdown を同じ場所に出力します。
 *
 * オプション:
 * - `--target houhi|general` : 出力スタイルを切り替えます（デフォルト: general）。
 *   - `houhi`   : 裁判文書向け Markdown フォーマット。
 *                 同梱の `src/templates/houhi_sample.md` をデフォルトテンプレートとして使用します。
 *                 `--context-file` で独自のサンプルファイルに置き換えられます。
 *   - `general` : 一般文書向け Markdown（標準 Markdown 見出し・段落構造）。
 * - `--context-file <path>` : houhi モードで使用するサンプル Markdown ファイルを指定します。
 *                             省略するとプロジェクト内蔵のテンプレートを使用します。
 * - `--context-text <text>` : OCR 前に登場人物、固有名詞、専門用語などの補助コンテキストを渡します。
 * - `--batch_size <n>`    : PDF を何ページ単位で処理するか（デフォルト: 4）。
 * - `--start_page <n>`    : 処理開始ページ。
 * - `--end_page <n>`      : 処理終了ページ。
 * - `--show_prompt`       : 実際に使うOCRプロンプトを表示して終了します。
 * - `--ai gemini|claude|openai` : AIプロバイダーを指定します（デフォルト: gemini）。
 * - `--mode batch|sync`   : バッチ処理または同期処理を指定します（デフォルト: sync）。
 * - `--ndlocr`            : ndlocr-lite を前処理として使います。
 * - `--ndlocr_only`       : ndlocr のみで処理します（PDF のみ対応）。
 * - `--prefer_pdf_text`   : 埋め込みテキストがある PDF では OCR よりテキスト抽出を優先します。
 * - `--auto_rename`       : 先頭4ページと末尾4ページをAIで判定してファイル名を自動変更する機能を有効化します。
 * - `--skip_formatted_rename` : 既に自動改名形式のファイルは再改名しません。
 *
 * 使い方:
 *   node src/ocr.js <入力パス...> [--target houhi|general] [オプション...]
 */
const fs = require('fs');
const path = require('path');
const { pdfToText, docToText, docxToText, odtToText, pptxToText, imageToText, getOcrPrompt } = require('./lib/ai_ocr');
const { maybeAutoRenameDocument } = require('./lib/auto_rename');
const { loadConfig, getProviderModel } = require('./lib/gemini_client');
const {
    parsePositiveInt,
    normalizeTarget,
    normalizeMode,
    readOptionalTextFile,
    compactTextParts,
    buildAdditionalContextInstruction,
} = require('./lib/shared_options');

// ---- スタイル定義 ----

const GENERAL_DOC_STYLE = `
# CONTEXT: General Document
- **Format**: Standard Japanese document.
- **Line Breaks**: Merge lines within paragraphs.
- **Headings**: Use standard Markdown headings (#, ##, ###) based on the document structure.
`;

// プロジェクト内蔵のデフォルト houhi テンプレートパス（dist/src/templates/houhi_sample.md）
const DEFAULT_HOUHI_TEMPLATE = path.resolve(__dirname, 'templates', 'houhi_sample.md');

function normalizeProvider(value) {
    const provider = String(value || '').toLowerCase();
    return ['gemini', 'claude', 'openai'].includes(provider) ? provider : 'gemini';
}

function normalizeNdlocrMode(value) {
    const mode = String(value || '').toLowerCase().replace(/-/g, '_');
    if (['pre', 'ndlocr', 'ndlocr_ai', 'on', 'true'].includes(mode)) return 'pre';
    if (['only', 'ndlocr_only'].includes(mode)) return 'only';
    return 'off';
}

function buildHouhiStyle(contextFilePath, contextText = '') {
    // 指定がなければ内蔵テンプレートを使用
    const templatePath = contextFilePath
        ? path.resolve(contextFilePath)
        : DEFAULT_HOUHI_TEMPLATE;

    let sampleContent = "";
    if (fs.existsSync(templatePath)) {
        sampleContent = fs.readFileSync(templatePath, 'utf-8');
    } else {
        console.warn(`[警告] コンテキストファイルが見つかりません: ${templatePath}`);
    }

    return `
# TARGET OUTPUT STYLE
Follow the structure and formatting of this example:

${sampleContent}
${buildAdditionalContextInstruction(contextText)}
`;
}

function buildGeneralStyle(contextText = '') {
    return `${GENERAL_DOC_STYLE}
${buildAdditionalContextInstruction(contextText)}
`;
}

// ---- メイン処理 ----

async function main() {
    const args = process.argv.slice(2);
    const config = loadConfig() || {};
    const ocrConfig = config.ocr || {};
    const inputPaths = [];
    let failedCount = 0;
    let target = normalizeTarget(ocrConfig.target);
    let contextFilePath = ocrConfig.houhiTemplatePath || null;
    let contextText = compactTextParts(
        ocrConfig.contextText,
        readOptionalTextFile(ocrConfig.contextFilePath, 'OCRコンテキストファイル')
    );
    let batchSize = parsePositiveInt(ocrConfig.batchSize, 4);
    let startPage = 1;
    let endPage = null;
    let showPrompt = false;
    let aiProvider = normalizeProvider(ocrConfig.provider);
    let processMode = normalizeMode(ocrConfig.mode);
    const defaultNdlocrMode = normalizeNdlocrMode(ocrConfig.ndlocr);
    let useNdlocr = defaultNdlocrMode === 'pre' || defaultNdlocrMode === 'only';
    let ndlocrOnly = defaultNdlocrMode === 'only';
    let preferPdfText = ocrConfig.preferPdfText === true;
    let autoRename = ocrConfig.autoRename === true;
    let skipFormattedRename = ocrConfig.skipFormattedRename === true;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--target") target = normalizeTarget(args[++i]);
        else if (args[i] === "--context-file") contextFilePath = args[++i];
        else if (args[i] === "--context-text") contextText = compactTextParts(contextText, args[++i]);
        else if (args[i].startsWith("--context-text=")) contextText = compactTextParts(contextText, args[i].slice("--context-text=".length));
        else if (args[i] === "--context-file-text") contextText = compactTextParts(contextText, readOptionalTextFile(args[++i], 'OCRコンテキストファイル'));
        else if (args[i].startsWith("--context-file-text=")) contextText = compactTextParts(contextText, readOptionalTextFile(args[i].slice("--context-file-text=".length), 'OCRコンテキストファイル'));
        else if (args[i] === "--batch_size") batchSize = parsePositiveInt(args[++i], batchSize);
        else if (args[i] === "--start_page") startPage = parseInt(args[++i]);
        else if (args[i] === "--end_page") endPage = parseInt(args[++i]);
        else if (args[i] === "--show_prompt") showPrompt = true;
        else if (args[i] === "--ai") aiProvider = normalizeProvider(args[++i]);
        else if (args[i] === "--mode") processMode = normalizeMode(args[++i]);
        else if (args[i] === "--ndlocr") { useNdlocr = true; ndlocrOnly = false; }
        else if (args[i] === "--ndlocr_only") { useNdlocr = true; ndlocrOnly = true; }
        else if (args[i] === "--no_ndlocr" || args[i] === "--no-ndlocr") { useNdlocr = false; ndlocrOnly = false; }
        else if (args[i] === "--prefer_pdf_text") preferPdfText = true;
        else if (args[i] === "--auto_rename") autoRename = true;
        else if (args[i] === "--no_auto_rename") autoRename = false;
        else if (args[i] === "--skip_formatted_rename" || args[i] === "--skip-formatted-rename") skipFormattedRename = true;
        else if (args[i] === "--no_skip_formatted_rename" || args[i] === "--no-skip-formatted-rename") skipFormattedRename = false;
        else inputPaths.push(args[i]);
    }

    const aiModel = getProviderModel(aiProvider, 'chat');
    const aiLabel = `${aiProvider} / モデル: ${aiModel || '(未設定)'}`;
    const ocrAiLabel = ndlocrOnly
        ? (autoRename ? `${aiLabel}（自動改名のみ）` : '使用しない')
        : aiLabel;

    // コンテキスト指示を構築
    let contextInstruction;
    if (target === 'houhi') {
        console.log(`[情報] ターゲット: houhi（裁判文書フォーマット）`);
        contextInstruction = buildHouhiStyle(contextFilePath, contextText);
    } else {
        console.log(`[情報] ターゲット: general（一般文書フォーマット）`);
        contextInstruction = buildGeneralStyle(contextText);
    }
    console.log(`[情報] コンテキスト: ${contextText ? 'あり' : 'なし'}`);

    if (showPrompt) {
        console.log("\n--- OCR プロンプトテンプレート ---");
        console.log(getOcrPrompt(batchSize, contextInstruction));
        console.log("----------------------------------\n");
        return;
    }

    if (inputPaths.length === 0) {
        console.log("-------------------------------------------------------");
        console.log(" 文書ファイルまたはフォルダをドロップしてください。");
        console.log("");
        console.log(" 使い方:");
        console.log("   node ocr.js <入力パス...> [オプション]");
        console.log("");
        console.log(" オプション:");
        console.log(`   --target houhi|general   出力スタイル（現在の既定: ${target}）`);
        console.log("   --context-file <path>    houhi モード用サンプル Markdown のパス（省略可）");
        console.log("   --context-text <text>    OCR用の補助コンテキスト");
        console.log("   --context-file-text <path> OCR用の補助コンテキストファイル");
        console.log(`   --batch_size <n>         PDF の処理ページ数（現在の既定: ${batchSize}）`);
        console.log("   --start_page <n>         開始ページ");
        console.log("   --end_page <n>           終了ページ");
        console.log(`   --ai gemini|claude|openai  AI プロバイダー（現在の既定: ${aiProvider}）`);
        console.log(`   --mode batch|sync        処理モード（現在の既定: ${processMode}）`);
        console.log("   --ndlocr                 ndlocr-lite を前処理に使用");
        console.log("   --ndlocr_only            ndlocr のみで処理（PDF のみ）");
        console.log("   --no_ndlocr              既定設定の ndlocr-lite 併用を無効化");
        console.log("   --prefer_pdf_text        埋め込みテキストを OCR より優先");
        console.log("   --auto_rename            AIによる自動ファイル名変更を有効化");
        console.log("   --skip_formatted_rename  形式済みファイルの自動改名をスキップ");
        console.log("   --show_prompt            OCRプロンプトを表示して終了");
        console.log("-------------------------------------------------------");
        return;
    }

    // ファイル/ディレクトリを分類
    const fileJobs = [];
    const dirJobs = [];

    for (const inputPath of inputPaths) {
        const absPath = path.resolve(inputPath);
        if (!fs.existsSync(absPath)) {
            console.error(`[エラー] パスが見つかりません: ${absPath}`);
            failedCount++;
            continue;
        }
        if (fs.statSync(absPath).isDirectory()) {
            dirJobs.push(absPath);
        } else {
            fileJobs.push(absPath);
        }
    }

    const processFile = async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        let ocrOutputPath = null;
        const metadataOptions = {
            target,
            contextFilePath: target === 'houhi'
                ? (contextFilePath ? path.resolve(contextFilePath) : DEFAULT_HOUHI_TEMPLATE)
                : null
        };
        if (ext === ".pdf") {
            console.log(`\n[PDF 処理] 開始: ${path.basename(filePath)} (AI: ${ocrAiLabel}, モード: ${processMode}, Pre-OCR: ${useNdlocr})`);
            ocrOutputPath = await pdfToText(filePath, batchSize, startPage, endPage, contextInstruction, aiProvider, processMode, useNdlocr, ndlocrOnly, preferPdfText, metadataOptions);
        } else if (ext === ".docx") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[Word 処理] 開始: ${path.basename(filePath)} (AI: ${aiLabel}, モード: ${processMode})`);
            ocrOutputPath = await docxToText(filePath, contextInstruction, aiProvider, processMode, metadataOptions);
        } else if (ext === ".doc") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[Word(doc) 処理] 開始: ${path.basename(filePath)} (AI: ${aiLabel}, モード: ${processMode})`);
            ocrOutputPath = await docToText(filePath, contextInstruction, aiProvider, processMode, metadataOptions);
        } else if (ext === ".odt") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[ODT 処理] 開始: ${path.basename(filePath)} (AI: ${aiLabel}, モード: ${processMode})`);
            ocrOutputPath = await odtToText(filePath, contextInstruction, aiProvider, processMode, metadataOptions);
        } else if (ext === ".pptx") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[PowerPoint 処理] 開始: ${path.basename(filePath)} (AI: ${aiLabel}, モード: ${processMode})`);
            ocrOutputPath = await pptxToText(filePath, contextInstruction, aiProvider, processMode, metadataOptions);
        } else if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"].includes(ext)) {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[画像 処理] 開始: ${path.basename(filePath)} (AI: ${aiLabel}, モード: ${processMode})`);
            ocrOutputPath = await imageToText(filePath, contextInstruction, aiProvider, processMode, metadataOptions);
        } else {
            console.warn(`[警告] 未対応のファイル形式です: ${path.basename(filePath)}`);
            return false;
        }

        if (ocrOutputPath && /_ERROR_paged\.md$/i.test(ocrOutputPath)) {
            console.error(`[エラー] 未完了ページを含むため、OCR中間結果として保存されました: ${ocrOutputPath}`);
            return false;
        }

        if (ocrOutputPath && autoRename) {
            try {
                await maybeAutoRenameDocument(filePath, ocrOutputPath, aiProvider, target, { skipFormattedRename });
            } catch (err) {
                console.warn(`[警告] 自動改名に失敗しました: ${path.basename(filePath)} / ${err.message}`);
            }
        }

        return true;
    };

    const runFiles = async (files) => {
        if (processMode === 'sync') {
            console.log(`[情報] ${files.length} 個のファイルを順次処理します`);
            for (const fp of files) {
                try {
                    if (!await processFile(fp)) failedCount++;
                } catch (err) {
                    console.error(`[エラー] ${path.basename(fp)}: ${err.message}`);
                    failedCount++;
                }
            }
        } else {
            console.log(`[情報] ${files.length} 個のファイルを並列処理します`);
            await Promise.all(files.map(async fp => {
                try {
                    if (!await processFile(fp)) failedCount++;
                } catch (err) {
                    console.error(`[エラー] ${path.basename(fp)}: ${err.message}`);
                    failedCount++;
                }
            }));
        }
    };

    if (fileJobs.length > 0) {
        await runFiles(fileJobs);
    }

    for (const absPath of dirJobs) {
        const files = fs.readdirSync(absPath)
            .filter(f => {
                const ext = f.toLowerCase();
                return ext.endsWith(".pdf") || ext.endsWith(".docx") || ext.endsWith(".doc")
                    || ext.endsWith(".odt") || ext.endsWith(".pptx")
                    || ext.endsWith(".png") || ext.endsWith(".jpg") || ext.endsWith(".jpeg")
                    || ext.endsWith(".tif") || ext.endsWith(".tiff") || ext.endsWith(".bmp")
                    || ext.endsWith(".webp");
            })
            .sort();

        if (files.length === 0) {
            console.warn(`[警告] ディレクトリ内に対応する文書ファイルが見つかりませんでした: ${absPath}`);
            failedCount++;
            continue;
        }

        await runFiles(files.map(f => path.join(absPath, f)));
    }

    if (failedCount > 0) {
        console.error(`\n[エラー] 処理は終了しましたが、${failedCount} 件失敗しました。`);
        process.exitCode = 1;
        return;
    }

    console.log("\nすべての処理が完了しました。");
}

main().catch(err => {
    console.error(`[致命的エラー] ${err.message}`);
    process.exitCode = 1;
});
