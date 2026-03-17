/**
 * OCR済みMarkdownファイル (_paged.md) とPDFを文書ごとに分割するツール。
 *
 * 入力:
 * - PDF ファイルまたは `_paged.md` ファイル
 * - `--json-file <path>`: 分割定義JSONファイルのパス
 *
 * 分割定義JSONの形式:
 * [
 *   { "filename": "YYYY-MM-DD_タイトル.md", "start_page": 1, "end_page": 3 },
 *   ...
 * ]
 *
 * 出力:
 * - 入力ファイルと同じディレクトリに各文書のMarkdownファイルを作成
 * - 対応するPDFがあれば同じページ範囲でPDFも分割
 *
 * 使い方:
 *   node src/split_pages.js <PDFまたはMDファイル> --json-file <JSONファイルパス>
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

interface SplitEntry {
    filename: string;
    start_page: number;
    end_page: number;
}

/**
 * 入力ファイルから対応する _paged.md のパスを返す。
 * .md ならそのまま、PDF なら同ディレクトリの _paged.md を探す。
 */
function findPagedMd(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md') {
        return filePath;
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ext);
    const pagedPath = path.join(dir, `${base}_paged.md`);
    if (fs.existsSync(pagedPath)) {
        return pagedPath;
    }
    throw new Error(`対応する _paged.md が見つかりません: ${pagedPath}`);
}

/**
 * 入力ファイルから対応する PDF のパスを返す。存在しなければ null。
 */
function findPdf(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
        return filePath;
    }
    // _paged.md → 元の PDF を探す
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ext);
    const pdfBase = base.replace(/_paged$/, '');
    const pdfPath = path.join(dir, `${pdfBase}.pdf`);
    if (fs.existsSync(pdfPath)) {
        return pdfPath;
    }
    return null;
}

/**
 * _paged.md の内容をページ番号→テキストの Map に分割する。
 */
function parsePages(content: string): Map<number, string> {
    const pages = new Map<number, string>();
    const pagePattern = /### -- Begin Page (\d+).*? --/g;

    let match;
    const markers: { pageNum: number; index: number }[] = [];
    while ((match = pagePattern.exec(content)) !== null) {
        markers.push({ pageNum: parseInt(match[1]), index: match.index });
    }

    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : content.length;
        pages.set(markers[i].pageNum, content.substring(start, end).trimEnd());
    }

    return pages;
}

/**
 * ページコンテンツ内の Begin Page マーカーのページ番号を振り直す。
 */
function renumberPage(pageContent: string, newPageNum: number): string {
    // ### -- Begin Page N ... -- → ### -- Begin Page newPageNum ... --
    return pageContent.replace(
        /### -- Begin Page \d+(.*?) --/,
        `### -- Begin Page ${newPageNum}$1 --`
    );
}

/**
 * 指定された分割定義に従って _paged.md を複数ファイルに分割する。
 */
function splitMarkdown(mdFilePath: string, splitEntries: SplitEntry[]): number {
    const content = fs.readFileSync(mdFilePath, 'utf-8');
    const outputDir = path.dirname(mdFilePath);
    const pages = parsePages(content);

    const maxPage = pages.size > 0 ? Math.max(...Array.from(pages.keys())) : 0;
    console.log(`[情報] ${path.basename(mdFilePath)}: ${pages.size} ページを検出 (最大ページ: ${maxPage})`);

    let successCount = 0;
    for (const entry of splitEntries) {
        const parts: string[] = [];
        const missingPages: number[] = [];
        let newPageNum = 1;

        for (let p = entry.start_page; p <= entry.end_page; p++) {
            const pageContent = pages.get(p);
            if (pageContent) {
                parts.push(renumberPage(pageContent, newPageNum));
                newPageNum++;
            } else {
                missingPages.push(p);
            }
        }

        if (missingPages.length > 0) {
            console.warn(`[警告] ${entry.filename}: ページ ${missingPages.join(', ')} が見つかりません`);
        }

        if (parts.length === 0) {
            console.error(`[エラー] ${entry.filename}: 有効なページがありません。スキップします。`);
            continue;
        }

        const outputPath = path.join(outputDir, entry.filename);
        fs.writeFileSync(outputPath, parts.join('\n\n') + '\n', 'utf-8');
        console.log(`[出力] ${entry.filename} (ページ ${entry.start_page}–${entry.end_page})`);
        successCount++;
    }

    // ページ網羅性チェック
    const coveredPages = new Set<number>();
    for (const entry of splitEntries) {
        for (let p = entry.start_page; p <= entry.end_page; p++) {
            coveredPages.add(p);
        }
    }
    const uncoveredPages = Array.from(pages.keys()).filter(p => !coveredPages.has(p)).sort((a, b) => a - b);
    if (uncoveredPages.length > 0) {
        console.warn(`[警告] 分割定義に含まれていないページがあります: ${uncoveredPages.join(', ')}`);
    }

    return successCount;
}

/**
 * 指定された分割定義に従って PDF を複数ファイルに分割する。
 */
