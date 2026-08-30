const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const {
    detectBlankPdfPages,
    isBlankImageData,
} = require('../dist/src/lib/pdf_to_image.js');
const {
    pdfToText,
    applyOcrBatchTextResult,
    confirmRepeatedEmptyPdfPages,
    createIndependentRetryBudget,
    extractPagesFromMarkdown,
    runGeminiRequestsWithRecoveryTransport,
    summarizeAiResponse,
    selectNextGeminiModel,
    runSingleBatch,
    recoverPagesFromTrustedEmbeddedText,
} = require('../dist/src/lib/ai_ocr.js');
const {
    normalizeModelPriority,
    getGeminiChatModels,
} = require('../dist/src/lib/gemini_client.js');

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

test('partial Gemini OCR keeps useful pages and isolates an omitted page for retry', () => {
    const pageMap = new Map();
    const emptyResponseCounts = new Map();
    const text = [
        '### -- Begin Page 1 --',
        '',
        '領収書の本文',
        '',
        '### -- End --',
    ].join('\n');

    const first = applyOcrBatchTextResult(text, [1, 2], pageMap, emptyResponseCounts);

    assert.deepEqual(first.usefulPages, [1]);
    assert.deepEqual(first.emptyPages, [2]);
    assert.deepEqual(first.unresolvedPages, [2]);
    assert.match(pageMap.get(1), /領収書の本文/);
    assert.equal(pageMap.has(2), false);
    assert.equal(emptyResponseCounts.get(2), 1);

    applyOcrBatchTextResult('', [2], pageMap, emptyResponseCounts);
    assert.match(pageMap.get(1), /領収書の本文/);
    assert.equal(pageMap.has(2), false);
    assert.equal(emptyResponseCounts.get(2), 2);
});

test('split single-page recovery gets a full retry budget after parent exhaustion', () => {
    const retryBudget = createIndependentRetryBudget(3);
    const parentRequest = 10;
    const singlePageRequest = 11;

    assert.equal(retryBudget.begin(parentRequest), 1);
    assert.equal(retryBudget.begin(parentRequest), 2);
    assert.equal(retryBudget.begin(parentRequest), 3);
    assert.equal(retryBudget.canRetry(parentRequest), false);

    assert.equal(retryBudget.count(singlePageRequest), 0);
    assert.equal(retryBudget.canRetry(singlePageRequest), true);
    assert.equal(retryBudget.begin(singlePageRequest), 1);
    assert.equal(retryBudget.begin(singlePageRequest), 2);
    assert.equal(retryBudget.begin(singlePageRequest), 3);
    assert.equal(retryBudget.canRetry(singlePageRequest), false);
});

