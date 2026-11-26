/**
 * 出力の型（target）の自動判定。
 *
 * 法匪（houhi）の型は裁判書面の見本を AI に渡す。スライドや行政の資料をこの型で読ませると、
 * 原本にない「原告:甲野太郎」「準備書面」などの文を作ることがあった（2026-10-01、開示文書のスライド）。
 * 既定を「自動」にし、最初の頁の文字から裁判書面らしいときだけ houhi にする。
 */

const CASE_NUMBER_PATTERN = /(?:令和|平成|昭和)(?:\d+|元)年[(（][^)）]{1,4}[)）]第?\d+号/;
const PARTY_PATTERN = /(?:原告|被告|控訴人|被控訴人|上告人|被上告人|申立人|相手方|債権者|債務者|抗告人|審査請求人|請求人)/g;
const TITLE_PATTERN = /(?:訴状|答弁書|準備書面|証拠説明書|陳述書|判決|決定書|上申書|申立書|控訴状|控訴理由書|上告理由書|意見書|審査請求書|反論書|弁明書|期日請書|送付書|事務連絡)/;

function normalizeSample(text) {
    return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

/** 裁判書面らしさの点数と根拠。 */
function scoreCourtDocument(text) {
    const sample = normalizeSample(text);
    const reasons = [];
    let score = 0;
    if (CASE_NUMBER_PATTERN.test(sample)) { score += 3; reasons.push('事件番号'); }
    if (/裁判所/.test(sample)) { score += 1; reasons.push('裁判所'); }
    if (/御中/.test(sample)) { score += 1; reasons.push('御中'); }
    const parties = new Set(sample.match(PARTY_PATTERN) || []);
    if (parties.size >= 2) { score += 2; reasons.push(`当事者（${Array.from(parties).slice(0, 3).join('・')}）`); }
    const title = sample.match(TITLE_PATTERN);
    if (title) { score += 2; reasons.push(`表題（${title[0]}）`); }
    if (/号証/.test(sample)) { score += 1; reasons.push('号証'); }
    if (/主文/.test(sample)) { score += 2; reasons.push('主文'); }
    return { score, reasons };
}

const COURT_DOCUMENT_THRESHOLD = 4;

function detectOcrTarget(text) {
    const { score, reasons } = scoreCourtDocument(text);
    const sampleLength = normalizeSample(text).length;
    if (sampleLength < 20) {
        return { target: 'general', score, reasons, insufficient: true };
    }
    return {
        target: score >= COURT_DOCUMENT_THRESHOLD ? 'houhi' : 'general',
        score,
        reasons,
        insufficient: false
    };
}

module.exports = {
    scoreCourtDocument,
    detectOcrTarget,
    COURT_DOCUMENT_THRESHOLD
};
