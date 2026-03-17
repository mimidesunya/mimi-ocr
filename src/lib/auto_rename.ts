const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const GeminiBatchProcessor = require('./gemini_batch');
const { ClaudeOcrProcessor } = require('./claude_client');
const { OpenAIOcrProcessor } = require('./openai_client');
const { getGeminiChatModel } = require('./gemini_client');

const NAMING_FRONT_PAGES = 4;
const NAMING_BACK_PAGES = 4;
const TITLE_MAX_LENGTH = 80;
const TEXT_EXCERPT_MAX_CHARS = 12000;
const AUTO_RENAME_PATTERN = /^\d{4}-\d{2}-\d{2}_[^_]+_.+$/;
const DOCUMENT_TYPES = Object.freeze([
    '図書',
    '記事',
    'ちらし',
    'パンフレット',
    '書簡',
    '証憑',
    '帳票',
    '契約',
    '法務',
    '会議資料',
    '報告資料',
    'その他'
]);

function isAutoRenameFormatted(filePath) {
    const ext = path.extname(filePath);
    const stem = ext ? path.basename(filePath, ext) : path.basename(filePath);
    return AUTO_RENAME_PATTERN.test(stem);
}

function getNamingPrompt() {
    return `
# ROLE
日本語文書の冒頭と末尾を読み、ファイル名用のメタデータを決めるアシスタントです。

# TASK
与えられた文書の最初の${NAMING_FRONT_PAGES}ページと最後の${NAMING_BACK_PAGES}ページだけを読み、次の3項目を決めてください。

1. date
- 文書を識別するのに最も適切な文書日付
- 和暦は西暦に変換
- 形式は必ず YYYY-MM-DD
- 年しか分からなければ YYYY-00-00
- 年月まで分かれば YYYY-MM-00
- 全く分からなければ今日の日付を使う

2. documentType
- 以下の候補から必ず1つだけ選ぶ
- ${DOCUMENT_TYPES.join(' / ')}

3. title
- 日本語の簡潔なタイトル
- 可能なら文書中の正式タイトルを優先
- 不明なら内容を要約した短い表題を作る
- 40文字程度まで
- 拡張子や説明文は付けない

# OUTPUT
JSONのみを返してください。コードブロックや説明は禁止です。
{"date":"YYYY-MM-DD","documentType":"文書種類","title":"タイトル"}
`;
}

function getTodayDateString() {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t\u3000]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function sanitizeTitle(title) {
    let value = normalizeWhitespace(title)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/[_]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .trim();

    if (!value) value = '表題不明';
    if (value.length > TITLE_MAX_LENGTH) {
        value = value.slice(0, TITLE_MAX_LENGTH).trim();
    }
    return value || '表題不明';
}

function normalizeDateValue(raw) {
    const match = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return getTodayDateString();

    const year = match[1];
    const month = match[2];
    const day = match[3];
    const monthNum = Number(month);
    const dayNum = Number(day);

    const validMonth = month === '00' || (monthNum >= 1 && monthNum <= 12);
    const validDay = day === '00' || (dayNum >= 1 && dayNum <= 31);
    if (year === '0000' || !validMonth || !validDay) return getTodayDateString();
    return `${year}-${month}-${day}`;
}

function normalizeDecision(raw) {
    const documentType = DOCUMENT_TYPES.includes(raw?.documentType)
        ? raw.documentType
        : DOCUMENT_TYPES.includes(raw?.type)
            ? raw.type
            : 'その他';

    const title = sanitizeTitle(raw?.title || raw?.documentTitle || raw?.name || '');
    const date = normalizeDateValue(raw?.date);

    return { date, documentType, title };
}

function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function parseDecisionText(text) {
    const cleaned = stripCodeFence(text);
    const candidates = [];
    const fullMatch = cleaned.match(/\{[\s\S]*\}/);
    if (fullMatch) {
        candidates.push(fullMatch[0]);
    }
    candidates.push(cleaned);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            return normalizeDecision(parsed);
        } catch (_e) {
        }
    }

    return {
        date: getTodayDateString(),
        documentType: 'その他',
        title: sanitizeTitle(cleaned.split('\n')[0] || '')
    };
}

function getResponseText(result) {
    if (result?.response?.candidates?.[0]?.content?.parts) {
        return result.response.candidates[0].content.parts
            .map(part => part?.text || '')
            .join('');
    }
    return '';
}

function selectHeadAndTailItems(items, frontCount = NAMING_FRONT_PAGES, backCount = NAMING_BACK_PAGES) {
    if (!items || items.length === 0) {
        return [];
    }

    const selectedIndices = new Set<number>();
    for (let i = 0; i < Math.min(frontCount, items.length); i++) {
        selectedIndices.add(i);
    }
    for (let i = Math.max(0, items.length - backCount); i < items.length; i++) {
        selectedIndices.add(i);
    }

    return items.filter((_item, index) => selectedIndices.has(index));
}

