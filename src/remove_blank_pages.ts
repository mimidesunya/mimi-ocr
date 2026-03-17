/**
 * ブランクページ除去ツール
 *
 * PDFに対応するOCR結果 (_paged.md) を解析し、
 * 白紙ページを除去した PDF と md のペアを生成する。
 *
 * 出力ファイル名:
 *   <元のファイル名>_noblank.pdf / <元のファイル名>_noblank_paged.md
 *
 * 使い方:
 *   node remove_blank_pages.js <PDFファイル> [--threshold <文字数>]
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

interface PageInfo {
    pageNum: number;
    content: string;
    bodyText: string;
    isBlank: boolean;
}

/** デフォルトの白紙判定しきい値（マーカー・空白除去後の文字数） */
const DEFAULT_THRESHOLD = 10;

/**
 * 入力PDFに対応する _paged.md のパスを返す。
 */
function findPagedMd(pdfPath: string): string {
    const dir = path.dirname(pdfPath);
    const base = path.basename(pdfPath, path.extname(pdfPath));
    const pagedPath = path.join(dir, `${base}_paged.md`);
    if (fs.existsSync(pagedPath)) {
        return pagedPath;
    }
    throw new Error(`対応する _paged.md が見つかりません: ${pagedPath}`);
}

/**
 * _paged.md の内容をページ単位に分割し、白紙判定を行う。
 */
function analyzePages(content: string, threshold: number): PageInfo[] {
    const pagePattern = /### -- Begin Page (\d+).*? --/g;
    let match;
    const markers: { pageNum: number; index: number }[] = [];
    while ((match = pagePattern.exec(content)) !== null) {
        markers.push({ pageNum: parseInt(match[1]), index: match.index });
    }

    const pages: PageInfo[] = [];
    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : content.length;
        const pageContent = content.substring(start, end).trimEnd();

        // マーカー行を除去して本文テキストのみ取得
        const bodyText = pageContent
            .replace(/### -- Begin Page \d+.*? --/g, '')
            .replace(/### -- End.*? --/g, '')
            .replace(/\[ERROR: OCR Failed.*?\]/g, '')
            .trim();

        const isBlank = bodyText.length <= threshold;

        pages.push({
            pageNum: markers[i].pageNum,
            content: pageContent,
            bodyText,
            isBlank,
        });
    }

    return pages;
}

/**
 * ページコンテンツ内の Begin Page マーカーのページ番号を振り直す。
 */
function renumberPage(pageContent: string, newPageNum: number): string {
    return pageContent.replace(
        /### -- Begin Page \d+(.*?) --/,
        `### -- Begin Page ${newPageNum}$1 --`
    );
}

/**
 * 白紙ページを除去した _paged.md を生成する。
 */
function buildFilteredMarkdown(pages: PageInfo[]): string {
    const kept = pages.filter(p => !p.isBlank);
    const parts: string[] = [];
    let newPageNum = 1;
    for (const page of kept) {
        parts.push(renumberPage(page.content, newPageNum));
        newPageNum++;
    }
    return parts.join('\n\n') + '\n';
}

/**
 * 白紙ページを除去した PDF を生成する。
 */
async function buildFilteredPdf(pdfPath: string, keptPageNums: number[]): Promise<Buffer> {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();

    // pdf-lib は 0-based index
    const indices = keptPageNums
        .map(p => p - 1)
        .filter(i => i >= 0 && i < totalPages);

    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, indices);
    for (const page of copiedPages) {
        newDoc.addPage(page);
    }

    const newPdfBytes = await newDoc.save();
    return Buffer.from(newPdfBytes);
}

