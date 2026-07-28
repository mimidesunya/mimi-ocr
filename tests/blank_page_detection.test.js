const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, rgb } = require('pdf-lib');

const {
    detectBlankPdfPages,
    isBlankImageData,
} = require('../dist/src/lib/pdf_to_image.js');
const {
    pdfToText,
} = require('../dist/src/lib/ai_ocr.js');

function createImageData(width, height, background = 255) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const offset = i * 4;
        data[offset] = background;
        data[offset + 1] = background;
        data[offset + 2] = background;
        data[offset + 3] = 255;
    }
    return { data, width, height };
}

function fillRect(imageData, left, top, width, height, value) {
    for (let y = top; y < top + height; y++) {
        for (let x = left; x < left + width; x++) {
            const offset = (y * imageData.width + x) * 4;
            imageData.data[offset] = value;
            imageData.data[offset + 1] = value;
            imageData.data[offset + 2] = value;
        }
    }
}

test('blank page detection accepts white and lightly tinted scanner backgrounds', () => {
    assert.equal(isBlankImageData(createImageData(400, 600, 255)), true);
    assert.equal(isBlankImageData(createImageData(400, 600, 238)), true);
});

test('blank page detection preserves pages containing a small amount of real ink', () => {
    const imageData = createImageData(400, 600, 246);
    fillRect(imageData, 80, 120, 60, 3, 40);
    fillRect(imageData, 80, 130, 45, 3, 40);
    assert.equal(isBlankImageData(imageData), false);

    const faintImageData = createImageData(400, 600, 242);
    fillRect(faintImageData, 80, 120, 60, 3, 215);
    assert.equal(isBlankImageData(faintImageData), false);
});

test('PDF blank page detection finds blank pages before OCR', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-blank-test-'));
    const pdfPath = path.join(tempDir, 'blank-and-content.pdf');

    try {
        const pdf = await PDFDocument.create();
        pdf.addPage([400, 600]);
        const contentPage = pdf.addPage([400, 600]);
        contentPage.drawRectangle({
            x: 80,
            y: 450,
            width: 80,
            height: 12,
            color: rgb(0, 0, 0),
        });
        fs.writeFileSync(pdfPath, await pdf.save());

        assert.deepEqual(await detectBlankPdfPages(pdfPath, [1, 2]), [1]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('PDF OCR writes blank page markers without calling an OCR provider', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-blank-output-test-'));
    const pdfPath = path.join(tempDir, 'blank-pages.pdf');

    try {
        const pdf = await PDFDocument.create();
        pdf.addPage([400, 600]);
        pdf.addPage([400, 600]);
        fs.writeFileSync(pdfPath, await pdf.save());

        const outputPath = await pdfToText(
            pdfPath,
            2,
            1,
            null,
            '',
            'gemini',
            'sync',
            false,
            false,
            false
        );
        const markdown = fs.readFileSync(outputPath, 'utf8');

        assert.equal(outputPath.endsWith('_paged.md'), true);
        assert.match(markdown, /### -- Begin Page 1 --\s+### -- End --/);
        assert.match(markdown, /### -- Begin Page 2 --\s+### -- End --/);
        assert.doesNotMatch(markdown, /\[ERROR: OCR Failed/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