function extractPageBlocks(content, regex) {
    const blocks = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
        const block = match[0].trim();
        if (!block.includes('[ERROR: OCR Failed')) {
            blocks.push(block);
        }
    }

    return blocks;
}

function extractBeginPageBlocks(content) {
    const blocks = extractPageBlocks(content, /### -- Begin Page (\d+)[\s\S]*?(?=### -- Begin Page \d+|$)/g);
    return selectHeadAndTailItems(blocks);
}

function extractDashPageBlocks(content) {
    const blocks = extractPageBlocks(content, /----- Page (\d+) -----[\s\S]*?(?=----- Page \d+ -----|$)/g);
    return selectHeadAndTailItems(blocks);
}

function extractHeadAndTailText(content, maxChars = TEXT_EXCERPT_MAX_CHARS) {
    const normalized = normalizeWhitespace(content);
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxChars) {
        return normalized.trim();
    }

    const headChars = Math.floor(maxChars / 2);
    const tailChars = maxChars - headChars;
    const head = normalized.slice(0, headChars).trim();
    const tail = normalized.slice(-tailChars).trim();

    return [head, '[中略]', tail]
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

function getNamingPageIndices(totalPages) {
    const indices = new Set<number>();

    for (let i = 0; i < Math.min(NAMING_FRONT_PAGES, totalPages); i++) {
        indices.add(i);
    }
    for (let i = Math.max(0, totalPages - NAMING_BACK_PAGES); i < totalPages; i++) {
        indices.add(i);
    }

    return Array.from(indices).sort((a, b) => a - b);
}

function extractNamingExcerptFromOcr(content, sourceExt) {
    const beginBlocks = extractBeginPageBlocks(content);
    if (beginBlocks.length > 0) {
        return beginBlocks.join('\n\n');
    }

    const dashBlocks = extractDashPageBlocks(content);
    if (dashBlocks.length > 0) {
        return dashBlocks.join('\n\n');
    }

    if (sourceExt !== '.pdf') {
        return extractHeadAndTailText(content);
    }

    return '';
}

function getOutputPathCandidates(sourcePath, preferredOutputPath = null) {
    const ext = path.extname(sourcePath);
    const stem = path.basename(sourcePath, ext);
    const dir = path.dirname(sourcePath);
    const candidates = [];

    if (preferredOutputPath) {
        candidates.push(preferredOutputPath);
    }

    candidates.push(path.join(dir, `${stem}_paged.md`));
    candidates.push(path.join(dir, `${stem}_ERROR_paged.md`));
    candidates.push(path.join(dir, `${stem}_merged.md`));
    candidates.push(path.join(dir, `${stem}_ERROR_merged.md`));

    return [...new Set(candidates.filter(Boolean).map(p => path.resolve(p)))];
}

function readExcerptFromExistingOutput(sourcePath, preferredOutputPath = null) {
    const ext = path.extname(sourcePath).toLowerCase();
    for (const candidatePath of getOutputPathCandidates(sourcePath, preferredOutputPath)) {
        if (!fs.existsSync(candidatePath)) continue;
        try {
            const content = fs.readFileSync(candidatePath, 'utf-8');
            const excerpt = extractNamingExcerptFromOcr(content, ext);
            if (excerpt) {
                return excerpt;
            }
        } catch (e) {
            console.warn(`[自動改名] OCR結果の読込に失敗しました: ${candidatePath} / ${e.message}`);
        }
    }
    return '';
}

async function createPdfSubsetRequest(pdfPath) {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const subsetDoc = await PDFDocument.create();
    const pageIndices = getNamingPageIndices(totalPages);
    const copiedPages = await subsetDoc.copyPages(srcDoc, pageIndices);

    copiedPages.forEach(page => subsetDoc.addPage(page));
    const subsetBytes = await subsetDoc.save();

    return {
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: 'application/pdf',
                            data: Buffer.from(subsetBytes).toString('base64')
                        }
                    },
                    { text: getNamingPrompt() }
                ]
            }
        ]
    };
}

function createTextExcerptRequest(excerpt) {
    return {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: "--- OCR TEXT START ---\n" + excerpt + "\n--- OCR TEXT END ---" },
                    { text: getNamingPrompt() }
                ]
            }
        ]
    };
}

async function runNamingRequest(request, aiProvider = 'gemini') {
    const progressState = {
        completed: 0,
        total: 1,
        startTime: Date.now()
    };

    if (aiProvider === 'claude') {
        const processor = new ClaudeOcrProcessor();
        return (await processor.runBatch([request], progressState, 1))[0];
    }

    if (aiProvider === 'openai') {
        const processor = new OpenAIOcrProcessor();
        return (await processor.runSync([request], progressState, 1))[0];
    }

    const processor = new GeminiBatchProcessor();
    const modelId = getGeminiChatModel();
    return (await processor.runSync([request], modelId, progressState))[0];
}

