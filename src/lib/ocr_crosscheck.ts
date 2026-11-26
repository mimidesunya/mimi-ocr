/**
 * 二重読みの照合。
 *
 * AI の読みと ndlocr-lite の読み（手元・無料）で、日付・事件番号・号証番号・金額などの数字を突き合わせ、
 * 食い違いを頁画像の切り抜きと並べた HTML にまとめる。OCR の結果は正本ではなく、
 * 一字が効く所は原本の画像で確かめる、という運用を、利用者が自分で回せるようにするためのもの。
 * 食い違いはどちらが正しいかを決めない（ndlocr もよく読み違える）。確かめる場所を示すだけ。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

type KeyToken = { kind: string; value: string; raw: string; index: number };

const KIND_LABELS = {
    case: '事件番号',
    date: '日付',
    exhibit: '号証',
    number: '数字・金額'
};

const TOKEN_PATTERNS: Array<[string, RegExp]> = [
    ['case', /(?:令和|平成|昭和)(?:\d+|元)年[(（][^)）]{1,4}[)）]第?\d+号/g],
    ['date', /(?:(?:令和|平成|昭和)(?:\d+|元)|\d{4})年\d{1,2}月\d{1,2}日|(?<!\d)\d{1,2}月\d{1,2}日/g],
    ['exhibit', /[甲乙丙丁]第?\d+(?:号証)?(?:の\d+)*/g],
    ['number', /\d{1,3}(?:,\d{3})+|\d{3,}/g]
];

