const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const { detectRunaway, detectDisclaimer, detectLengthOutlier, findSuspectPages } = require('../dist/src/lib/ocr_quality.js');
const { detectOcrTarget } = require('../dist/src/lib/doc_type.js');
const { UsageMeter, estimateOcrCost, findModelPrice } = require('../dist/src/lib/usage_meter.js');
const { extractKeyTokens, diffTokens, pairMismatches, looselyPresent, normalizeForCompare } = require('../dist/src/lib/ocr_crosscheck.js');
const { buildNdlocrReferenceParts } = require('../dist/src/lib/ai_ocr.js');

// ---- 検知 ----

test('runaway: a long run of the same character or phrase is detected', () => {
    assert.match(detectRunaway('### -- Begin Page 1 --\n' + '■'.repeat(400) + '\n### -- End --'), /■/);
    assert.match(detectRunaway('本文。' + '令和8年1月1日 '.repeat(20)), /同じ句/);
    assert.equal(detectRunaway('■■■■■（黒塗り）の後に本文が続く。'), null);
});

test('disclaimer: AI talking about its own reading is detected, ordinary legal prose is not', () => {
    assert.match(detectDisclaimer('本ページはOCRデータの断片的なテキストに基づいており、年表を再構成した。'), /断り書き/);
    assert.match(detectDisclaimer('提供されたテキストに基づいて整形しました。'), /断り書き/);
    assert.equal(detectDisclaimer('原告の筆跡は判読できない部分がある（甲3）。'), null);
});

test('length outlier: far shorter or longer than the ndlocr reading', () => {
    const ref = 'あ'.repeat(600);
    assert.match(detectLengthOutlier('い'.repeat(200), ref), /取りこぼし/);
    assert.match(detectLengthOutlier('い'.repeat(1600), ref), /作文/);
    assert.equal(detectLengthOutlier('い'.repeat(580), ref), null);
    assert.equal(detectLengthOutlier('い'.repeat(10), 'あ'.repeat(100)), null, 'short pages are not compared');
    assert.equal(detectLengthOutlier('### -- Begin Page 1 --\n(--! 文字なし)\n### -- End --', ref), null);
    const pages = new Map([[1, '■'.repeat(500)], [2, 'ふつうの本文']]);
    assert.deepEqual(findSuspectPages(pages, [1, 2]).map(item => item.page), [1]);
});

// ---- 出力の型 ----

test('court documents are detected, slides and notices are not', () => {
    const court = detectOcrTarget('令和8年(ワ)第412号 損害賠償請求事件\n原告 山田一郎\n被告 川上次郎\n準備書面(3)\n横浜地方裁判所第7民事部 御中');
    assert.equal(court.target, 'houhi');
    const judgment = detectOcrTarget('令和6年(行ヒ)第362号 保有個人情報不開示決定処分取消請求事件 判決 主文 本件上告を棄却する。上告人 被上告人');
    assert.equal(judgment.target, 'houhi');
    const slide = detectOcrTarget('更生保護 ×  コラボ企画 キービジュアル A案 B案 スケジュール 2026年4月');
    assert.equal(slide.target, 'general');
    assert.equal(detectOcrTarget('').insufficient, true);
});

// ---- 費用 ----

test('usage is summed per model and priced from the table', () => {
    const table = { asOf: '2026-11-26', models: { 'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 } } };
    assert.ok(findModelPrice('models/gemini-3.1-flash-lite', table));
    assert.ok(findModelPrice('gemini-3.1-flash-lite-002', table));
    const meter = new UsageMeter();
    meter.addResponse('gemini-3.1-flash-lite', { usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 100000, thoughtsTokenCount: 100000 } });
    meter.addResponse('unknown-model', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    assert.equal(meter.addResponse('x', { candidates: [] }), false);
    const summary = meter.summary(table);
    assert.equal(summary.inputTokens, 1000010);
    assert.equal(summary.outputTokens, 200005);
    assert.equal(summary.estimatedUsd, 0.55);
    assert.deepEqual(summary.unpricedModels, ['unknown-model']);
    const estimate = estimateOcrCost('gemini-3.1-flash-lite', 10, 4, table);
    assert.ok(estimate.estimatedUsd > 0);
    assert.equal(estimateOcrCost('nope', 10, 4, table).estimatedUsd, null);
});

// ---- 照合 ----

test('key tokens: case numbers, dates, exhibits and amounts', () => {
    const tokens = extractKeyTokens('令和8年(ワ)第412号。令和8年2月27日に金3,850,000円を支払った（乙2の1、甲第4号証）。同年5月8日。');
    const kinds = tokens.map(t => `${t.kind}:${t.value}`);
    assert.ok(kinds.includes('case:令和8年(ワ)第412号'));
    assert.ok(kinds.includes('date:令和8年2月27日'));
    assert.ok(kinds.includes('number:3850000'));
    assert.ok(kinds.includes('exhibit:乙2の1'));
    assert.ok(kinds.includes('exhibit:甲4'));
    assert.ok(kinds.includes('date:5月8日'));
    assert.ok(!kinds.includes('number:412'), 'digits inside a case number are not counted twice');
});

test('a changed year is reported as a pair; a date split across ndlocr lines is not a mismatch', () => {
    const ai = '支払期日は令和6年2月27日とされた。代金は3,850,000円。';
    const ref = '支払期日は令和8年2月27日とされた。代金は3,850,000円。';
    const { aiOnly, refOnly } = diffTokens(extractKeyTokens(ai), extractKeyTokens(ref));
    const pairs = pairMismatches(aiOnly, refOnly);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].ai.value, '令和6年2月27日');
    assert.equal(pairs[0].ref.value, '令和8年2月27日');

    const split = normalizeForCompare('支払期日を令和8\n売買契約書\n年2月27日');
    assert.equal(looselyPresent(extractKeyTokens('令和8年2月27日')[0], split), true);
    assert.equal(looselyPresent(extractKeyTokens('令和6年2月27日')[0], split), false);
});