test('repeated-empty fallback confirms scanner specks but preserves a content page', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-repeated-empty-test-'));
    const pdfPath = path.join(tempDir, 'scanner-specks.pdf');

    try {
        const pdf = await PDFDocument.create();
        const contentPage = pdf.addPage([400, 600]);
        contentPage.drawRectangle({
            x: 80,
            y: 430,
            width: 180,
            height: 24,
            color: rgb(0, 0, 0),
        });
        const speckledPage = pdf.addPage([400, 600]);
        for (let i = 0; i < 90; i++) {
            speckledPage.drawRectangle({
                x: 10 + ((i * 37) % 360),
                y: 10 + ((i * 53) % 560),
                width: 1,
                height: 1,
                color: rgb(0.2, 0.2, 0.2),
            });
        }
        fs.writeFileSync(pdfPath, await pdf.save());

        assert.deepEqual(await detectBlankPdfPages(pdfPath, [1, 2]), []);
        assert.deepEqual(await confirmRepeatedEmptyPdfPages(pdfPath, [1, 2]), [2]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('response diagnostics expose stop metadata without OCR text', () => {
    const diagnostic = summarizeAiResponse({
        promptFeedback: {
            blockReason: 'SAFETY',
            safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }],
        },
        candidates: [{
            finishReason: 'SAFETY',
            content: { parts: [{ text: '秘密のOCR本文' }] },
        }],
    });

    assert.match(diagnostic, /candidateCount=1/);
    assert.match(diagnostic, /textChars=8/);
    assert.match(diagnostic, /finishReasons=SAFETY/);
    assert.match(diagnostic, /promptBlockReason=SAFETY/);
    assert.match(diagnostic, /HARM_CATEGORY_DANGEROUS_CONTENT:HIGH/);
    assert.doesNotMatch(diagnostic, /秘密のOCR本文/);
});

test('resume parser removes prior settings comments from the last page', () => {
    const markdown = [
        '### -- Begin Page 1 --',
        '',
        '本文',
        '',
        '### -- End --',
        '',
        '<!-- mimi-ocr-settings',
        '{"build":"old"}',
        '-->',
    ].join('\n');

    const pages = extractPagesFromMarkdown(markdown);
    assert.equal(pages.size, 1);
    assert.match(pages.get(1), /本文/);
    assert.doesNotMatch(pages.get(1), /mimi-ocr-settings|"build":"old"/);
});

test('Batch recovery requests switch to sync while preserving result order', async () => {
    const calls = [];
    const batchProcessor = {
        async runInlineBatch(requests, modelId) {
            calls.push({ transport: 'batch', count: requests.length, modelId });
            return requests.map(() => ({ response: { id: 'batch' }, error: null }));
        },
        async runSync(requests, modelId, _progress, maxRetries) {
            calls.push({ transport: 'sync', count: requests.length, modelId, maxRetries });
            return requests.map(() => ({ response: { id: 'sync' }, error: null }));
        },
    };

    const results = await runGeminiRequestsWithRecoveryTransport(
        [{ contents: ['regular'] }, { contents: ['recovery'] }],
        [{ pages: [1], modelId: 'gemini-primary' }, { pages: [2], forceSync: true, modelId: 'gemini-fallback' }],
        batchProcessor,
        null,
        null,
        'batch'
    );

    assert.deepEqual(calls, [
        { transport: 'batch', count: 1, modelId: 'gemini-primary' },
        { transport: 'sync', count: 1, modelId: 'gemini-fallback', maxRetries: 1 },
    ]);
    assert.equal(results[0].response.id, 'batch');
    assert.equal(results[1].response.id, 'sync');
});

test('Gemini model priority preserves a legacy primary without reading a real config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-model-priority-test-'));
    const configPath = path.join(tempDir, 'config.json');
    const previousConfigPath = process.env.MIMI_OCR_CONFIG;
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            providers: { gemini: { chatModel: 'legacy-current-model' } }
        }));
        process.env.MIMI_OCR_CONFIG = configPath;

        assert.deepEqual(getGeminiChatModels(), [
            'legacy-current-model',
            'gemini-3.5-flash-lite',
            'gemini-3.6-flash',
        ]);
        assert.deepEqual(normalizeModelPriority([
            ' model-a ',
            'model-a',
            '',
            'model-b',
            'model-c',
            'model-d',
        ]), ['model-a', 'model-b', 'model-c']);
    } finally {
        if (previousConfigPath === undefined) delete process.env.MIMI_OCR_CONFIG;
        else process.env.MIMI_OCR_CONFIG = previousConfigPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini model fallback advances on technical failure but stops on explicit safety', () => {
    const models = ['model-1', 'model-2', 'model-3'];
    assert.deepEqual(selectNextGeminiModel(models, 0), { modelIndex: 1, modelId: 'model-2' });
    assert.deepEqual(selectNextGeminiModel(models, 1), { modelIndex: 2, modelId: 'model-3' });
    assert.equal(selectNextGeminiModel(models, 2), null);
    assert.equal(selectNextGeminiModel(models, 0, {
        promptFeedback: { blockReason: 'SAFETY' }
    }), null);
    assert.equal(selectNextGeminiModel(models, 0, {
        candidates: [{ finishReason: 'PROHIBITED_CONTENT' }]
    }), null);
});

