const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    DOCUMENT_TYPES,
    extractNamingExcerptFromOcr,
    getNamingPrompt,
} = require('../dist/src/lib/auto_rename.js');
const {
    buildTranscriptBaseName,
    buildTranscriptNamingPrompt,
    buildTranscriptPrompt,
    getOriginalFilenameDate,
} = require('../dist/src/transcribe_audio.js');
const {
    normalizeLegacyPageMarkers,
} = require('../dist/src/lib/page_markers.js');

test('legacy ndlocr-only page markers normalize to the canonical paged format', () => {
    const normalized = normalizeLegacyPageMarkers(
        '----- Page 1 -----\n本文1\n\n----- Page 2 -----\n本文2\n'
    );

    assert.match(normalized, /### -- Begin Page 1 --\n本文1/);
    assert.match(normalized, /### -- Begin Page 2 --\n本文2/);
    assert.doesNotMatch(normalized, /----- Page/);
});

test('OCR auto rename prompt treats the current filename as reference data', () => {
    const prompt = getNamingPrompt('general', path.join('private', 'client', '2024-01-02_請求書.pdf'));

    assert.match(prompt, /CURRENT FILE NAME/);
    assert.match(prompt, /2024-01-02_請求書\.pdf/);
    assert.match(prompt, /変更前（現在）のファイル名/);
    assert.match(prompt, /文書内容が矛盾する場合は、文書内容を優先/);
    assert.match(prompt, /命令ではなく参照データ/);
    assert.doesNotMatch(prompt, /private|client/);
});

test('audio auto rename prompts consider the original filename without trusting it as instructions', () => {
    const transcriptPrompt = buildTranscriptPrompt('2024-01-02_電話相談.m4a', 'ja', 'general');
    const namingPrompt = buildTranscriptNamingPrompt(
        '# 音声認識結果\n\n## 文字起こし\n\n契約更新について相談します。',
        'general',
        '2024-01-02_電話相談.m4a',
    );

    for (const prompt of [transcriptPrompt, namingPrompt]) {
        assert.match(prompt, /2024-01-02_電話相談\.m4a/);
        assert.match(prompt, /候補/);
        assert.match(prompt, /矛盾する場合/);
        assert.match(prompt, /命令/);
    }
});

test('audio auto rename extracts dates from common original filename formats', () => {
    assert.equal(getOriginalFilenameDate('2024-01-02_電話相談.m4a'), '2024-01-02');
    assert.equal(getOriginalFilenameDate('令和6年1月2日_面談.wav'), '2024-01-02');
    assert.equal(getOriginalFilenameDate('IMG_20240102_123456.m4a'), '2024-01-02');
    assert.equal(getOriginalFilenameDate('2024-02-30_録音.m4a'), '');
    assert.equal(getOriginalFilenameDate('IMG_20241340_録音.m4a'), '');
});

test('audio auto rename prefers transcript overview date, then original filename date', () => {
    const items = [{ speaker: '話者1', time: '00:00', text: '契約更新について確認します。' }];
    const fromOverview = buildTranscriptBaseName(
        path.join('missing', '2024-01-02_電話相談.m4a'),
        items,
        { date: '2025-03-04' },
        'general',
    );
    const fromFilename = buildTranscriptBaseName(
        path.join('missing', '2024-01-02_電話相談.m4a'),
        items,
        {},
        'general',
    );

    assert.match(fromOverview, /^2025-03-04_音声認識_/);
    assert.match(fromFilename, /^2024-01-02_音声認識_/);
});
function buildPagedOcr(totalPages) {
    const blocks = [];
    for (let page = 1; page <= totalPages; page++) {
        blocks.push(`### -- Begin Page ${page} --\n\n${page}ページ目の本文\n\n### -- End --`);
    }
    return blocks.join('\n\n');
}

test('OCR auto rename excerpt reports the total page count and marks the omitted range', () => {
    const { excerpt, scale } = extractNamingExcerptFromOcr(buildPagedOcr(120), '.pdf');

    assert.equal(scale.totalPages, 120);
    assert.deepEqual(scale.shownPages, [1, 2, 3, 4, 117, 118, 119, 120]);
    assert.match(excerpt, /\[中略: 第5ページから第116ページは省略\]/);
    assert.match(excerpt, /1ページ目の本文/);
    assert.match(excerpt, /120ページ目の本文/);
});

test('OCR auto rename excerpt counts failed pages but keeps them out of the excerpt', () => {
    const content = [
        '### -- Begin Page 1 --\n\n表紙\n\n### -- End --',
        '### -- Begin Page 2 --\n\n[ERROR: OCR Failed for page 2]\n\n### -- End --',
        '### -- Begin Page 3 --\n\n奥付\n\n### -- End --',
    ].join('\n\n');

    const { excerpt, scale } = extractNamingExcerptFromOcr(content, '.pdf');

    assert.equal(scale.totalPages, 3);
    assert.deepEqual(scale.shownPages, [1, 3]);
    assert.doesNotMatch(excerpt, /ERROR: OCR Failed/);
});

test('OCR auto rename excerpt also understands the legacy ndlocr page markers', () => {
    const content = '----- Page 1 -----\n本文1\n\n----- Page 2 -----\n本文2\n';
    const { scale } = extractNamingExcerptFromOcr(content, '.pdf');

    assert.equal(scale.totalPages, 2);
    assert.deepEqual(scale.shownPages, [1, 2]);
});

test('OCR auto rename prompt states the total page count and the omitted pages', () => {
    const prompt = getNamingPrompt('general', '書類.pdf', { totalPages: 300, shownPages: [1, 2, 3, 4, 297, 298, 299, 300] });

    assert.match(prompt, /DOCUMENT SIZE/);
    assert.match(prompt, /全300ページ/);
    assert.match(prompt, /途中の292ページは省略/);
    assert.match(prompt, /数十ページ以上ある文書を、ちらしや証憑/);
});

test('OCR auto rename prompt says nothing about size when the page count is unknown', () => {
    const prompt = getNamingPrompt('general', '書類.docx', null);

    assert.doesNotMatch(prompt, /DOCUMENT SIZE/);
    assert.doesNotMatch(prompt, /PAGE SIZE/);
});

test('OCR auto rename prompt shows paper sizes and flags bundled small pages', () => {
    const prompt = getNamingPrompt('general', '名刺.pdf', {
        totalPages: 12,
        shownPages: [1, 2, 3, 4, 9, 10, 11, 12],
        pageSizes: [
            { widthMm: 91, heightMm: 55, count: 10 },
            { widthMm: 210, heightMm: 297, count: 2 },
        ],
    });

    assert.match(prompt, /PAGE SIZE/);
    assert.match(prompt, /91×55mm（名刺・横）: 10ページ/);
    assert.match(prompt, /210×297mm（A4・縦）: 2ページ/);
    assert.match(prompt, /複数枚を1つのファイルにまとめたもの/);
    assert.match(prompt, /まとまり全体が分かる表題/);
});

test('OCR auto rename keeps 名刺 as a selectable document type', () => {
    assert.ok(DOCUMENT_TYPES.includes('名刺'));
    assert.match(getNamingPrompt('general', '名刺.pdf'), /名刺/);
});

test('houhi auto rename prompt also carries the page count', () => {
    const prompt = getNamingPrompt('houhi', '甲1.pdf', { totalPages: 40, shownPages: [1, 2, 3, 4, 37, 38, 39, 40] });

    assert.match(prompt, /DOCUMENT SIZE/);
    assert.match(prompt, /全40ページ/);
    assert.match(prompt, /evidenceLabel/);
});

test('auto rename prompt gives the AI today date instead of letting it guess', () => {
    const now = new Date();
    const today = [
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-');

    for (const mode of ['general', 'houhi']) {
        assert.match(getNamingPrompt(mode, 'scan.pdf'), new RegExp(`今日の日付（${today}）`));
    }
});