test('hint reference parts carry the ndlocr reading and say the image is authoritative', () => {
    const parts = buildNdlocrReferenceParts([5, 6], new Map([[5, '一行目\n二行目'], [6, '']]));
    assert.equal(parts.length, 1);
    assert.match(parts[0].text, /page images are authoritative/);
    assert.match(parts[0].text, /--- Reference for page 1 ---\n一行目/);
    assert.match(parts[0].text, /--- Reference for page 2 ---\n\(no text detected\)/);
    assert.deepEqual(buildNdlocrReferenceParts([1], new Map([[1, '']])), []);
    assert.deepEqual(buildNdlocrReferenceParts([1], null), []);
});

// ---- pdfToText を通して: hint・自動の型・検知の読み直し・照合・費用 ----

function writeFakeNdlocr(root, pageTexts) {
    const repo = path.join(root, 'fake-ndlocr');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "ndlocr-lite"\nversion = "2.0.0"\n');
    fs.writeFileSync(path.join(repo, 'texts.json'), JSON.stringify(pageTexts));
    // node で動く偽の ocr.py。画像の名前（page_NNNN.png）に合わせて txt と json を書く。
    fs.writeFileSync(path.join(repo, 'src', 'ocr.py'), `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const src = args[args.indexOf('--sourcedir') + 1];
const out = args[args.indexOf('--output') + 1];
const texts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'texts.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(src)) {
    const m = name.match(/^page_(\\d+)\\.png$/);
    if (!m) continue;
    const text = texts[String(Number(m[1]))] || '';
    fs.writeFileSync(path.join(out, 'page_' + m[1] + '.txt'), text);
    const lines = text.split('\\n').map((t, i) => ({ boundingBox: [[100, 100 + i * 60], [100, 150 + i * 60], [1500, 100 + i * 60], [1500, 150 + i * 60]], text: t, confidence: 0.95, isVertical: 'false' }));
    fs.writeFileSync(path.join(out, 'page_' + m[1] + '.json'), JSON.stringify({ contents: [lines], imginfo: { img_width: 1700, img_height: 2200 } }));
}
`);
    return repo;
}