test('PDF OCR retries only the unresolved page with the next Gemini model', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-model-fallback-pdf-test-'));
    const pdfPath = path.join(tempDir, 'model-fallback.pdf');
    const configPath = path.join(tempDir, 'config.json');
    const previousConfigPath = process.env.MIMI_OCR_CONFIG;
    const GeminiBatchProcessor = require('../dist/src/lib/gemini_batch.js');
    const originalRunSync = GeminiBatchProcessor.prototype.runSync;
    const modelCalls = [];
    try {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const page = pdf.addPage([612, 792]);
        page.drawText(
            'Synthetic content page must remain nonblank while the first model repeatedly returns no text. '.repeat(4),
            { x: 40, y: 700, size: 9, font, maxWidth: 520 }
        );
        fs.writeFileSync(pdfPath, await pdf.save());
        fs.writeFileSync(configPath, JSON.stringify({
            providers: {
                gemini: {
                    apiKey: 'synthetic-test-key',
                    chatModels: ['model-primary', 'model-secondary', 'model-tertiary']
                }
            }
        }));
        process.env.MIMI_OCR_CONFIG = configPath;

        GeminiBatchProcessor.prototype.runSync = async function (requests, modelId) {
            modelCalls.push(modelId);
            if (modelId === 'model-primary') {
                return requests.map(() => ({
                    response: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
                    error: null
                }));
            }
            return requests.map(() => ({
                response: {
                    candidates: [{
                        content: {
                            parts: [{ text: '### -- Begin Page 1 --\n\nRecovered by secondary model.\n\n### -- End --' }]
                        },
                        finishReason: 'STOP'
                    }]
                },
                error: null
            }));
        };

        const resultPath = await pdfToText(pdfPath, 1, 1, 1, '', 'gemini', 'sync');
        const result = fs.readFileSync(resultPath, 'utf8');

        assert.deepEqual(modelCalls, [
            'model-primary',
            'model-primary',
            'model-primary',
            'model-secondary'
        ]);
        assert.match(result, /Recovered by secondary model/);
        assert.doesNotMatch(result, /\[ERROR: OCR Failed/);
    } finally {
        GeminiBatchProcessor.prototype.runSync = originalRunSync;
        if (previousConfigPath === undefined) delete process.env.MIMI_OCR_CONFIG;
        else process.env.MIMI_OCR_CONFIG = previousConfigPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('single-document Gemini processing changes model after a thrown technical error', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-single-model-fallback-test-'));
    const configPath = path.join(tempDir, 'config.json');
    const previousConfigPath = process.env.MIMI_OCR_CONFIG;
    const modelCalls = [];
    try {
        fs.writeFileSync(configPath, JSON.stringify({
            providers: {
                gemini: {
                    chatModels: ['single-primary', 'single-secondary', 'single-tertiary']
                }
            }
        }));
        process.env.MIMI_OCR_CONFIG = configPath;
        const processor = {
            async runSync(requests, modelId) {
                modelCalls.push(modelId);
                if (modelId === 'single-primary') throw new Error('synthetic transport failure');
                return requests.map(() => ({
                    response: {
                        candidates: [{ content: { parts: [{ text: 'recovered document' }] }, finishReason: 'STOP' }]
                    },
                    error: null
                }));
            }
        };

        const results = await runSingleBatch(
            [{ contents: ['synthetic'] }],
            processor,
            null,
            'synthetic-job',
            null,
            'gemini',
            'sync'
        );

        assert.deepEqual(modelCalls, ['single-primary', 'single-secondary']);
        assert.equal(results[0].response.candidates[0].content.parts[0].text, 'recovered document');
    } finally {
        if (previousConfigPath === undefined) delete process.env.MIMI_OCR_CONFIG;
        else process.env.MIMI_OCR_CONFIG = previousConfigPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('trusted neighboring text layers recover an AI-rejected page locally', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-embedded-fallback-test-'));
    const pdfPath = path.join(tempDir, 'trusted-text-layer.pdf');

    try {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const texts = [
            'Neighbor page one contains a trustworthy embedded text layer repeated for validation. '.repeat(3),
            'Rejected middle page still contains complete embedded text that can be recovered locally. '.repeat(3),
            'Neighbor page three contains another trustworthy embedded text layer for validation. '.repeat(3),
        ];
        for (const text of texts) {
            const page = pdf.addPage([600, 800]);
            page.drawText(text, { x: 40, y: 700, size: 9, font, maxWidth: 520 });
        }
        fs.writeFileSync(pdfPath, await pdf.save());

        const pageMap = new Map([
            [1, `### -- Begin Page 1 --\n\n${texts[0]}\n\n### -- End --`],
            [3, `### -- Begin Page 3 --\n\n${texts[2]}\n\n### -- End --`],
        ]);
        const recovered = await recoverPagesFromTrustedEmbeddedText(pdfPath, [2], pageMap, 3);

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].pageNum, 2);
        assert.match(pageMap.get(2), /mimi-ocr-fallback: embedded-pdf-text/);
        assert.match(pageMap.get(2), /Rejected middle page still contains complete embedded text/);
        assert.doesNotMatch(pageMap.get(2), /\[ERROR: OCR Failed/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('embedded-text recovery cannot cascade through consecutive unresolved pages', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-text-fallback-chain-test-'));
    const pdfPath = path.join(tempDir, 'embedded-chain.pdf');
    try {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const texts = [
            'Trusted first page contains enough embedded text to validate only its immediate neighbor safely.',
            'First unresolved page contains enough embedded text and may be recovered from the trusted first page.',
            'Second unresolved page must not use the newly recovered second page as its only trust anchor.'
        ];
        for (const text of texts) {
            const page = pdf.addPage([612, 792]);
            page.drawText(text, { x: 40, y: 700, size: 9, font, maxWidth: 520 });
        }
        fs.writeFileSync(pdfPath, await pdf.save());

        const pageMap = new Map([
            [1, `### -- Begin Page 1 --\n\n${texts[0]}\n\n### -- End --`],
        ]);
        const recovered = await recoverPagesFromTrustedEmbeddedText(pdfPath, [2, 3], pageMap, 3);

        assert.deepEqual(recovered.map(item => item.pageNum), [2]);
        assert.equal(pageMap.has(2), true);
        assert.equal(pageMap.has(3), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resume locally recovers a trusted embedded-text page before creating an AI request', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-text-fallback-resume-test-'));
    const pdfPath = path.join(tempDir, 'resume.pdf');
    const errorPath = path.join(tempDir, 'resume_ERROR_paged.md');
    const normalPath = path.join(tempDir, 'resume_paged.md');
    try {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const texts = [
            'First successful OCR page closely matches the embedded PDF text layer for local validation. '.repeat(3),
            'Previously rejected middle page contains valid embedded text and should not be sent again. '.repeat(3),
            'Third successful OCR page also confirms that the embedded PDF text layer is trustworthy. '.repeat(3)
        ];
        for (const text of texts) {
            const page = pdf.addPage([612, 792]);
            page.drawText(text, { x: 40, y: 700, size: 9, font, maxWidth: 520 });
        }
        fs.writeFileSync(pdfPath, await pdf.save());
        fs.writeFileSync(errorPath, [
            `### -- Begin Page 1 --\n\n${texts[0]}\n\n### -- End --`,
            '### -- Begin Page 2 --\n\n[ERROR: OCR Failed for page 2]\n\n### -- End --',
            `### -- Begin Page 3 --\n\n${texts[2]}\n\n### -- End --`,
            '<!-- mimi-ocr-settings {"hasError":true} -->'
        ].join('\n\n'));

        const resultPath = await pdfToText(pdfPath, 3, 1, 3, '', 'gemini', 'batch');
        const result = fs.readFileSync(normalPath, 'utf8');

        assert.equal(resultPath, normalPath);
        assert.equal(fs.existsSync(errorPath), false);
        assert.match(result, /mimi-ocr-fallback: embedded-pdf-text/);
        assert.match(result, /Previously rejected middle page contains valid embedded text/);
        assert.doesNotMatch(result, /\[ERROR: OCR Failed/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
