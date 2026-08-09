const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildDocumentParameters,
} = require('../dist/src/lib/pdf_to_image.js');

// pdfjs は Node 上でも DOMMatrix / ImageData / Path2D をグローバルから探します。
// pdfjs 自身の polyfill は process.getBuiltinModule に依存するため Node 20.16 未満では
// 働かず、特に Path2D が無いとパス描画を含むPDFの描画が失敗します。
test('PDF rendering globals required by pdfjs are available', () => {
    for (const requiredGlobal of ['DOMMatrix', 'ImageData', 'Path2D']) {
        assert.notEqual(
            typeof globalThis[requiredGlobal],
            'undefined',
            `${requiredGlobal} が未定義です`
        );
    }
});

// disableFontFace が false のままだと、埋め込みフォントのグリフが解決されず、
// 本文が豆腐 (□) になったページを「成功」として出力してしまいます。
test('PDF document parameters disable font face so glyphs render as outlines', () => {
    const parameters = buildDocumentParameters(Buffer.alloc(0));
    assert.equal(parameters.disableFontFace, true);
    assert.equal(parameters.useSystemFonts, false);
});

test('PDF document parameters keep file paths lazy instead of copying the whole PDF', () => {
    const pdfPath = require('node:path').resolve('large-input.pdf');
    const parameters = buildDocumentParameters(pdfPath);

    assert.equal(parameters.url, pdfPath);
    assert.equal(Object.hasOwn(parameters, 'data'), false);
});

// CMap と標準フォントは pdfjs の Node 用リーダーに任せず自前で読みます。
// これが無いと CJK フォントのグリフを解決できません。
test('PDF document parameters supply file-based CMap and standard font readers', () => {
    const parameters = buildDocumentParameters(Buffer.alloc(0));
    assert.equal(typeof parameters.CMapReaderFactory, 'function');
    assert.equal(typeof parameters.StandardFontDataFactory, 'function');
    assert.equal(parameters.cMapPacked, true);
    assert.ok(parameters.cMapUrl.endsWith(require('node:path').sep));
    assert.ok(parameters.standardFontDataUrl.endsWith(require('node:path').sep));
});

// CMap リーダーが実際に pdfjs-dist 同梱の CJK CMap を読めることを確認します。
test('CMap reader loads a bundled CJK CMap from disk', async () => {
    const parameters = buildDocumentParameters(Buffer.alloc(0));
    const reader = new parameters.CMapReaderFactory({
        baseUrl: parameters.cMapUrl,
        isCompressed: parameters.cMapPacked,
    });
    const { cMapData, isCompressed } = await reader.fetch({ name: 'Adobe-Japan1-UCS2' });
    assert.equal(isCompressed, true);
    assert.ok(cMapData instanceof Uint8Array);
    assert.ok(cMapData.length > 0);
});