test('pdfToText: hint mode, automatic target, a runaway page is re-read, the changed year is cross-checked, usage is recorded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-quality-e2e-'));
    const previousConfigPath = process.env.MIMI_OCR_CONFIG;
    const GeminiBatchProcessor = require('../dist/src/lib/gemini_batch.js');
    const originalRunSync = GeminiBatchProcessor.prototype.runSync;
    const { pdfToText } = require('../dist/src/lib/ai_ocr.js');
    const calls = [];
    try {
        const page1 = [
            '令和8年(ワ)第412号 損害賠償請求事件',
            '原告 山田一郎 被告 川上次郎',
            '準備書面(3) 横浜地方裁判所第7民事部 御中',
            '支払期日は令和8年2月27日とされ、代金は3,850,000円であった。'
        ].join('\n');
        const page2 = Array.from({ length: 12 }, (_v, i) => `第${i + 1}段 原告の主張には理由がなく、被告は期限までに履行の準備をしていた。`).join('\n');
        const repo = writeFakeNdlocr(tempDir, { 1: page1, 2: page2 });
        const configPath = path.join(tempDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
            providers: { gemini: { apiKey: 'synthetic-test-key', chatModels: ['gemini-3.1-flash-lite'] } },
            tools: { rootDir: path.join(tempDir, 'tools'), ndlocrLite: { repoPath: repo, pythonPath: process.execPath, parallelJobs: 1, imageDpi: 72 } }
        }));
        process.env.MIMI_OCR_CONFIG = configPath;

        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (let i = 0; i < 2; i++) pdf.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 40, y: 700, size: 12, font });
        const pdfPath = path.join(tempDir, 'brief.pdf');
        fs.writeFileSync(pdfPath, await pdf.save());

        let page2Calls = 0;
        GeminiBatchProcessor.prototype.runSync = async function (requests, modelId) {
            return requests.map(request => {
                const texts = request.contents[0].parts.filter(p => p.text).map(p => p.text);
                const hasImage = request.contents[0].parts.some(p => p.inlineData?.mimeType === 'image/png');
                const reference = texts.find(t => t.includes('REFERENCE TEXT FROM A LOCAL OCR ENGINE')) || '';
                const prompt = texts[texts.length - 1];
                calls.push({ modelId, hasImage, reference, prompt });
                const usageMetadata = { promptTokenCount: 1200, candidatesTokenCount: 300 };
                if (reference.includes('第412号')) {
                    return { response: { candidates: [{ content: { parts: [{ text: '### -- Begin Page 1 --\n\n令和8年(ワ)第412号\n\n支払期日は令和6年2月27日とされ、代金は3,850,000円であった。\n\n### -- End --' }] }, finishReason: 'STOP' }], usageMetadata }, error: null };
                }
                page2Calls++;
                const body = page2Calls === 1 ? '■'.repeat(800) : page2;
                return { response: { candidates: [{ content: { parts: [{ text: `### -- Begin Page 1 --\n\n${body}\n\n### -- End --` }] }, finishReason: 'STOP' }], usageMetadata }, error: null };
            });
        };

        const resultPath = await pdfToText(pdfPath, 1, 1, null, 'GENERAL-CONTEXT', 'gemini', 'sync', true, false, false, {}, {
            ndlocrHint: true,
            targetAuto: { houhi: 'HOUHI-CONTEXT', general: 'GENERAL-CONTEXT', houhiContextFile: 'houhi_sample.md' }
        });
        const result = fs.readFileSync(resultPath, 'utf8');

        assert.match(resultPath, /brief_paged\.md$/);
        assert.ok(calls.every(c => c.hasImage), 'hint mode sends page images');
        assert.ok(calls.every(c => c.reference.length > 0), 'every request, including the retry, carries the ndlocr reading');
        assert.ok(calls.every(c => c.prompt.includes('HOUHI-CONTEXT')), 'the court document got the houhi style');
        assert.equal(page2Calls, 2, 'the runaway page was read again');
        assert.doesNotMatch(result, /■{100}/);
        assert.match(result, /"ndlocr": "hint"/);
        assert.match(result, /"target": "houhi"/);
        assert.match(result, /"targetAuto": true/);
        assert.match(result, /"mismatches": 1/);
        assert.match(result, /"inputTokens": 3600/);
        const report = path.join(tempDir, 'brief_照合.html');
        assert.ok(fs.existsSync(report));
        const html = fs.readFileSync(report, 'utf8');
        assert.match(html, /令和6年2月27日/);
        assert.match(html, /令和8年2月27日/);
    } finally {
        GeminiBatchProcessor.prototype.runSync = originalRunSync;
        if (previousConfigPath === undefined) delete process.env.MIMI_OCR_CONFIG;
        else process.env.MIMI_OCR_CONFIG = previousConfigPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('CLI without any API key reads with ndlocr-lite only (the free path)', async () => {
    const { spawnSync } = require('child_process');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-free-path-'));
    try {
        const repo = writeFakeNdlocr(tempDir, { 1: '無料の道で読んだ本文。令和8年11月26日。' });
        const configPath = path.join(tempDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
            providers: { gemini: { apiKey: '' } },
            tools: { rootDir: path.join(tempDir, 'tools'), ndlocrLite: { repoPath: repo, pythonPath: process.execPath, parallelJobs: 1, imageDpi: 72 } }
        }));
        const pdf = await PDFDocument.create();
        pdf.addPage([612, 792]).drawText('free', { x: 40, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
        const pdfPath = path.join(tempDir, 'free.pdf');
        fs.writeFileSync(pdfPath, await pdf.save());
        const env = { ...process.env, MIMI_OCR_CONFIG: configPath };
        delete env.GEMINI_API_KEY;
        delete env.GOOGLE_API_KEY;
        const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'src', 'ocr.js'), pdfPath, '--no_searchable_pdf'], { env, encoding: 'utf8' });
        const log = `${run.stdout}\n${run.stderr}`;
        assert.equal(run.status, 0, log);
        assert.match(log, /API キーが設定されていないため、無料の ndlocr-lite だけで読みます/);
        const out = fs.readFileSync(path.join(tempDir, 'free_paged.md'), 'utf8');
        assert.match(out, /----- Page 1 -----/);
        assert.match(out, /無料の道で読んだ本文/);
        assert.match(out, /"ndlocr": "only"/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
