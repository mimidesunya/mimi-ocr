const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('OCR CLI exits with an error when an input cannot be processed', () => {
    const scriptPath = path.resolve(__dirname, '..', 'dist', 'src', 'ocr.js');
    const missingPath = path.resolve(__dirname, 'fixtures', '__definitely_missing__.pdf');
    const result = spawnSync(process.execPath, [scriptPath, missingPath, '--no_ndlocr'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[エラー\] パスが見つかりません/);
    assert.match(result.stderr, /1 件失敗しました/);
    assert.doesNotMatch(result.stdout, /すべての処理が完了しました/);
});