/** 比べるための文字列: NFKC にし、空白（改行を含む）と Markdown の記号を除く。 */
function normalizeForCompare(text) {
    return String(text || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^### -- (?:Begin Page \d+|End)\b.*$/gm, '')
        .normalize('NFKC')
        .replace(/[\s*#|>`_]/g, '');
}

function normalizeToken(kind, value) {
    let v = String(value || '').replace(/,/g, '');
    if (kind === 'exhibit') v = v.replace(/第/g, '').replace(/号証/g, '');
    return v;
}

/** 文字列から照合する語を取り出す。事件番号・日付の中の数字は数字として二重に数えない。 */
function extractKeyTokens(text): KeyToken[] {
    const s = normalizeForCompare(text);
    const taken: Array<[number, number]> = [];
    const tokens: KeyToken[] = [];
    for (const [kind, pattern] of TOKEN_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(s)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            if (taken.some(([a, b]) => start < b && end > a)) continue;
            taken.push([start, end]);
            tokens.push({ kind, value: normalizeToken(kind, m[0]), raw: m[0], index: start });
        }
    }
    return tokens.sort((a, b) => a.index - b.index);
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_v, i) => [i, ...new Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[m][n];
}

/** 多重集合の差。AI にだけある語と、ndlocr にだけある語。 */
function diffTokens(aiTokens: KeyToken[], refTokens: KeyToken[]) {
    const remaining = new Map();
    for (const t of refTokens) {
        const key = `${t.kind}:${t.value}`;
        remaining.set(key, [...(remaining.get(key) || []), t]);
    }
    const aiOnly = [];
    for (const t of aiTokens) {
        const key = `${t.kind}:${t.value}`;
        const list = remaining.get(key);
        if (list && list.length > 0) list.shift();
        else aiOnly.push(t);
    }
    const refOnly = [];
    for (const list of remaining.values()) refOnly.push(...list);
    return { aiOnly, refOnly: refOnly.sort((a, b) => a.index - b.index) };
}

/**
 * 表のセルは ndlocr が行を分けて読む（「令和8」と「年2月27日」）。語の数字の並びが、
 * もう一方の読みの中で同じ順に、数字を挟まず近くに（間は12字まで）出ていれば、
 * 読めているものとして食い違いに数えない。数字は前後に数字の続かないまとまりとして比べる。
 */
function looselyPresent(token: KeyToken, otherNorm: string) {
    const groups = String(token.raw || '').replace(/,/g, '').match(/\d+/g);
    if (!groups || groups.length === 0) return false;
    const pattern = new RegExp(groups.map(g => `(?<!\\d)${g}(?!\\d)`).join('\\D{0,12}'));
    return pattern.test(otherNorm.replace(/,/g, ''));
}

/** 似た語どうしを組にする（ndlocr が「合和18年」、AI が「令和8年」のような読み違いの対）。 */
function pairMismatches(aiOnly: KeyToken[], refOnly: KeyToken[]) {
    const pairs = [];
    const usedRef = new Set();
    for (const ai of aiOnly) {
        let best = null;
        let bestDistance = Infinity;
        for (const ref of refOnly) {
            if (usedRef.has(ref) || ref.kind !== ai.kind) continue;
            const d = levenshtein(ai.value, ref.value);
            if (d < bestDistance) { best = ref; bestDistance = d; }
        }
        if (best && bestDistance <= Math.max(2, Math.ceil(Math.max(ai.value.length, best.value.length) / 3))) {
            usedRef.add(best);
            pairs.push({ kind: ai.kind, ai, ref: best });
        } else {
            pairs.push({ kind: ai.kind, ai, ref: null });
        }
    }
    for (const ref of refOnly) {
        if (!usedRef.has(ref)) pairs.push({ kind: ref.kind, ai: null, ref });
    }
    return pairs;
}

function contextAround(normalized, token, width = 18) {
    if (!token) return null;
    const end = token.index + token.raw.length;
    return {
        before: normalized.slice(Math.max(0, token.index - width), token.index),
        mark: normalized.slice(token.index, end),
        after: normalized.slice(end, Math.min(normalized.length, end + width))
    };
}

function readNdlocrLines(jsonPath) {
    if (!jsonPath || !fs.existsSync(jsonPath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const lines = (data?.contents?.[0] || [])
            .filter(item => Array.isArray(item.boundingBox))
            .map(item => {
                const xs = item.boundingBox.map(pt => Number(pt[0]));
                const ys = item.boundingBox.map(pt => Number(pt[1]));
                return {
                    text: normalizeForCompare(item.text || ''),
                    confidence: Number(item.confidence),
                    vertical: String(item.isVertical) === 'true',
                    box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
                };
            });
        return { lines, width: Number(data?.imginfo?.img_width) || null, height: Number(data?.imginfo?.img_height) || null };
    } catch (_e) {
        return null;
    }
}

function bigrams(s) {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
}

/** 語を含む ndlocr の行。無ければ前後の文脈といちばん重なる行。 */
function locateLine(lines, value, contextText) {
    if (!lines || lines.length === 0) return null;
    if (value) {
        const direct = lines.find(line => line.text.replace(/,/g, '').includes(value));
        if (direct) return direct;
    }
    const ctx = bigrams(String(contextText || ''));
    if (ctx.size === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const line of lines) {
        let score = 0;
        for (const g of bigrams(line.text)) if (ctx.has(g)) score++;
        if (score > bestScore) { best = line; bestScore = score; }
    }
    return bestScore >= 3 ? best : null;
}

async function cropLineImage(imagePath, line, pageSize) {
    if (!imagePath || !line || !fs.existsSync(imagePath)) return null;
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(fs.readFileSync(imagePath));
    const w = img.width;
    const h = img.height;
    const lineH = Math.max(20, line.box.y1 - line.box.y0);
    const lineW = Math.max(20, line.box.x1 - line.box.x0);
    let x0, y0, x1, y1;
    if (line.vertical) {
        x0 = line.box.x0 - lineW * 1.5; x1 = line.box.x1 + lineW * 1.5;
        y0 = line.box.y0 - 30; y1 = line.box.y1 + 30;
    } else {
        x0 = Math.min(line.box.x0, w * 0.05) - 20; x1 = Math.max(line.box.x1, w * 0.95) + 20;
        y0 = line.box.y0 - lineH * 1.2; y1 = line.box.y1 + lineH * 1.2;
    }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
    const sw = x1 - x0;
    const sh = y1 - y0;
    if (sw <= 0 || sh <= 0) return null;
    const scale = Math.min(1, 1100 / sw);
    const canvas = createCanvas(Math.round(sw * scale), Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x0, y0, sw, sh, 0, 0, canvas.width, canvas.height);
    // 該当の行に枠を付ける
    ctx.strokeStyle = 'rgba(220, 0, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect((line.box.x0 - x0) * scale - 3, (line.box.y0 - y0) * scale - 3, lineW * scale + 6, lineH * scale + 6);
    const jpeg = await canvas.encode('jpeg', 72);
    return `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderContext(ctx) {
    if (!ctx) return '<span class="none">（この語は読んでいない）</span>';
    return `${escapeHtml(ctx.before)}<mark>${escapeHtml(ctx.mark)}</mark>${escapeHtml(ctx.after)}`;
}

function buildReportHtml(sourceName, items, summary) {
    const rows = items.map(item => `
<section class="item">
  <h3>${item.page} 頁 ・ ${escapeHtml(KIND_LABELS[item.kind] || item.kind)}${item.confidence !== null ? ` <span class="conf">ndlocr の確信度 ${item.confidence.toFixed(2)}</span>` : ''}</h3>
  <div class="reads">
    <div><span class="label">AI の読み</span><p>${renderContext(item.aiContext)}</p></div>
    <div><span class="label">ndlocr の読み</span><p>${renderContext(item.refContext)}</p></div>
  </div>
  ${item.ai ? '' : '<p class="note">ndlocr だけが読んだ語です。多くは ndlocr の読み違いですが、AI が落とした可能性もあります。</p>'}
  ${item.image ? `<img src="${item.image}" alt="${item.page} 頁の該当箇所">` : '<p class="none">該当箇所の画像を切り出せませんでした。頁全体を原本で確かめてください。</p>'}
</section>`).join('\n');
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>照合: ${escapeHtml(sourceName)}</title>
<style>
body{font-family:"Yu Gothic UI","Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f6f6f4;color:#222}
header{background:#fff;border-bottom:1px solid #ddd;padding:16px 20px}
h1{font-size:18px;margin:0 0 6px} header p{margin:4px 0;font-size:14px;line-height:1.6}
main{max-width:1180px;margin:0 auto;padding:12px 16px 40px}
.item{background:#fff;border:1px solid #ddd;border-radius:6px;margin:12px 0;padding:12px 14px}
.item h3{font-size:15px;margin:0 0 8px}.conf{font-weight:normal;color:#777;font-size:12px;margin-left:8px}
.reads{display:grid;grid-template-columns:1fr 1fr;gap:12px}.reads p{margin:4px 0 10px;font-size:15px;line-height:1.7;word-break:break-all}
.label{font-size:12px;color:#666}.note{font-size:13px;color:#8a5a00;margin:0 0 8px}mark{background:#ffe08a;padding:0 2px}
img{max-width:100%;border:1px solid #ccc;display:block}.none{color:#999}
@media (max-width:700px){.reads{grid-template-columns:1fr}}
</style></head><body>
<header><h1>照合: ${escapeHtml(sourceName)}</h1>
<p>AI と ndlocr-lite（手元の OCR）の読みで、日付・事件番号・号証番号・数字が食い違った所です。どちらが正しいかは決めていないので、画像の原本で確かめ、必要なら OCR の結果（_paged.md）を直してください。</p>
<p>${summary.pages} 頁を照合し、食い違い ${summary.mismatches} 件${summary.truncated ? `（多いので先頭の ${items.length} 件だけ載せています）` : ''}。AI の読みに ndlocr と違う語がある所（AI が書き換えた・作った疑い）を先に、ndlocr だけが読んだ語を後に並べています。</p>
</header>
<main>
${rows || '<p>食い違いはありませんでした。</p>'}
</main></body></html>`;
}

/**
 * 頁ごとに照合して、食い違いがあれば HTML を書く。
 * pageMap: AI の読み（頁番号 → 本文）、refTextMap: ndlocr の読み、ndlocrOutDir: page_NNNN.json のある所。
 */
async function runCrossCheck({ pdfPath, pages, pageMap, refTextMap, ndlocrOutDir, imageDpi, reportPath, renderPages, maxItems = 300 }) {
    const items = [];
    let checkedPages = 0;
    for (const pageNum of pages) {
        if (!pageMap.has(pageNum) || !refTextMap.has(pageNum)) continue;
        const aiText = pageMap.get(pageNum);
        const refText = refTextMap.get(pageNum);
        if (/mimi-ocr-fallback:/.test(String(aiText))) continue;
        checkedPages++;
        const aiNorm = normalizeForCompare(aiText);
        const refNorm = normalizeForCompare(refText);
        const diff = diffTokens(extractKeyTokens(aiText), extractKeyTokens(refText));
        const aiOnly = diff.aiOnly.filter(t => !looselyPresent(t, refNorm));
        const refOnly = diff.refOnly.filter(t => !looselyPresent(t, aiNorm));
        for (const pair of pairMismatches(aiOnly, refOnly)) {
            items.push({
                page: pageNum,
                kind: pair.kind,
                ai: pair.ai,
                ref: pair.ref,
                aiContext: contextAround(aiNorm, pair.ai),
                refContext: contextAround(refNorm, pair.ref),
                confidence: null,
                image: null
            });
        }
    }
    const summary = { pages: checkedPages, mismatches: items.length, truncated: items.length > maxItems, report: null };
    if (items.length === 0) return summary;

    // 該当頁だけを ndlocr と同じ解像度で描き直し、行の座標で切り抜く。
    const pagesWithItems = Array.from(new Set(items.map(item => item.page)));
    const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi_crosscheck_'));
    try {
        let imagePaths = [];
        try {
            imagePaths = await renderPages(pdfPath, imgDir, imageDpi, pagesWithItems);
        } catch (_e) {
            imagePaths = [];
        }
        const imageFor = (pageNum) => imagePaths.find(p => path.basename(p) === `page_${String(pageNum).padStart(4, '0')}.png`) || null;
        for (const item of items) {
            const json = readNdlocrLines(ndlocrOutDir ? path.join(ndlocrOutDir, `page_${String(item.page).padStart(4, '0')}.json`) : null);
            const contextText = item.aiContext ? `${item.aiContext.before}${item.aiContext.after}` : '';
            const line = json ? locateLine(json.lines, item.ref?.value || item.ai?.value, contextText) : null;
            item.confidence = line && Number.isFinite(line.confidence) ? line.confidence : null;
            item.line = line;
        }
        const priority = item => (item.ai ? 0 : 1);
        items.sort((a, b) => priority(a) - priority(b) || (b.confidence ?? -1) - (a.confidence ?? -1) || a.page - b.page);
        const shown = items.slice(0, maxItems);
        for (const item of shown) {
            try {
                item.image = await cropLineImage(imageFor(item.page), item.line, null);
            } catch (_e) {
                item.image = null;
            }
        }
        shown.sort((a, b) => priority(a) - priority(b) || a.page - b.page || (b.confidence ?? -1) - (a.confidence ?? -1));
        fs.writeFileSync(reportPath, buildReportHtml(path.basename(pdfPath), shown, summary), 'utf8');
        summary.report = reportPath;
    } finally {
        try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (_e) { }
    }
    return summary;
}

module.exports = {
    normalizeForCompare,
    extractKeyTokens,
    diffTokens,
    pairMismatches,
    looselyPresent,
    locateLine,
    buildReportHtml,
    runCrossCheck,
    KIND_LABELS
};
