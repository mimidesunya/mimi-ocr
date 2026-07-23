const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
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
