/**
 * PDFページ抽出・結合ツール。
 *
 * PDFと同じ場所にあるOCR結果（*_paged.md / *_ERROR_paged.md）からページ情報を読み、
 * PDFページ番号または印刷ページ番号で指定されたページを抽出して1つのPDFへ結合します。
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

type PageType = 'pdf' | 'printed';
type Direction = 'ltr' | 'rtl';

type InputSpec = {
    pdfPath: string;
    pages: string | null;
};

type OcrPageInfo = {
    pdfPage: number;
    printedPage: number | null;
    block: string;
};

type SelectedPage = {
    pdfPath: string;
    srcDoc: any;
    pageIndex: number;
    pageNumber: number;
    markdownBlock: string;
};

function findOcrResultPath(pdfPath: string): string {
    const dir = path.dirname(pdfPath);
    const stem = path.basename(pdfPath, path.extname(pdfPath));
    const candidates = [
        path.join(dir, `${stem}_paged.md`),
        path.join(dir, `${stem}_ERROR_paged.md`)
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    throw new Error(`対応するOCR結果が見つかりません: ${candidates.join(' / ')}`);
}

function removeOcrSettingsComment(mdContent: string): string {
    return String(mdContent || '').replace(/\n*<!-- mimi-ocr-settings[\s\S]*?-->\s*$/m, '').trimEnd();
}

function parseOcrPages(mdContent: string): OcrPageInfo[] {
    const content = removeOcrSettingsComment(mdContent);
    const beginPattern = /### -- Begin Page (\d+).*? --/g;
    const markers: { pageNum: number; index: number }[] = [];
    let match;

    while ((match = beginPattern.exec(content)) !== null) {
        markers.push({ pageNum: parseInt(match[1], 10), index: match.index });
    }

    const pages: OcrPageInfo[] = [];
    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index;
        const end = i + 1 < markers.length ? markers[i + 1].index : content.length;
        const block = content.substring(start, end).trimEnd();
        const endMatch = block.match(/### -- End[\s\S]*? --/);
        const printedMatch = endMatch ? endMatch[0].match(/\(Printed Page (\d+)\)/) : null;

        pages.push({
            pdfPage: markers[i].pageNum,
            printedPage: printedMatch ? parseInt(printedMatch[1], 10) : null,
            block
        });
    }

    return pages;
}

function parsePageRange(rangeText: string): number[] {
    const text = String(rangeText || '').trim();
    if (!text) throw new Error('ページ指定が空です');

    const pages: number[] = [];
    for (const rawPart of text.split(',')) {
        const part = rawPart.trim();
        if (!part) continue;

        const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (start < 1 || end < 1 || start > end) {
                throw new Error(`ページ範囲が不正です: ${part}`);
            }
            for (let p = start; p <= end; p++) pages.push(p);
            continue;
        }

        const singleMatch = part.match(/^\d+$/);
        if (!singleMatch) throw new Error(`ページ指定が不正です: ${part}`);

        const page = parseInt(part, 10);
        if (page < 1) throw new Error(`ページ番号は1以上を指定してください: ${part}`);
        pages.push(page);
    }

    if (pages.length === 0) throw new Error('有効なページ指定がありません');
    return pages;
}

function resolvePagesFromOcr(
    requestedPages: number[],
    ocrPages: OcrPageInfo[],
    pageType: PageType,
    pdfPageCount: number
): number[] {
    if (pageType === 'pdf') {
        const ocrPageSet = new Set(ocrPages.map(p => p.pdfPage));
        const missing = requestedPages.filter(p => !ocrPageSet.has(p));
        if (missing.length > 0) {
            throw new Error(`OCR結果にPDFページが見つかりません: ${missing.join(', ')}`);
        }
        const outOfRange = requestedPages.filter(p => p > pdfPageCount);
        if (outOfRange.length > 0) {
            throw new Error(`PDFの総ページ数を超えています: ${outOfRange.join(', ')}`);
        }
        return requestedPages;
    }

    const printedToPdfPages = new Map<number, number[]>();
    for (const page of ocrPages) {
        if (page.printedPage === null) continue;
        if (!printedToPdfPages.has(page.printedPage)) {
            printedToPdfPages.set(page.printedPage, []);
        }
        printedToPdfPages.get(page.printedPage)!.push(page.pdfPage);
    }

    const resolved: number[] = [];
    const missingPrintedPages: number[] = [];
    for (const printedPage of requestedPages) {
        const pdfPages = printedToPdfPages.get(printedPage);
        if (!pdfPages || pdfPages.length === 0) {
            missingPrintedPages.push(printedPage);
            continue;
        }
        resolved.push(...pdfPages);
    }

    if (missingPrintedPages.length > 0) {
        throw new Error(`OCR結果に印刷ページが見つかりません: ${missingPrintedPages.join(', ')}`);
    }

    return resolved;
}

function parseInputSpecs(args: string[], globalPages: string | null): InputSpec[] {
    return args.map(arg => {
        const sep = arg.lastIndexOf('::');
        if (sep >= 0) {
            return {
                pdfPath: arg.slice(0, sep),
                pages: arg.slice(sep + 2)
            };
        }
        return {
            pdfPath: arg,
            pages: globalPages
        };
    });
}

function makeDefaultOutputPath(inputSpecs: InputSpec[], twoUp: boolean): string {
    const firstPdf = inputSpecs[0].pdfPath;
    const dir = path.dirname(firstPdf);
    const stem = path.basename(firstPdf, path.extname(firstPdf));
    const suffix = `${inputSpecs.length > 1 ? '_combined_pages' : '_pages'}${twoUp ? '_2up' : ''}.pdf`;
    return path.join(dir, stem + suffix);
}

function uniqueOutputPaths(basePdfPath: string): { pdfPath: string; mdPath: string } {
    const dir = path.dirname(basePdfPath);
    const stem = path.basename(basePdfPath, path.extname(basePdfPath));
    const makePair = (suffix: string) => ({
        pdfPath: path.join(dir, `${stem}${suffix}.pdf`),
        mdPath: path.join(dir, `${stem}${suffix}.md`)
    });

    const first = makePair('');
    if (!fs.existsSync(first.pdfPath) && !fs.existsSync(first.mdPath)) return first;

    for (let i = 2; i < 1000; i++) {
        const candidate = makePair(` (${i})`);
        if (!fs.existsSync(candidate.pdfPath) && !fs.existsSync(candidate.mdPath)) return candidate;
    }
    throw new Error(`出力先の連番を作成できません: ${basePdfPath}`);
}

async function collectSelectedPages(inputSpecs: InputSpec[], pageType: PageType): Promise<SelectedPage[]> {
    const selectedPages: SelectedPage[] = [];

    for (const spec of inputSpecs) {
        const pdfPath = path.resolve(spec.pdfPath);
        if (!spec.pages) {
            throw new Error(`ページ指定がありません: ${pdfPath}`);
        }
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDFが見つかりません: ${pdfPath}`);
        }
        if (path.extname(pdfPath).toLowerCase() !== '.pdf') {
            throw new Error(`PDFファイルを指定してください: ${pdfPath}`);
        }

        const ocrPath = findOcrResultPath(pdfPath);
        const ocrPages = parseOcrPages(fs.readFileSync(ocrPath, 'utf-8'));
        if (ocrPages.length === 0) {
            throw new Error(`OCR結果にページマーカーが見つかりません: ${ocrPath}`);
        }
        const ocrPageByPdfPage = new Map(ocrPages.map(p => [p.pdfPage, p]));

        const srcDoc = await PDFDocument.load(fs.readFileSync(pdfPath), { ignoreEncryption: true });
        const pageCount = srcDoc.getPageCount();
        const requested = parsePageRange(spec.pages);
        const pdfPages = resolvePagesFromOcr(requested, ocrPages, pageType, pageCount);

        console.log(`[情報] ${path.basename(pdfPath)}: OCR結果 ${path.basename(ocrPath)} / ${pageType === 'printed' ? '印刷ページ' : 'PDFページ'} ${spec.pages} -> PDFページ ${pdfPages.join(', ')}`);

        for (const pageNumber of pdfPages) {
            const ocrPage = ocrPageByPdfPage.get(pageNumber);
            if (!ocrPage) {
                throw new Error(`OCR結果にPDFページが見つかりません: ${pageNumber}`);
            }
            selectedPages.push({
                pdfPath,
                srcDoc,
                pageIndex: pageNumber - 1,
                pageNumber,
                markdownBlock: ocrPage.block
            });
        }
    }

    if (selectedPages.length === 0) {
        throw new Error('抽出対象ページがありません');
    }

    return selectedPages;
}

async function buildExtractedPdf(selectedPages: SelectedPage[]): Promise<Buffer> {
    const outDoc = await PDFDocument.create();
    for (const selected of selectedPages) {
        const [page] = await outDoc.copyPages(selected.srcDoc, [selected.pageIndex]);
        outDoc.addPage(page);
    }
    return Buffer.from(await outDoc.save());
}

function renumberMarkdownBlock(block: string, newPageNumber: number): string {
    return String(block || '').replace(
        /### -- Begin Page \d+(.*?) --/,
        `### -- Begin Page ${newPageNumber}$1 --`
    ).trimEnd();
}

function buildExtractedMarkdown(selectedPages: SelectedPage[]): string {
    return selectedPages
        .map((selected, idx) => renumberMarkdownBlock(selected.markdownBlock, idx + 1))
        .join('\n\n') + '\n';
}

async function buildTwoUpPdf(selectedPages: SelectedPage[], direction: Direction): Promise<Buffer> {
    const outDoc = await PDFDocument.create();
    const firstPage = selectedPages[0].srcDoc.getPage(selectedPages[0].pageIndex);
    const firstSize = firstPage.getSize();
    const outWidth = Math.max(firstSize.width, firstSize.height);
    const outHeight = Math.min(firstSize.width, firstSize.height);
    const cellWidth = outWidth / 2;
    const cellHeight = outHeight;

    for (let i = 0; i < selectedPages.length; i += 2) {
        const outPage = outDoc.addPage([outWidth, outHeight]);
        const pair = selectedPages.slice(i, i + 2);

        for (let j = 0; j < pair.length; j++) {
            const slot = direction === 'rtl' ? 1 - j : j;
            const selected = pair[j];
            const srcPage = selected.srcDoc.getPage(selected.pageIndex);
            const embeddedPage = await outDoc.embedPage(srcPage);
            const size = srcPage.getSize();
            const scale = Math.min(cellWidth / size.width, cellHeight / size.height);
            const drawWidth = size.width * scale;
            const drawHeight = size.height * scale;
            const x = slot * cellWidth + (cellWidth - drawWidth) / 2;
            const y = (cellHeight - drawHeight) / 2;

            outPage.drawPage(embeddedPage, {
                x,
                y,
                width: drawWidth,
                height: drawHeight
            });
        }
    }

    return Buffer.from(await outDoc.save());
}

function printUsage() {
    console.log("-------------------------------------------------------");
    console.log(" PDFページ抽出・結合ツール");
    console.log("");
    console.log(" PDFと同じ場所にあるOCR結果を使ってページ指定を解決します。");
    console.log(" OCR結果がないPDFは処理できません。");
    console.log(" 抽出結果はPDFとMarkdownのペアで出力します。");
    console.log("");
    console.log(" 使い方:");
    console.log("   node pdf_pages.js --pages 1-3,7,8 [オプション] <PDF...>");
    console.log("   node pdf_pages.js [オプション] <PDF::ページ指定...>");
    console.log("");
    console.log(" オプション:");
    console.log("   --pages <指定>          全PDFに適用するページ指定。例: 1-3,7,8");
    console.log("   --page-type pdf|printed PDFページまたは印刷ページで指定（既定: pdf）");
    console.log("   --output <path>         出力PDFパス（省略時は自動命名）");
    console.log("   --two-up                1ページに2面割り付け");
    console.log("   --direction ltr|rtl     2面割付のページ方向（既定: ltr）");
    console.log("-------------------------------------------------------");
}

async function main() {
    const args = process.argv.slice(2);
    const inputArgs: string[] = [];
    let globalPages: string | null = null;
    let pageType: PageType = 'pdf';
    let outputPath: string | null = null;
    let twoUp = false;
    let direction: Direction = 'ltr';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--pages') {
            globalPages = args[++i];
        } else if (arg === '--page-type') {
            const value = args[++i];
            if (value !== 'pdf' && value !== 'printed') {
                throw new Error('--page-type は pdf または printed を指定してください');
            }
            pageType = value;
        } else if (arg === '--output') {
            outputPath = args[++i];
        } else if (arg === '--two-up') {
            twoUp = true;
        } else if (arg === '--direction') {
            const value = args[++i];
            if (value !== 'ltr' && value !== 'rtl') {
                throw new Error('--direction は ltr または rtl を指定してください');
            }
            direction = value;
        } else if (arg === '--help' || arg === '-h') {
            printUsage();
            return;
        } else {
            inputArgs.push(arg);
        }
    }

    if (inputArgs.length === 0 || (!globalPages && inputArgs.every(arg => !arg.includes('::')))) {
        printUsage();
        return;
    }

    const inputSpecs = parseInputSpecs(inputArgs, globalPages);
    const selectedPages = await collectSelectedPages(inputSpecs, pageType);
    const pdfBytes = twoUp
        ? await buildTwoUpPdf(selectedPages, direction)
        : await buildExtractedPdf(selectedPages);
    const mdContent = buildExtractedMarkdown(selectedPages);

    const outputPair = uniqueOutputPaths(path.resolve(outputPath || makeDefaultOutputPath(inputSpecs, twoUp)));
    fs.writeFileSync(outputPair.pdfPath, pdfBytes);
    fs.writeFileSync(outputPair.mdPath, mdContent, 'utf-8');
    console.log(`[成功] ${outputPair.pdfPath} に保存しました (${selectedPages.length} ページ${twoUp ? ' / 2面割付' : ''})`);
    console.log(`[成功] ${outputPair.mdPath} に保存しました (Markdown ${selectedPages.length} ページ)`);
}

main().catch(err => {
    console.error(`[エラー] ${err.message}`);
    process.exitCode = 1;
});
