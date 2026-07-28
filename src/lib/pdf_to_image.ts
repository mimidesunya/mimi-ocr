const fs = require('fs');
const path = require('path');
const { createCanvas, DOMMatrix, ImageData } = require('canvas');
const { loadPdfjsLib } = require('./pdfjs_loader');

if (typeof globalThis.DOMMatrix === 'undefined' && DOMMatrix) {
    globalThis.DOMMatrix = DOMMatrix;
}
if (typeof globalThis.ImageData === 'undefined' && ImageData) {
    globalThis.ImageData = ImageData;
}

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

/**
 * レンダリング済みページの画素から、OCRへ送る必要のない白紙かを判定します。
 *
 * スキャン由来の薄い地色を白として扱いつつ、淡い文字を消さないように、
 * ページ内の明るい画素から推定した背景色に対して十分暗い画素だけを数えます。
 * 誤って本文を白紙扱いする方が危険なため、判定は意図的に保守的です。
 */
function isBlankImageData(imageData, options: any = {}) {
    const data = imageData?.data;
    const width = Number(imageData?.width) || 0;
    const height = Number(imageData?.height) || 0;
    if (!data || width <= 0 || height <= 0 || data.length < width * height * 4) {
        throw new Error('白紙判定用の画像データが不正です');
    }

    const maxSamples = Number(options.maxSamples) || 1_000_000;
    const totalPixels = width * height;
    const sampleStep = Math.max(1, Math.ceil(Math.sqrt(totalPixels / maxSamples)));
    const histogram = new Uint32Array(256);
    let sampleCount = 0;

    const getLuminance = (offset) => {
        const alpha = data[offset + 3] / 255;
        const source = (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
        return Math.max(0, Math.min(255, Math.round(255 - alpha * (255 - source))));
    };

    for (let y = 0; y < height; y += sampleStep) {
        for (let x = 0; x < width; x += sampleStep) {
            histogram[getLuminance((y * width + x) * 4)]++;
            sampleCount++;
        }
    }

    const backgroundPercentile = Number(options.backgroundPercentile) || 0.9;
    const percentileTarget = Math.max(1, Math.ceil(sampleCount * backgroundPercentile));
    let backgroundLuminance = 255;
    let accumulated = 0;
    for (let value = 0; value <= 255; value++) {
        accumulated += histogram[value];
        if (accumulated >= percentileTarget) {
            backgroundLuminance = value;
            break;
        }
    }

    const minContrast = Number(options.minContrast) || 20;
    const absoluteDarkLuminance = Number(options.absoluteDarkLuminance) || 235;
    const foregroundThreshold = Math.max(
        0,
        Math.min(absoluteDarkLuminance, backgroundLuminance - minContrast)
    );
    const minInkRatio = Number(options.minInkRatio) || 0.0002;
    const minInkPixels = Number(options.minInkPixels) || 48;
    const requiredInkSamples = Math.max(minInkPixels, Math.ceil(sampleCount * minInkRatio));

    let inkSamples = 0;
    for (let value = 0; value <= foregroundThreshold; value++) {
        inkSamples += histogram[value];
    }

    return inkSamples < requiredInkSamples;
}

/**
 * 指定PDFページを低解像度でレンダリングし、白紙ページ番号を返します。
 * 判定画像は保存せず、1ページずつ破棄してメモリ使用量を抑えます。
 */
async function detectBlankPdfPages(pdfPath, pageNumbers = [], dpi = 72, options: any = {}) {
    const pdfjsPackageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const standardFontDataUrl = path.join(pdfjsPackageDir, 'standard_fonts') + path.sep;
    const cMapUrl = path.join(pdfjsPackageDir, 'cmaps') + path.sep;
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfjsLib = await loadPdfjsLib();
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        CanvasFactory: SafeCanvasFactory,
        useSystemFonts: true,
        disableFontFace: false,
        useWorkerFetch: false,
        isEvalSupported: false
    });

    let sourcePdf = null;
    const blankPages = [];
    const renderCanvasFactory = new SafeCanvasFactory();

    try {
        sourcePdf = await loadingTask.promise;
        const validPages = normalizePageNumbers(pageNumbers, sourcePdf.numPages);
        const scale = dpi / 72;

        for (const pageNumber of validPages) {
            const page = await sourcePdf.getPage(pageNumber);
            let canvas = null;
            try {
                const viewport = page.getViewport({ scale });
                canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                const context = canvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({
                    canvasContext: context,
                    viewport,
                    canvasFactory: renderCanvasFactory,
                    background: 'rgb(255, 255, 255)'
                }).promise;

                const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                if (isBlankImageData(imageData, options)) {
                    blankPages.push(pageNumber);
                }
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

        return blankPages;
    } finally {
        await cleanupPdfResources(sourcePdf, loadingTask);
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
    const pdfjsLib = await loadPdfjsLib();
    
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        CanvasFactory: SafeCanvasFactory,
        useSystemFonts: true,
        disableFontFace: false,
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
    const pdfjsLib = await loadPdfjsLib();

    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        CanvasFactory: SafeCanvasFactory,
        useSystemFonts: true,
        disableFontFace: false,
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
    extractPdfPagesToImages,
    detectBlankPdfPages,
    isBlankImageData
};
