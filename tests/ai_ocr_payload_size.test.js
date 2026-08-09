const test = require('node:test');
const assert = require('node:assert/strict');

const {
    estimateRequestsPayloadBytes,
} = require('../dist/src/lib/ai_ocr.js');

test('batch payload sizing matches JSON bytes without stringifying the complete array', () => {
    const requests = [
        { contents: [{ parts: [{ text: '日本語' }] }] },
        { contents: [{ parts: [{ inlineData: { data: 'A'.repeat(1024) } }] }] },
    ];
    const expected = Buffer.byteLength(JSON.stringify(requests), 'utf8');

    assert.equal(estimateRequestsPayloadBytes(requests), expected);
});
