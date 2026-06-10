const { pathToFileURL } = require('url');
const fs = require('fs');

let pdfjsLibPromise = null;

function tryResolve(specifier) {
    try {
        const resolved = require.resolve(specifier);
        return fs.existsSync(resolved) ? resolved : null;
    } catch (_err) {
        return null;
    }
}

async function loadPdfjsLib() {
    if (!pdfjsLibPromise) {
        const dynamicImport = new Function('specifier', 'return import(specifier)');
        const mjsPath = tryResolve('pdfjs-dist/legacy/build/pdf.mjs') || tryResolve('pdfjs-dist/build/pdf.mjs');
        if (mjsPath) {
            pdfjsLibPromise = dynamicImport(pathToFileURL(mjsPath).href);
        } else {
            const jsPath = tryResolve('pdfjs-dist/legacy/build/pdf.js') || tryResolve('pdfjs-dist/build/pdf.js');
            if (!jsPath) {
                throw new Error('pdfjs-dist のビルドファイルが見つかりません。pdfjs-dist を再インストールしてください。');
            }
            pdfjsLibPromise = Promise.resolve(require(jsPath));
        }
    }
    return pdfjsLibPromise;
}

module.exports = {
    loadPdfjsLib
};