async function splitPdf(pdfFilePath: string, splitEntries: SplitEntry[]): Promise<number> {
    const pdfBuffer = fs.readFileSync(pdfFilePath);
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const outputDir = path.dirname(pdfFilePath);

    console.log(`[情報] ${path.basename(pdfFilePath)}: ${totalPages} ページのPDF`);

    let successCount = 0;
    for (const entry of splitEntries) {
        const pdfFilename = entry.filename.replace(/\.md$/, '.pdf');

        // ページ範囲のバリデーション
        if (entry.start_page > totalPages) {
            console.warn(`[警告] ${pdfFilename}: 開始ページ ${entry.start_page} がPDFの総ページ数 ${totalPages} を超えています。スキップします。`);
            continue;
        }

        const effectiveEnd = Math.min(entry.end_page, totalPages);
        // pdf-lib は 0-based index
        const pageIndices: number[] = [];
        for (let p = entry.start_page - 1; p < effectiveEnd; p++) {
            pageIndices.push(p);
        }

        const newDoc = await PDFDocument.create();
        const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
        for (const page of copiedPages) {
            newDoc.addPage(page);
        }

        const outputPath = path.join(outputDir, pdfFilename);
        const newPdfBytes = await newDoc.save();
        fs.writeFileSync(outputPath, Buffer.from(newPdfBytes));
        console.log(`[出力] ${pdfFilename} (ページ ${entry.start_page}–${effectiveEnd})`);
        successCount++;
    }

    // ページ網羅性チェック
    const coveredPages = new Set<number>();
    for (const entry of splitEntries) {
        for (let p = entry.start_page; p <= Math.min(entry.end_page, totalPages); p++) {
            coveredPages.add(p);
        }
    }
    const uncoveredPages: number[] = [];
    for (let p = 1; p <= totalPages; p++) {
        if (!coveredPages.has(p)) uncoveredPages.push(p);
    }
    if (uncoveredPages.length > 0) {
        console.warn(`[警告] 分割定義に含まれていないPDFページがあります: ${uncoveredPages.join(', ')}`);
    }

    return successCount;
}

async function main() {
    const args = process.argv.slice(2);
    let jsonFilePath: string | null = null;
    const inputPaths: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--json-file') {
            jsonFilePath = args[++i];
        } else {
            inputPaths.push(args[i]);
        }
    }

    if (!jsonFilePath || inputPaths.length === 0) {
        console.log("-------------------------------------------------------");
        console.log(" _paged.md と PDF を文書ごとに分割します。");
        console.log("");
        console.log(" 使い方:");
        console.log("   node split_pages.js <PDFまたはMDファイル> --json-file <JSONファイル>");
        console.log("");
        console.log(" JSONファイルの形式:");
        console.log('   [{"filename":"文書名.md","start_page":1,"end_page":3}, ...]');
        console.log("-------------------------------------------------------");
        return;
    }

    // JSON読み込み
    let splitEntries: SplitEntry[];
    try {
        const jsonContent = fs.readFileSync(path.resolve(jsonFilePath), 'utf-8');
        splitEntries = JSON.parse(jsonContent);
    } catch (err) {
        console.error(`[エラー] JSONファイルの読み込みに失敗しました: ${err.message}`);
        return;
    }

    if (!Array.isArray(splitEntries) || splitEntries.length === 0) {
        console.error('[エラー] JSONが空または不正な形式です。');
        return;
    }

    // バリデーション
    for (const entry of splitEntries) {
        if (!entry.filename || typeof entry.start_page !== 'number' || typeof entry.end_page !== 'number') {
            console.error(`[エラー] 不正なエントリがあります: ${JSON.stringify(entry)}`);
            return;
        }
        if (entry.start_page > entry.end_page) {
            console.error(`[エラー] start_page > end_page: ${entry.filename}`);
            return;
        }
    }

    // 各入力ファイルを処理
    for (const inputPath of inputPaths) {
        const absPath = path.resolve(inputPath);
        if (!fs.existsSync(absPath)) {
            console.error(`[エラー] ファイルが見つかりません: ${absPath}`);
            continue;
        }

        // Markdown 分割
        try {
            const mdPath = findPagedMd(absPath);
            console.log(`\n[MD分割] ${path.basename(mdPath)}`);
            const mdCount = splitMarkdown(mdPath, splitEntries);
            console.log(`[完了] ${mdCount}/${splitEntries.length} 個のMarkdownを出力`);
        } catch (err) {
            console.error(`[エラー] MD分割: ${err.message}`);
        }

        // PDF 分割
        const pdfPath = findPdf(absPath);
        if (pdfPath) {
            try {
                console.log(`\n[PDF分割] ${path.basename(pdfPath)}`);
                const pdfCount = await splitPdf(pdfPath, splitEntries);
                console.log(`[完了] ${pdfCount}/${splitEntries.length} 個のPDFを出力`);
            } catch (err) {
                console.error(`[エラー] PDF分割: ${err.message}`);
            }
        } else {
            console.log(`[情報] 対応するPDFが見つからないため、Markdownのみ分割しました。`);
        }
    }

    console.log("\nすべての処理が完了しました。");
}

main();