function buildRenamePairs(oldPath, newPath) {
    const oldExt = path.extname(oldPath);
    const newExt = path.extname(newPath);
    const oldStem = path.basename(oldPath, oldExt);
    const newStem = path.basename(newPath, newExt);
    const dir = path.dirname(oldPath);
    const pairs = [
        {
            from: path.join(dir, `${oldStem}_paged.md`),
            to: path.join(dir, `${newStem}_paged.md`)
        },
        {
            from: path.join(dir, `${oldStem}_ERROR_paged.md`),
            to: path.join(dir, `${newStem}_ERROR_paged.md`)
        },
        {
            from: path.join(dir, `${oldStem}_merged.md`),
            to: path.join(dir, `${newStem}_merged.md`)
        },
        {
            from: path.join(dir, `${oldStem}_ERROR_merged.md`),
            to: path.join(dir, `${newStem}_ERROR_merged.md`)
        },
        {
            from: `${oldPath}.batch_state.txt`,
            to: `${newPath}.batch_state.txt`
        },
        {
            from: oldPath,
            to: newPath
        }
    ];

    return pairs.filter(pair => path.resolve(pair.from).toLowerCase() !== path.resolve(pair.to).toLowerCase());
}

function applyRenamePairs(pairs) {
    const existingPairs = pairs.filter(pair => fs.existsSync(pair.from));
    const seenTargets = new Set();

    for (const pair of existingPairs) {
        const targetKey = path.resolve(pair.to).toLowerCase();
        if (seenTargets.has(targetKey)) {
            throw new Error(`同じ変更先が重複しています: ${pair.to}`);
        }
        seenTargets.add(targetKey);
        if (fs.existsSync(pair.to)) {
            throw new Error(`変更先が既に存在します: ${pair.to}`);
        }
    }

    const renamedPairs = [];
    try {
        for (const pair of existingPairs) {
            fs.renameSync(pair.from, pair.to);
            renamedPairs.push(pair);
        }
    } catch (err) {
        for (let i = renamedPairs.length - 1; i >= 0; i--) {
            const pair = renamedPairs[i];
            try {
                if (fs.existsSync(pair.to)) {
                    fs.renameSync(pair.to, pair.from);
                }
            } catch (_rollbackError) {
            }
        }
        throw err;
    }
}

async function maybeAutoRenameDocument(sourcePath, ocrOutputPath = null, aiProvider = 'gemini') {
    const absSourcePath = path.resolve(sourcePath);
    if (isAutoRenameFormatted(absSourcePath)) {
        console.log(`[自動改名] 既に形式通りのため変更しません: ${path.basename(absSourcePath)}`);
        return absSourcePath;
    }

    let request = null;
    const excerpt = readExcerptFromExistingOutput(absSourcePath, ocrOutputPath);
    if (excerpt) {
        request = createTextExcerptRequest(excerpt);
    } else if (path.extname(absSourcePath).toLowerCase() === '.pdf') {
        console.log(`[自動改名] OCR結果に先頭${NAMING_FRONT_PAGES}ページと末尾${NAMING_BACK_PAGES}ページが無いため、元PDFの該当ページを直接判定します`);
        request = await createPdfSubsetRequest(absSourcePath);
    } else {
        console.warn(`[自動改名] 先頭${NAMING_FRONT_PAGES}ページと末尾${NAMING_BACK_PAGES}ページ相当のOCRテキストが得られなかったため、改名をスキップします: ${path.basename(absSourcePath)}`);
        return absSourcePath;
    }

    console.log(`[自動改名] AIでファイル名を判定中: ${path.basename(absSourcePath)}`);
    const result = await runNamingRequest(request, aiProvider);
    if (result?.error) {
        throw new Error(result.error.message || 'AI 判定に失敗しました');
    }

    const text = getResponseText(result);
    const decision = parseDecisionText(text);
    const newBaseName = `${decision.date}_${decision.documentType}_${decision.title}`;
    const ext = path.extname(absSourcePath);
    const newPath = path.join(path.dirname(absSourcePath), `${newBaseName}${ext}`);

    if (path.resolve(newPath).toLowerCase() === absSourcePath.toLowerCase()) {
        return absSourcePath;
    }

    const renamePairs = buildRenamePairs(absSourcePath, newPath);
    applyRenamePairs(renamePairs);

    console.log(`[自動改名] ${path.basename(absSourcePath)} -> ${path.basename(newPath)}`);
    return newPath;
}

module.exports = {
    DOCUMENT_TYPES,
    isAutoRenameFormatted,
    maybeAutoRenameDocument
};
