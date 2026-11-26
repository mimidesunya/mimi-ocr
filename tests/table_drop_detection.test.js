const test = require('node:test');
const assert = require('node:assert/strict');

const {
    describesTableWithoutTranscribing,
    findDroppedTablePages,
    getOcrPrompt,
    getRawTextFormattingPrompt,
    getTodayDateInstruction,
} = require('../dist/src/lib/ai_ocr.js');

const DESCRIBED_TABLE_PAGE = [
    '### -- Begin Page 21 --',
    '',
    '(--! A table showing statistical data for various villages/towns.)',
    '',
    '### -- End (Printed Page 26) --',
].join('\n');

const TRANSCRIBED_TABLE_PAGE = [
    '### -- Begin Page 21 --',
    '',
    '| 郡 | 町村 | 戸数 | 人口 |',
    '| --- | --- | --- | --- |',
    '| 香川郡 | 鷺田村 | 18 | 95 |',
    '',
    '### -- End (Printed Page 26) --',
].join('\n');

test('表を説明文で置き換えた応答を検出する', () => {
    assert.equal(describesTableWithoutTranscribing(DESCRIBED_TABLE_PAGE), true);
    assert.equal(
        describesTableWithoutTranscribing('(--! 各町村の統計表が掲載されている)'),
        true
    );
});

test('表が書き起こされていれば検出しない', () => {
    assert.equal(describesTableWithoutTranscribing(TRANSCRIBED_TABLE_PAGE), false);
    // 説明と本体が両方あるページも取りこぼしではない
    assert.equal(
        describesTableWithoutTranscribing(
            '(--! A table showing statistics.)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
        ),
        false
    );
});

test('写真や図の注記を表の取りこぼしと誤判定しない', () => {
    assert.equal(describesTableWithoutTranscribing('(--! 表紙の写真。旗を持つ人物が写っている)'), false);
    assert.equal(describesTableWithoutTranscribing('(--! 工場の外観写真)'), false);
    assert.equal(describesTableWithoutTranscribing('本文だけのページ。表はない。'), false);
});

test('ページ単位で取りこぼしを列挙する', () => {
    const pageMap = new Map([
        [21, DESCRIBED_TABLE_PAGE],
        [22, TRANSCRIBED_TABLE_PAGE],
        [23, '### -- Begin Page 23 --\n\n本文のみ\n\n### -- End --'],
    ]);
    assert.deepEqual(findDroppedTablePages(pageMap, [21, 22, 23]), [21]);
});

test('OCRプロンプトが表の書き起こしを明示している', () => {
    const prompt = getOcrPrompt(4, '');
    assert.match(prompt, /\*\*Tables\*\*/);
    assert.match(prompt, /Markdown table/);
    assert.match(prompt, /never use it in place of a table/);
});

test('OCRプロンプトが今日の日付を伝え、年を直さないよう指示している', () => {
    const note = getTodayDateInstruction(new Date(2026, 10, 14));
    assert.match(note, /今日は令和8年（2026年）11月14日。令和8年11月までの日付は実在する過去の日付なので、年を直したり印を付けたりしない。/);
    assert.match(getTodayDateInstruction(new Date(2019, 4, 1)), /今日は令和元年（2019年）5月1日。令和元年5月まで/);
    const beforeReiwa = getTodayDateInstruction(new Date(2019, 3, 30));
    assert.match(beforeReiwa, /今日は2019年4月30日。2019年4月まで/);
    assert.doesNotMatch(beforeReiwa, /令和/);

    const today = getTodayDateInstruction();
    assert.ok(getOcrPrompt(4, '').includes(today));
    // ndlocr-lite の前処理の後に送る整形の指示にも入る。
    assert.ok(getRawTextFormattingPrompt('').includes(today));
});
