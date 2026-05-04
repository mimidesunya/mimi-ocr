const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

class SafeCanvasFactory {
    create(width, height) {
        if (width <= 0 || height <= 0) {
            throw new Error(`無効なキャンバスサイズです: ${width}x${height}`);
        }
        const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
        const context = canvas.getContext('2d');
        return { canvas, context };
    }
    reset(canvasAndContext, width, height) {
        if (!canvasAndContext || !canvasAndContext.canvas) {
            return;
        }
        canvasAndContext.canvas.width = Math.ceil(width);
        canvasAndContext.canvas.height = Math.ceil(height);
    }
    destroy(canvasAndContext) {
        if (!canvasAndContext) {
            return;
        }
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

function normalizePageNumbers(pageNumbers, maxPage) {
    const values = Array.isArray(pageNumbers) ? pageNumbers : [];
    const unique = Array.from(new Set(
        values
            .map(v => Number.parseInt(v, 10))
            .filter(v => Number.isFinite(v) && v >= 1 && v <= maxPage)
    ));
    unique.sort((a, b) => a - b);
    return unique;
}

async function cleanupPdfResources(sourcePdf, loadingTask) {
    try {
        if (sourcePdf && typeof sourcePdf.cleanup === 'function') {
            sourcePdf.cleanup();
        }
    } catch (_e) {
        // no-op
    }

    try {
        if (sourcePdf && typeof sourcePdf.destroy === 'function') {
            await sourcePdf.destroy();
        }
    } catch (_e) {
        // no-op
    }

    try {
        if (loadingTask && typeof loadingTask.destroy === 'function') {
            await loadingTask.destroy();
        }
    } catch (_e) {
        // no-op
    }
}

async function renderPdfPages(sourcePdf, outputDir, dpi, pageNumbers) {
    const scale = dpi / 72;
    const outputFiles = [];
    const renderCanvasFactory = new SafeCanvasFactory();

    for (const pageNumber of pageNumbers) {
        const page = await sourcePdf.getPage(pageNumber);
        let canvas = null;

        try {
            const renderViewport = page.getViewport({ scale });
            canvas = createCanvas(Math.ceil(renderViewport.width), Math.ceil(renderViewport.height));
            const context = canvas.getContext('2d');

            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({
                canvasContext: context,
                viewport: renderViewport,
                canvasFactory: renderCanvasFactory,
                background: 'rgb(255, 255, 255)'
            }).promise;

            const pngBuffer = canvas.toBuffer('image/png');
            const fileName = `page_${String(pageNumber).padStart(4, '0')}.png`;
            const outputPath = path.join(outputDir, fileName);

            fs.writeFileSync(outputPath, pngBuffer);
            outputFiles.push(outputPath);
        } finally {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
            if (typeof page.cleanup === 'function') {
                page.cleanup();
            }
        }
    }

    return outputFiles;
}

/**
 * PDFの各ページをPNG画像として出力し、出力された画像パスのリストを返します。
 */
async function extractPdfToImages(pdfPath, outputDir, dpi = 200, startPage = 1, endPage = null) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const pdfjsPackageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const standardFontDataUrl = path.join(pdfjsPackageDir, 'standard_fonts') + path.sep;
    const cMapUrl = path.join(pdfjsPackageDir, 'cmaps') + path.sep;
    
    // 注意: パスに全角文字が含まれるのを防ぐため、出力先パスを確認するか呼び出し側で担保する
    const pdfBytes = fs.readFileSync(pdfPath);
    
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        CanvasFactory: SafeCanvasFactory,
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        isEvalSupported: false
    });

    let sourcePdf = null;

    try {
        sourcePdf = await loadingTask.promise;
        const numPages = sourcePdf.numPages;
        const actualEndPage = endPage === null ? numPages : Math.min(endPage, numPages);
        const normalizedStartPage = Math.max(1, Number(startPage) || 1);
        const pageNumbers = [];

        for (let pageNumber = normalizedStartPage; pageNumber <= actualEndPage; pageNumber++) {
            pageNumbers.push(pageNumber);
        }

        return await renderPdfPages(sourcePdf, outputDir, dpi, pageNumbers);
    } finally {
        await cleanupPdfResources(sourcePdf, loadingTask);
    }
}

/**
 * 指定したページ番号配列のみをPNG画像として出力します。
 */
async function extractPdfPagesToImages(pdfPath, outputDir, dpi = 200, pageNumbers = []) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const pdfjsPackageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const standardFontDataUrl = path.join(pdfjsPackageDir, 'standard_fonts') + path.sep;
    const cMapUrl = path.join(pdfjsPackageDir, 'cmaps') + path.sep;
    const pdfBytes = fs.readFileSync(pdfPath);

    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        CanvasFactory: SafeCanvasFactory,
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        isEvalSupported: false
    });

    let sourcePdf = null;

    try {
        sourcePdf = await loadingTask.promise;
        const validPages = normalizePageNumbers(pageNumbers, sourcePdf.numPages);
        if (validPages.length === 0) {
            return [];
        }
        return await renderPdfPages(sourcePdf, outputDir, dpi, validPages);
    } finally {
        await cleanupPdfResources(sourcePdf, loadingTask);
    }
}

module.exports = {
    extractPdfToImages,
    extractPdfPagesToImages
};
