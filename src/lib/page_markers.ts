/**
 * ndlocr-only のページ境界を、AI OCR と後処理ツールが使う標準形式へ正規化する。
 * 本文と末尾メタデータは変更しない。
 */
function normalizeLegacyPageMarkers(content) {
    return String(content || '').replace(
        /^----- Page (\d+) -----\s*$/gm,
        '### -- Begin Page $1 --'
    );
}

module.exports = {
    normalizeLegacyPageMarkers,
};
