/**
 * AI OCR の頁ごとの「怪しさ」の検知。
 *
 * 実務で起きた型（2026-09〜11）:
 * - 黒塗りの頁で ■ を数万字出し続け、後ろの内容が切れる（暴走）。
 * - 表を読まずに「本ページはOCRデータの断片的なテキストに基づいており…」と断ったうえで、ない年表を作文する（断り書き）。
 * - 段落ごと落とす、原本にない文を足す（字数の外れ。ndlocr の読みと比べて分かる）。
 * 見つけた頁は 1 頁ずつ読み直し、それでも残れば metadata の suspectPages に記して利用者に見せる。
 */

const MARKER_PATTERN = /^### -- (?:Begin Page \d+|End)\b.*$/gm;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const NO_TEXT_NOTE_PATTERN = /\(--!\s*文字なし\)/;

/** 字数を比べるための本文: 区切り・注記・空白・記号を除き、NFKC にする。 */
function bodyCharacters(text) {
    return String(text || '')
        .replace(COMMENT_PATTERN, '')
        .replace(MARKER_PATTERN, '')
        .replace(/\(--[!#*][^)]*\)/g, '')
        .normalize('NFKC')
        .replace(/[\s|:\-#*>_`~]/g, '');
}

/** 同じ字・同じ句の異常な繰り返し（■の暴走など）。理由の文を返す。 */
function detectRunaway(text) {
    const body = String(text || '').replace(COMMENT_PATTERN, '').replace(MARKER_PATTERN, '');
    const sameChar = body.match(/(.)\1{299,}/u);
    if (sameChar) {
        return `同じ字「${sameChar[1]}」が ${sameChar[0].length} 字続いています`;
    }
    // 2〜40 字の句が 15 回以上そのまま続く（空白・改行を挟んでもよい）。
    const repeated = body.match(/([^\s]{2,40}?)(?:\s*\1){14,}/u);
    if (repeated) {
        const count = Math.round(repeated[0].replace(/\s/g, '').length / repeated[1].length);
        return `同じ句「${repeated[1].slice(0, 20)}」が約 ${count} 回続いています`;
    }
    return null;
}

/**
 * AI が本文の代わりに自分の作業について書いた断り書き。
 * 書類の本文に出る言い回し（「判読できない」など）とぶつからないよう、AI の口ぶりに限る。
 */
const DISCLAIMER_PATTERNS = [
    /断片的な(?:テキスト|OCR|文字)/,
    /OCR(?:データ|テキスト|結果)(?:の断片|に基づ|から推測|をもとに)/,
    /(?:提供さ|入力さ|与えら)れた(?:テキスト|画像|OCR|データ)(?:に基づ|から|では|には|は)/,
    /(?:本|この)(?:ページ|頁)は.{0,30}(?:に基づいて|から推測|を推測|を再構成)/,
    /(?:画像|ページ)が(?:不鮮明|読み取れない)ため.{0,20}(?:推測|補完|再構成)/,
    /\b(?:based on the (?:provided|OCR|fragment)|I (?:cannot|can't) (?:read|see))/i
];

function detectDisclaimer(text) {
    const body = String(text || '').replace(COMMENT_PATTERN, '');
    for (const pattern of DISCLAIMER_PATTERNS) {
        const match = body.match(pattern);
        if (match) return `AI の断り書き「${match[0].slice(0, 30)}」があります`;
    }
    return null;
}

/**
 * ndlocr の読みと比べた字数の外れ。ndlocr は字を誤っても字数はおおむね合う。
 * 少なすぎれば取りこぼし、多すぎれば作文・重複を疑う。短い頁は比べない。
 */
function detectLengthOutlier(aiText, referenceText) {
    if (NO_TEXT_NOTE_PATTERN.test(String(aiText || ''))) return null;
    const ai = bodyCharacters(aiText).length;
    const ref = bodyCharacters(referenceText).length;
    if (ref < 150) return null;
    if (ai < ref * 0.55) {
        return `本文が ndlocr の読みの ${Math.round((ai / ref) * 100)}% しかありません（取りこぼしの疑い）`;
    }
    if (ai > ref * 1.8 + 300) {
        return `本文が ndlocr の読みの ${Math.round((ai / ref) * 100)}% あります（作文・重複の疑い）`;
    }
    return null;
}

/**
 * 頁の本文を調べ、疑わしければ理由を返す。referenceText は同じ頁の ndlocr の読み（無ければ null）。
 */
function assessOcrPage(aiText, referenceText = null) {
    return detectRunaway(aiText)
        || detectDisclaimer(aiText)
        || (referenceText ? detectLengthOutlier(aiText, referenceText) : null);
}

function findSuspectPages(pageMap, pageNumbers, referenceTextMap = null) {
    const found = [];
    for (const pageNum of pageNumbers || []) {
        if (!pageMap.has(pageNum)) continue;
        const reason = assessOcrPage(pageMap.get(pageNum), referenceTextMap ? referenceTextMap.get(pageNum) : null);
        if (reason) found.push({ page: pageNum, reason });
    }
    return found;
}

module.exports = {
    bodyCharacters,
    detectRunaway,
    detectDisclaimer,
    detectLengthOutlier,
    assessOcrPage,
    findSuspectPages
};
