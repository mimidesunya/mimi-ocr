let pdfjsLibPromise = null;

async function loadPdfjsLib() {
    if (!pdfjsLibPromise) {
        const dynamicImport = new Function('specifier', 'return import(specifier)');
        pdfjsLibPromise = dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsLibPromise;
}

module.exports = {
    loadPdfjsLib
};