async function main() {
    const args = process.argv.slice(2);
    let threshold = DEFAULT_THRESHOLD;
    const inputPaths: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--threshold') {
            threshold = parseInt(args[++i], 10);
            if (isNaN(threshold) || threshold < 0) {
                console.error('[エラー] --threshold には0以上の整数を指定してください');
                return;
            }
        } else {
            inputPaths.push(args[i]);
        }
    }

    if (inputPaths.length === 0) {
        console.log("-------------------------------------------------------");
        console.log(" ブランクページ除去ツール");
        console.log("");
        console.log(" PDFのOCR結果を解析し、白紙ページを除去した");
        console.log(" PDFとMarkdownのペアを生成します。");
        console.log("");
        console.log(" 使い方:");
        console.log("   node remove_blank_pages.js <PDFファイル> [--threshold <文字数>]");
        console.log("");
        console.log(` デフォルトしきい値: ${DEFAULT_THRESHOLD} 文字以下を白紙と判定`);
        console.log("-------------------------------------------------------");
        return;
    }

    for (const inputPath of inputPaths) {
        const absPath = path.resolve(inputPath);
        if (!fs.existsSync(absPath)) {
            console.error(`[エラー] ファイルが見つかりません: ${absPath}`);
            continue;
        }

        const ext = path.extname(absPath).toLowerCase();
        const dir = path.dirname(absPath);
        let pdfPath: string;
        let mdPath: string;

        if (ext === '.pdf') {
            pdfPath = absPath;
            try {
                mdPath = findPagedMd(absPath);
            } catch (err) {
                console.error(`[エラー] ${err.message}`);
                continue;
            }
        } else if (ext === '.md') {
            mdPath = absPath;
            const pdfBase = path.basename(absPath, ext).replace(/_paged$/, '');
            pdfPath = path.join(dir, `${pdfBase}.pdf`);
            if (!fs.existsSync(pdfPath)) {
                console.error(`[エラー] 対応するPDFが見つかりません: ${pdfPath}`);
                continue;
            }
        } else {
            console.error(`[エラー] PDF または _paged.md ファイルを指定してください: ${absPath}`);
            continue;
        }

        console.log(`\n[処理] ${path.basename(pdfPath)}`);
        console.log(`[情報] OCR結果: ${path.basename(mdPath)}`);
        console.log(`[情報] 白紙判定しきい値: ${threshold} 文字以下`);

        // OCR結果を解析
        const mdContent = fs.readFileSync(mdPath, 'utf-8');
        const pages = analyzePages(mdContent, threshold);

        if (pages.length === 0) {
            console.error('[エラー] ページマーカーが見つかりません。OCR結果を確認してください。');
            continue;
        }

        const blankPages = pages.filter(p => p.isBlank);
        const keptPages = pages.filter(p => !p.isBlank);

        console.log(`[情報] 全 ${pages.length} ページ中、白紙 ${blankPages.length} ページを検出`);

        if (blankPages.length === 0) {
            console.log('[情報] 白紙ページはありません。スキップします。');
            continue;
        }

        console.log(`[情報] 白紙ページ: ${blankPages.map(p => p.pageNum).join(', ')}`);
        console.log(`[情報] 残りページ: ${keptPages.length} ページ`);

        // 出力ファイル名
        const baseName = path.basename(pdfPath, '.pdf');
        const outMdPath = path.join(dir, `${baseName}_noblank_paged.md`);
        const outPdfPath = path.join(dir, `${baseName}_noblank.pdf`);

        // Markdown 出力
        const filteredMd = buildFilteredMarkdown(pages);
        fs.writeFileSync(outMdPath, filteredMd, 'utf-8');
        console.log(`[出力] ${path.basename(outMdPath)}`);

        // PDF 出力
        const keptPageNums = keptPages.map(p => p.pageNum);
        const filteredPdf = await buildFilteredPdf(pdfPath, keptPageNums);
        fs.writeFileSync(outPdfPath, filteredPdf);
        console.log(`[出力] ${path.basename(outPdfPath)}`);

        console.log(`[完了] ${blankPages.length} ページ除去 → ${keptPages.length} ページ`);
    }

    console.log("\nすべての処理が完了しました。");
}

main();
