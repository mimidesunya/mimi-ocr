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
 *
 * 使い方:
 *   node src/ocr.js <入力パス...> [--target houhi|general] [オプション...]
 */
const fs = require('fs');
const path = require('path');
const { pdfToText, docToText, docxToText, odtToText, pptxToText, imageToText, getOcrPrompt } = require('./lib/ai_ocr');
const { maybeAutoRenameDocument } = require('./lib/auto_rename');

// ---- スタイル定義 ----

const GENERAL_DOC_STYLE = `
# CONTEXT: General Document
- **Format**: Standard Japanese document.
- **Line Breaks**: Merge lines within paragraphs.
- **Headings**: Use standard Markdown headings (#, ##, ###) based on the document structure.
`;

// プロジェクト内蔵のデフォルト houhi テンプレートパス（dist/src/templates/houhi_sample.md）
const DEFAULT_HOUHI_TEMPLATE = path.resolve(__dirname, 'templates', 'houhi_sample.md');

function buildHouhiStyle(contextFilePath) {
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
`;
}

// ---- メイン処理 ----

async function main() {
    const args = process.argv.slice(2);
    const inputPaths = [];
    let target = 'general';
    let contextFilePath = null;
    let batchSize = 4;
    let startPage = 1;
    let endPage = null;
    let showPrompt = false;
    let aiProvider = 'gemini';
    let processMode = 'sync';
    let useNdlocr = false;
    let ndlocrOnly = false;
    let preferPdfText = false;
    let autoRename = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--target") target = args[++i];
        else if (args[i] === "--context-file") contextFilePath = args[++i];
        else if (args[i] === "--batch_size") batchSize = parseInt(args[++i]);
        else if (args[i] === "--start_page") startPage = parseInt(args[++i]);
        else if (args[i] === "--end_page") endPage = parseInt(args[++i]);
        else if (args[i] === "--show_prompt") showPrompt = true;
        else if (args[i] === "--ai") aiProvider = args[++i];
        else if (args[i] === "--mode") processMode = args[++i];
        else if (args[i] === "--ndlocr") useNdlocr = true;
        else if (args[i] === "--ndlocr_only") ndlocrOnly = true;
        else if (args[i] === "--prefer_pdf_text") preferPdfText = true;
        else if (args[i] === "--auto_rename") autoRename = true;
        else if (args[i] === "--no_auto_rename") autoRename = false;
        else inputPaths.push(args[i]);
    }

    // コンテキスト指示を構築
    let contextInstruction;
    if (target === 'houhi') {
        console.log(`[情報] ターゲット: houhi（裁判文書フォーマット）`);
        contextInstruction = buildHouhiStyle(contextFilePath);
    } else {
        console.log(`[情報] ターゲット: general（一般文書フォーマット）`);
        contextInstruction = GENERAL_DOC_STYLE;
    }

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
        console.log("   --target houhi|general   出力スタイル（デフォルト: general）");
        console.log("   --context-file <path>    houhi モード用サンプル Markdown のパス（省略可）");
        console.log("   --batch_size <n>         PDF の処理ページ数（デフォルト: 4）");
        console.log("   --start_page <n>         開始ページ");
        console.log("   --end_page <n>           終了ページ");
        console.log("   --ai gemini|claude|openai  AI プロバイダー（デフォルト: gemini）");
        console.log("   --mode batch|sync        処理モード（デフォルト: sync）");
        console.log("   --ndlocr                 ndlocr-lite を前処理に使用");
        console.log("   --ndlocr_only            ndlocr のみで処理（PDF のみ）");
        console.log("   --prefer_pdf_text        埋め込みテキストを OCR より優先");
        console.log("   --auto_rename            AIによる自動ファイル名変更を有効化");
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
        if (ext === ".pdf") {
            console.log(`\n[PDF 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode}, Pre-OCR: ${useNdlocr})`);
            ocrOutputPath = await pdfToText(filePath, batchSize, startPage, endPage, contextInstruction, aiProvider, processMode, useNdlocr, ndlocrOnly, preferPdfText);
        } else if (ext === ".docx") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[Word 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode})`);
            ocrOutputPath = await docxToText(filePath, contextInstruction, aiProvider, processMode);
        } else if (ext === ".doc") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[Word(doc) 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode})`);
            ocrOutputPath = await docToText(filePath, contextInstruction, aiProvider, processMode);
        } else if (ext === ".odt") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[ODT 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode})`);
            ocrOutputPath = await odtToText(filePath, contextInstruction, aiProvider, processMode);
        } else if (ext === ".pptx") {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[PowerPoint 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode})`);
            ocrOutputPath = await pptxToText(filePath, contextInstruction, aiProvider, processMode);
        } else if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"].includes(ext)) {
            if (ndlocrOnly) throw new Error("ndlocr-only モードは現在 PDF のみ対応です");
            console.log(`\n[画像 処理] 開始: ${path.basename(filePath)} (AI: ${aiProvider}, モード: ${processMode})`);
            ocrOutputPath = await imageToText(filePath, contextInstruction, aiProvider, processMode);
        } else {
            console.warn(`[警告] 未対応のファイル形式です: ${path.basename(filePath)}`);
        }

        if (ocrOutputPath && autoRename) {
            try {
                await maybeAutoRenameDocument(filePath, ocrOutputPath, aiProvider);
            } catch (err) {
                console.warn(`[警告] 自動改名に失敗しました: ${path.basename(filePath)} / ${err.message}`);
            }
        }
    };

    const runFiles = async (files) => {
        if (processMode === 'sync') {
            console.log(`[情報] ${files.length} 個のファイルを順次処理します`);
            for (const fp of files) {
                try {
                    await processFile(fp);
                } catch (err) {
                    console.error(`[エラー] ${path.basename(fp)}: ${err.message}`);
                }
            }
        } else {
            console.log(`[情報] ${files.length} 個のファイルを並列処理します`);
            await Promise.all(files.map(fp => processFile(fp).catch(err => {
                console.error(`[エラー] ${path.basename(fp)}: ${err.message}`);
            })));
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
            continue;
        }

        await runFiles(files.map(f => path.join(absPath, f)));
    }

    console.log("\nすべての処理が完了しました。");
}

main();
