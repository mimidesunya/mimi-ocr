const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const AdminZip = require('adm-zip');
const WordExtractor = require('word-extractor');
const GeminiBatchProcessor = require('./gemini_batch');
const { ClaudeOcrProcessor } = require('./claude_client');
const { OpenAIOcrProcessor } = require('./openai_client');
const os = require('os');
const { loadPdfjsLib } = require('./pdfjs_loader');
const { extractPdfPagesToImages, detectBlankPdfPages, buildDocumentParameters, cleanupPdfResources } = require('./pdf_to_image');
const { runNdlocr } = require('./ndlocr_runner');
const { getGeminiChatModel, getGeminiChatModels, getProviderModel, getToolConfig, getProviderConfig } = require('./gemini_client');

function getAiModelLabel(aiProvider) {
    const model = getProviderModel(aiProvider, 'chat');
    return `${aiProvider} / モデル: ${model || '(未設定)'}`;
}

function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}

function getOcrPrompt(numPages, contextInstruction = "") {
    return `
# ROLE
High-precision OCR engine converting Japanese PDF pages to clean Markdown.

${contextInstruction}

# INPUT
${numPages} pages of a Japanese document.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **No Skipping**: Even if the first page starts mid-sentence or mid-paragraph (continuation from a previous unprovided page), transcribe it completely from the very first character.
3. **Page Markers**:
   - **Start**: At the start of content, output \`### -- Begin Page N {StartStatus} --\`.
     - N: Batch page index (1-${numPages}).
     - {StartStatus}: "(Continuation)" if the text at the very top of the page is a direct continuation of a paragraph from the previous page (cut off mid-sentence without a line break), else empty.
   - **End**: At the end of content, output \`### -- End {PrintedPageInfo} {EndStatus} --\`.
     - {PrintedPageInfo}: "(Printed Page X)" if a printed page number X is found (CONVERT Kanji/Roman to Arabic). If not found, leave empty.
     - {EndStatus}: "(Continuation)" if the paragraph is cut off mid-sentence and continues to the next page without an explicit line break, else empty.
4. **Transcription Rules**:
   - **No Indentation**: Standard Markdown paragraphs.
   - **Numbers**: Convert ALL full-width numbers to half-width (e.g., "１" -> "1").
   - **Corrections**: Fix obvious OCR errors (0 vs O). Keep original typos with \`(-- as is)\`.
   - **Tables**: ALWAYS transcribe a ruled or statistical table as a Markdown table. NEVER replace a table with a description, a summary, or a note such as \`(--! A table showing ...)\`, and never drop rows or columns because the table is long or dense. Output every row, including header rows, subtotal/total rows (小計/合計) and empty cells (leave such a cell empty). Transcribe the numerals exactly as printed. When a vertically written table puts one record in one column, transpose it so that one Markdown row is one record, and read the records from right to left.
   - **Visuals**: If there are photos or diagrams, provide an explanation for them in Japanese formatted as \`(--! Explanation)\`. This applies to photographs, illustrations and figures only; never use it in place of a table.
   - **Exclusions**: Omit printed page numbers from body.
     - **Redactions**: Replace blacked-out or redacted parts with "■".
     - **Margins**:
     - Headings text in margins: Format as \`(--# Text)\`.
     - Annotations/Notes in margins: Format as \`(--* Text)\`.
`;
}

function getWordPrompt(contextInstruction = "") {
    return `
# ROLE
High-precision document transcribing engine converting Japanese Word (.docx) content (XML and associated images) to clean Markdown.

${contextInstruction}

# INPUT
The following parts represent a Japanese Word (.docx) document:
1. **XML Content**: The raw \`word/document.xml\` containing text and structural tags.
2. **Images**: Visuals (photos, diagrams) extracted from the document.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **No Skipping**: Transcribe everything from the very beginning. Use the XML tags to understand the structure (headings, tables, lists) and maintain the correct sequence.
3. **Page Markers**:
   - **Start**: At the start of each logical page, output \`### -- Begin Page N --\`.
     - N: Page index (1-based).
   - **End**: At the end of each logical page, output \`### -- End {PrintedPageInfo} --\`.
     - {PrintedPageInfo}: "(Printed Page X)" if a printed page number is identified.
4. **Transcription Rules**:
   - **No Indentation**: Standard Markdown paragraphs.
   - **Numbers**: Convert ALL full-width numbers to half-width.
   - **Visuals**: Correlate the provided images with their positions in the text/XML. For each, provide a Japanese explanation formatted as \`(--! Explanation)\`.
   - **Exclusions**: Omit system tags/metadata. Keep the content clean.
`;
}

function getDocTextPrompt(contextInstruction = "") {
    return `
# ROLE
High-precision document formatting engine converting extracted Japanese Word (.doc) text to clean Markdown.

${contextInstruction}

# INPUT
Plain text extracted from a Japanese Word (.doc) document. The text structure may be somewhat degraded due to the extraction process.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **No Skipping**: Format everything from the very beginning.
3. **Page Markers**:
   - **Start**: At the start of each logical section/page, output \`### -- Begin Page N --\`.
     - N: Page index (1-based). Estimate page breaks based on content flow.
   - **End**: At the end of each logical section/page, output \`### -- End --\`.
4. **Formatting Rules**:
   - **No Indentation**: Standard Markdown paragraphs.
   - **Numbers**: Convert ALL full-width numbers to half-width.
   - **Structure**: Identify and format headings, lists, and tables appropriately.
   - **Cleanup**: Remove redundant whitespace and line breaks while preserving paragraph structure.
`;
}

function createDocTextRequest(extractedText, contextInstruction = "") {
    const prompt = getDocTextPrompt(contextInstruction);
    
    return {
        contents: [
            {
                role: "user",
                parts: [
                    { text: "--- EXTRACTED DOCUMENT TEXT START ---\n" + extractedText + "\n--- EXTRACTED DOCUMENT TEXT END ---" },
                    { text: prompt }
                ]
            }
        ]
    };
}

function createDocRequest(contentParts, contextInstruction = "", isWord = false) {
    const prompt = isWord ? getWordPrompt(contextInstruction) : getOcrPrompt(contentParts.numPages, contextInstruction);
    
    const parts = [
        ...contentParts.dataParts,
        { text: prompt }
    ];

    return {
        contents: [
            {
                role: "user",
                parts: parts
            }
        ]
    };
}

// Keep createOcrRequest for backward compatibility or direct PDF use
function createOcrRequest(pdfBytes, numPages, contextInstruction = "") {
    return createDocRequest({
        dataParts: [
            {
                inlineData: {
                    mimeType: "application/pdf",
                    data: pdfBytes.toString('base64')
                }
            }
        ],
        numPages: numPages
    }, contextInstruction, false);
}

async function createImageOcrRequestFromPdfPages(pdfPath, pageNumbers, contextInstruction = "") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi_ocr_pdf_images_'));
    try {
        const imagePaths = await extractPdfPagesToImages(pdfPath, tmpDir, getNdlocrImageDpi(), pageNumbers);
        if (imagePaths.length === 0) {
            throw new Error(`PDFページ画像化に失敗しました: ${pageNumbers.join(',')}`);
        }
        return createDocRequest({
            dataParts: imagePaths.map(imagePath => ({
                inlineData: {
                    mimeType: 'image/png',
                    data: fs.readFileSync(imagePath).toString('base64')
                }
            })),
            numPages: imagePaths.length
        }, contextInstruction, false);
    } finally {
        if (fs.existsSync(tmpDir)) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (_e) {
            }
        }
    }
}

function estimateRequestsPayloadBytes(requests) {
    let total = 2; // JSON array brackets
    for (let i = 0; i < requests.length; i++) {
        const json = JSON.stringify(requests[i]);
        total += Buffer.byteLength(json, 'utf8');
        if (i > 0) total += 1; // comma
    }
    return total;
}

async function runBatches(requests, metadata, batchProcessor, progressState, persistenceFile, processMode = 'batch', modelId = null) {
    modelId = modelId || getGeminiChatModel();
    if (processMode === 'sync') {
        console.log(`[同期] ${requests.length} 件のリクエストを同期モードで処理中...`);
        return await batchProcessor.runSync(requests, modelId, progressState);
    }
    
    // リクエストサイズを見積もり、閾値に応じてインラインかファイルバッチを選択
    const INLINE_THRESHOLD = 15 * 1024 * 1024; // 15MB（安全マージン込み）
    
    const payloadEstimate = estimateRequestsPayloadBytes(requests);
    const sizeMB = (payloadEstimate / 1024 / 1024).toFixed(2);
    
    console.log(`[バッチ] ${requests.length} 件のリクエストを送信中... (見積もりサイズ: ${sizeMB} MB)`);
    
    if (payloadEstimate < INLINE_THRESHOLD) {
        console.log(`[バッチ] インラインバッチを使用 (高速モード)`);
        const results = await batchProcessor.runInlineBatch(requests, modelId, progressState, "ocr-batch-job");
        return results;
    } else {
        console.log(`[バッチ] ファイルバッチを使用 (大容量モード)`);
        const results = await batchProcessor.runFileBatch(requests, modelId, progressState, "ocr-batch-job", persistenceFile);
        return results;
    }
}

async function runClaudeBatch(requests, progressState, processMode = 'batch') {
    const processor = new ClaudeOcrProcessor();
    if (processMode === 'sync') {
        console.log(`[Claude] ${requests.length} 件のリクエストを順次処理中...`);
        return await processor.runBatch(requests, progressState, 1);
    } else {
        console.log(`[Claude] ${requests.length} 件のリクエストを並列処理中...`);
        return await processor.runBatch(requests, progressState, 2);
    }
}

async function runOpenAIBatch(requests, progressState, processMode = 'batch', persistencePath = null) {
    const processor = new OpenAIOcrProcessor();
    if (processMode === 'sync') {
        console.log(`[OpenAI] ${requests.length} 件のリクエストを同期モードで処理中...`);
        return await processor.runSync(requests, progressState, 1);
    } else {
        console.log(`[OpenAI バッチ] ${requests.length} 件のリクエストをBatch APIで処理中...`);
        return await processor.runFileBatch(requests, progressState, persistencePath);
    }
}

// 単一または少数のリクエスト用ヘルパー（Word文書用）
async function runSingleBatch(requests, batchProcessor, progressState, displayName, persistenceFile, aiProvider = 'gemini', processMode = 'batch') {
    if (aiProvider === 'claude') {
        return await runClaudeBatch(requests, progressState, processMode);
    }
    if (aiProvider === 'openai') {
        return await runOpenAIBatch(requests, progressState, processMode, persistenceFile);
    }
    
    const modelPriority = getGeminiChatModels();
    let latestResults = [];
    for (let modelIndex = 0; modelIndex < modelPriority.length; modelIndex++) {
        const modelId = modelPriority[modelIndex];
        if (modelIndex > 0) {
            console.warn(`[モデル切替] Gemini未解決要求を ${modelId} で再試行します。`);
        }
        const modelProgress = modelIndex === 0 ? progressState : null;
        const modelPersistenceFile = modelIndex === 0 || !persistenceFile
            ? persistenceFile
            : `${persistenceFile}.model-${modelIndex + 1}`;

        try {
            if (processMode === 'sync') {
                console.log(`[同期] リクエストを同期モードで処理中...`);
                latestResults = await batchProcessor.runSync(requests, modelId, modelProgress);
            } else {
                const INLINE_THRESHOLD = 15 * 1024 * 1024; // 15MB
                const payloadEstimate = estimateRequestsPayloadBytes(requests);
                const sizeMB = (payloadEstimate / 1024 / 1024).toFixed(2);
                console.log(`[バッチ] リクエスト送信中... (見積もりサイズ: ${sizeMB} MB)`);
                if (payloadEstimate < INLINE_THRESHOLD) {
                    console.log(`[バッチ] インラインバッチを使用 (高速モード)`);
                    latestResults = await batchProcessor.runInlineBatch(requests, modelId, modelProgress, displayName);
                } else {
                    console.log(`[バッチ] ファイルバッチを使用 (大容量モード)`);
                    latestResults = await batchProcessor.runFileBatch(requests, modelId, modelProgress, displayName, modelPersistenceFile);
                }
            }
        } catch (error) {
            const message = normalizeErrorDetail(error?.message || error);
            latestResults = requests.map(() => ({ response: null, error: { message } }));
        }

        const shouldFallback = latestResults.some(result => (
            (Boolean(result?.error) || !hasUsableAiResponseText(result?.response)) &&
            !isExplicitSafetyStop(result?.response)
        ));
        if (!shouldFallback || modelIndex === modelPriority.length - 1) {
            return latestResults;
        }
    }
    return latestResults;
}

function stripOcrSettingsComments(content) {
    return String(content || '').replace(/<!--\s*mimi-ocr-settings[\s\S]*?-->\s*/g, '');
}

async function runGeminiRequestsWithRecoveryTransport(
    requests,
    metadata,
    batchProcessor,
    progressState,
    persistenceFile,
    processMode = 'batch'
) {
    const metadataModel = (metadata || [])
        .map(item => String(item?.modelId || '').trim())
        .find(Boolean);
    const defaultModel = metadataModel || getGeminiChatModel();
    const groups = new Map();
    for (let i = 0; i < requests.length; i++) {
        const forceSync = processMode === 'batch' && metadata[i]?.forceSync;
        const modelId = String(metadata[i]?.modelId || defaultModel).trim() || defaultModel;
        const key = `${forceSync ? 'forced-sync' : processMode}\u0000${modelId}`;
        if (!groups.has(key)) groups.set(key, { forceSync, modelId, positions: [] });
        groups.get(key).positions.push(i);
    }

    const results = new Array(requests.length);
    for (const group of groups.values()) {
        const groupRequests = group.positions.map(index => requests[index]);
        let groupResults;
        if (group.forceSync) {
            console.warn(`[再試行] Batch APIで未解決だった ${group.positions.length} 件を同期inlineへ切替えます。`);
            groupResults = await batchProcessor.runSync(groupRequests, group.modelId, null, 1);
        } else {
            groupResults = await runBatches(
                groupRequests,
                group.positions.map(index => metadata[index]),
                batchProcessor,
                progressState,
                persistenceFile,
                processMode,
                group.modelId
            );
        }
        group.positions.forEach((position, index) => {
            results[position] = groupResults[index];
        });
    }
    return results;
}

function extractPagesFromMarkdown(content) {
    content = stripOcrSettingsComments(content);
    const pageMap = new Map();
    const regex = /### -- Begin Page (\d+)/g;
    let match;
    const positions = [];

    while ((match = regex.exec(content)) !== null) {
        positions.push({ pageNum: parseInt(match[1], 10), index: match.index });
    }

    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = (i + 1 < positions.length) ? positions[i + 1].index : content.length;
        const pageContent = content.substring(start, end).trim();
        if (!pageContent.includes("[ERROR: OCR Failed")) {
            pageMap.set(positions[i].pageNum, pageContent);
        }
    }
    return pageMap;
}

function summarizeAiResponse(response) {
    if (!response || typeof response !== 'object') return 'response=missing';

    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const finishReasons = Array.from(new Set(
        candidates
            .map(candidate => String(candidate?.finishReason || '').trim())
            .filter(Boolean)
    ));
    const textChars = candidates.reduce((total, candidate) => {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        return total + parts.reduce((partTotal, part) => (
            partTotal + (typeof part?.text === 'string' ? part.text.length : 0)
        ), 0);
    }, 0);
    const promptBlockReason = String(response?.promptFeedback?.blockReason || '').trim();
    const safetyRatings = [];
    for (const rating of response?.promptFeedback?.safetyRatings || []) {
        const category = String(rating?.category || '').trim();
        const probability = String(rating?.probability || '').trim();
        if (category || probability) safetyRatings.push(`${category || 'UNKNOWN'}:${probability || 'UNKNOWN'}`);
    }
    for (const candidate of candidates) {
        for (const rating of candidate?.safetyRatings || []) {
            const category = String(rating?.category || '').trim();
            const probability = String(rating?.probability || '').trim();
            if (category || probability) safetyRatings.push(`${category || 'UNKNOWN'}:${probability || 'UNKNOWN'}`);
        }
    }

    return [
        `candidateCount=${candidates.length}`,
        `textChars=${textChars}`,
        `finishReasons=${finishReasons.length > 0 ? finishReasons.join(',') : 'none'}`,
        `promptBlockReason=${promptBlockReason || 'none'}`,
        `safetyRatings=${safetyRatings.length > 0 ? Array.from(new Set(safetyRatings)).join(',') : 'none'}`
    ].join('; ');
}

function hasUsableAiResponseText(response) {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    return candidates.some(candidate => (
        (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
            .some(part => typeof part?.text === 'string' && part.text.trim().length > 0)
    ));
}

function isExplicitSafetyStop(response) {
    const blockReason = String(response?.promptFeedback?.blockReason || '').trim().toUpperCase();
    if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') return true;

    const safetyFinishReasons = new Set([
        'SAFETY',
        'BLOCKLIST',
        'PROHIBITED_CONTENT',
        'SPII'
    ]);
    return (Array.isArray(response?.candidates) ? response.candidates : [])
        .some(candidate => safetyFinishReasons.has(String(candidate?.finishReason || '').trim().toUpperCase()));
}

function selectNextGeminiModel(modelPriority, currentModelIndex, response = null) {
    if (isExplicitSafetyStop(response)) return null;
    const nextModelIndex = Number(currentModelIndex || 0) + 1;
    const modelId = Array.isArray(modelPriority) ? modelPriority[nextModelIndex] : null;
    return modelId ? { modelIndex: nextModelIndex, modelId } : null;
}

function toAbsoluteBatchPageMap(rawText, metaPages) {
    const result = {
        ok: false,
        pageMap: new Map(),
        beginCount: 0,
        endCount: 0,
        validRelativeCount: 0,
        missingRelativePages: []
    };

    if (!Array.isArray(metaPages) || metaPages.length === 0) {
        return result;
    }

    const text = typeof rawText === 'string' ? rawText : '';
    result.beginCount = (text.match(/### -- Begin Page \d+/g) || []).length;
    result.endCount = (text.match(/### -- End/g) || []).length;

    const regex = /### -- Begin Page (\d+)/g;
    const positions = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        const relativePage = parseInt(match[1], 10);
        positions.push({ relativePage, index: match.index });
    }

    if (positions.length === 0) {
        return result;
    }

    const expectedRelativePages = new Set(metaPages.map((_v, idx) => idx + 1));
    const seenRelativePages = new Set();

    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = (i + 1 < positions.length) ? positions[i + 1].index : text.length;
        const block = text.substring(start, end).trim();
        const relativePage = positions[i].relativePage;

        if (!expectedRelativePages.has(relativePage)) {
            continue;
        }
        if (seenRelativePages.has(relativePage)) {
            continue;
        }

        seenRelativePages.add(relativePage);
        result.validRelativeCount++;
        const absolutePage = metaPages[relativePage - 1];
        const normalizedBlock = block.replace(/### -- Begin Page \d+/, `### -- Begin Page ${absolutePage}`);
        result.pageMap.set(absolutePage, normalizedBlock);
    }

    for (let i = 1; i <= metaPages.length; i++) {
        if (seenRelativePages.has(i)) continue;
        const absolutePage = metaPages[i - 1];
        result.missingRelativePages.push(i);
        result.pageMap.set(absolutePage, `### -- Begin Page ${absolutePage} --\n\n### -- End --`);
    }

    result.ok = result.validRelativeCount > 0;
    return result;
}

function stripOcrPageMarkers(block) {
    return String(block || '')
        .replace(/### -- Begin Page \d+.*?--/g, '')
        .replace(/### -- End.*?--/g, '')
        .replace(/<!-- mimi-ocr-settings[\s\S]*?-->/g, '')
        .replace(/\[ERROR:[\s\S]*$/g, '')
        .trim();
}

function hasUsefulOcrPageText(block) {
    const text = stripOcrPageMarkers(block)
        .replace(/[\s\u3000\r\n\t\-_*#|:：。．、，・]+/g, '');
    return text.length > 0;
}

function findEmptyOcrPages(pageMap, pages) {
    const emptyPages = [];
    for (const pageNum of pages || []) {
        if (!hasUsefulOcrPageText(pageMap.get(pageNum))) {
            emptyPages.push(pageNum);
        }
    }
    return emptyPages;
}

/**
 * 統計表を書き起こさず「表がある」という説明だけを返した応答を検出する。
 *
 * Gemini は罫線の多い統計表で、表本体の代わりに
 * `(--! A table showing statistical data for various villages/towns.)` のような
 * 注記だけを出すことがある。周囲の本文は残るため空ページ判定では拾えず、
 * 表だけが黙って失われる。
 */
const TABLE_NOTE_PATTERN = /\(--!\s*([^)]*)\)/g;
const TABLE_WORD_PATTERN = /\btables?\b|\btabular\b|統計表|一覧表|数値表|表組|表形式|の表|表が(?:示|載|掲)|表を(?:示|掲載|記載)/i;

function hasMarkdownTableRow(text) {
    return /^[ \t]*\|.*\|[ \t]*$/m.test(String(text || ''));
}

function describesTableWithoutTranscribing(block) {
    const text = stripOcrPageMarkers(block);
    if (!text) return false;
    if (hasMarkdownTableRow(text)) return false;

    TABLE_NOTE_PATTERN.lastIndex = 0;
    let match;
    while ((match = TABLE_NOTE_PATTERN.exec(text)) !== null) {
        if (TABLE_WORD_PATTERN.test(match[1] || '')) return true;
    }
    return false;
}

function findDroppedTablePages(pageMap, pages) {
    const droppedPages = [];
    for (const pageNum of pages || []) {
        if (describesTableWithoutTranscribing(pageMap.get(pageNum))) {
            droppedPages.push(pageNum);
        }
    }
    return droppedPages;
}

/**
 * Gemini が複数ページ中の一部だけを返した場合でも、取得済み本文を失わないように
 * 有効ページを直ちに pageMap へ確定し、空本文ページだけを未解決として返す。
 *
 * 完全な空応答は、単ページリクエストの場合だけ「空本文の確認」として数える。
 * 複数ページの完全な空応答では本文ページまで白紙扱いする危険があるため数えない。
 */
function applyOcrBatchTextResult(rawText, metaPages, pageMap, emptyResponseCounts) {
    const pages = Array.isArray(metaPages) ? metaPages : [];
    const text = typeof rawText === 'string' ? rawText : '';
    const normalized = toAbsoluteBatchPageMap(text, pages);
    const usefulPages = [];
    let emptyPages = [];

    if (normalized.ok) {
        emptyPages = findEmptyOcrPages(normalized.pageMap, pages)
            .filter(pageNum => !pageMap.has(pageNum));

        for (const pageNum of pages) {
            const content = normalized.pageMap.get(pageNum);
            if (!hasUsefulOcrPageText(content)) continue;
            pageMap.set(pageNum, content);
            usefulPages.push(pageNum);
        }
    } else if (pages.length === 1 && text.trim().length === 0 && !pageMap.has(pages[0])) {
        emptyPages = [pages[0]];
    }

    for (const pageNum of emptyPages) {
        emptyResponseCounts.set(pageNum, (emptyResponseCounts.get(pageNum) || 0) + 1);
    }

    return {
        normalized,
        usefulPages,
        emptyPages,
        unresolvedPages: pages.filter(pageNum => !pageMap.has(pageNum))
    };
}

/**
 * 通常の白紙判定を通らなかったスキャナ汚れ付きページ用の二次判定。
 * Gemini が同じページを複数回空本文として返した場合に限って呼び出す。
 */
async function confirmRepeatedEmptyPdfPages(pdfPath, pageNumbers) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) return [];
    return await detectBlankPdfPages(pdfPath, pageNumbers, 72, {
        minInkRatio: 0.005,
        minInkPixels: 512
    });
}

/**
 * バッチ要求と、そこから分離した単ページ要求にそれぞれ独立した再試行枠を与える。
 * 親要求が上限へ達した後に追加した子要求も、常に maxAttempts 回まで試せる。
 */
function createIndependentRetryBudget(maxAttempts = 3) {
    const normalizedMaxAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
    const attempts = new Map();

    return {
        begin(requestIndex) {
            const next = (attempts.get(requestIndex) || 0) + 1;
            attempts.set(requestIndex, next);
            return next;
        },
        canRetry(requestIndex) {
            return (attempts.get(requestIndex) || 0) < normalizedMaxAttempts;
        },
        count(requestIndex) {
            return attempts.get(requestIndex) || 0;
        },
        maxAttempts: normalizedMaxAttempts
    };
}

function normalizeErrorDetail(detail) {
    const text = String(detail || '').replace(/\r\n/g, '\n').trim();
    if (!text) return '詳細情報なし';
    const MAX_LEN = 3000;
    if (text.length <= MAX_LEN) return text;
    return `${text.slice(0, MAX_LEN)}\n...(detail truncated)`;
}

function buildOcrErrorPageContent(pageNum, detail, ndlocrOnly = false) {
    const normalizedDetail = normalizeErrorDetail(detail);
    const detailLines = normalizedDetail.split('\n').map(line => `- ${line}`).join('\n');

    if (ndlocrOnly) {
        return `----- Page ${pageNum} -----\n[ERROR: OCR Failed for page ${pageNum}]\n[ERROR DETAIL]\n${detailLines}\n\n`;
    }

    return `### -- Begin Page ${pageNum} --\n\n[ERROR: OCR Failed for page ${pageNum}]\n[ERROR DETAIL]\n${detailLines}\n\n`;
}

function buildBlankOcrPageContent(pageNum, ndlocrOnly = false) {
    if (ndlocrOnly) {
        return '';
    }
    return `### -- Begin Page ${pageNum} --\n\n### -- End --`;
}

function describeWriteError(filePath, error, label = '出力ファイル') {
    if (error?.code === 'EISDIR') {
        return `${label}と同名のフォルダが既に存在します: ${filePath}`;
    }
    if (error?.code === 'ENOENT') {
        return `${label}の保存先フォルダが見つかりません: ${path.dirname(filePath)}`;
    }
    if (error?.code === 'EPERM') {
        return `${label}を作成または更新できませんでした: ${filePath} (EPERM)。保存先フォルダの権限、クラウド同期、同名ファイルのロックをご確認ください。`;
    }
    if (error?.code === 'EACCES') {
        return `${label}へのアクセスが拒否されました: ${filePath} (EACCES)。保存先フォルダの権限をご確認ください。`;
    }
    return `${label}の書き込みに失敗しました: ${filePath} (${error?.message || error})`;
}

function hasExistingOutputFile(filePath, label = '出力ファイル') {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
        }
        return true;
    } catch (e) {
        throw new Error(describeWriteError(filePath, e, label));
    }
}

function ensureWritableOutputPath(filePath, label = '出力ファイル') {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        throw new Error(`${label}の保存先フォルダが見つかりません: ${dir}`);
    }

    if (hasExistingOutputFile(filePath, label)) {
        try {
            fs.accessSync(filePath, fs.constants.W_OK);
            return;
        } catch (e) {
            throw new Error(describeWriteError(filePath, e, label));
        }
    }

    const probePath = path.join(
        dir,
        `.mimi-ocr-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
        fs.writeFileSync(probePath, '', { flag: 'wx' });
    } catch (e) {
        throw new Error(describeWriteError(filePath, e, label));
    } finally {
        if (fs.existsSync(probePath)) {
            try {
                fs.unlinkSync(probePath);
            } catch (_e) {
            }
        }
    }
}

function writeTextFileWithContext(filePath, content, label = '出力ファイル') {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e) {
        throw new Error(describeWriteError(filePath, e, label));
    }
}

function compactMetadataObject(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => compactMetadataObject(item))
            .filter(item => item !== undefined);
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, childValue] of Object.entries(value)) {
            const compacted = compactMetadataObject(childValue);
            if (compacted === undefined) continue;
            result[key] = compacted;
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }
    if (value === null || value === undefined || value === '') return undefined;
    return value;
}

function normalizeMetadataPath(filePath) {
    if (!filePath) return null;
    return path.basename(filePath);
}

function loadBuildInfo() {
    const buildInfoPath = path.join(__dirname, 'build_info.json');
    try {
        const content = fs.readFileSync(buildInfoPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
            return parsed.number || 'dev';
        }
    } catch (_e) {
    }
    return 'dev';
}

function buildOcrSettingsComment(sourcePath, inputType, runtimeOptions: any = {}) {
    const aiProvider = runtimeOptions.aiProvider || 'gemini';
    const providerConfig = getProviderConfig(aiProvider) || {};
    const ndlocrConfig = getToolConfig('ndlocrLite') || {};
    const metadata = compactMetadataObject({
        tool: 'mimi-ocr',
        build: loadBuildInfo(),
        generatedAt: new Date().toISOString(),
        source: normalizeMetadataPath(sourcePath),
        input: inputType,
        settings: {
            target: runtimeOptions.target || 'general',
            contextFile: normalizeMetadataPath(runtimeOptions.contextFilePath),
            ai: {
                provider: aiProvider,
                model: getProviderModel(aiProvider, 'chat') || providerConfig.model,
                modelPriority: aiProvider === 'gemini' ? getGeminiChatModels() : null
            },
            processMode: runtimeOptions.processMode || 'batch',
            batchSize: runtimeOptions.batchSize ?? null,
            pages: {
                start: runtimeOptions.startPage ?? null,
                end: runtimeOptions.endPage ?? null,
                requestedEnd: runtimeOptions.requestedEndPage ?? null,
                total: runtimeOptions.totalPages ?? null
            },
            ndlocr: runtimeOptions.ndlocrOnly ? 'only' : (runtimeOptions.useNdlocr ? 'pre' : 'off'),
            ndlocrSettings: (runtimeOptions.useNdlocr || runtimeOptions.ndlocrOnly) ? {
                parallelJobs: ndlocrConfig.parallelJobs,
                pageChunkSize: ndlocrConfig.pageChunkSize,
                imageDpi: ndlocrConfig.imageDpi
            } : null,
            preferPdfText: runtimeOptions.preferPdfText ? true : null,
            hasError: runtimeOptions.hasError ? true : null
        }
    });

    const json = JSON.stringify(metadata, null, 2).replace(/--/g, '\\u002d\\u002d');
    return `<!-- mimi-ocr-settings\n${json}\n-->`;
}

function appendOcrSettingsComment(content, sourcePath, inputType, runtimeOptions: any = {}) {
    const body = String(content || '').replace(/^\uFEFF/, '').trimEnd();
    return `${body}\n\n${buildOcrSettingsComment(sourcePath, inputType, runtimeOptions)}\n`;
}

function removeFileIfExists(filePath, label = 'ファイル') {
    if (!fs.existsSync(filePath)) {
        return;
    }

    try {
        fs.unlinkSync(filePath);
    } catch (e) {
        console.warn(`[警告] ${label}を削除できませんでした: ${filePath} (${e.message})`);
    }
}

function normalizeNdlocrText(rawText) {
    const lines = rawText.replace(/\r\n/g, '\n').split('\n');
    const merged = [];

    const endsSentence = (text) => /[。．！？!?：:；;」』）)】\]]$/.test(text);
    const startsStructuredLine = (text) => {
        return /^[・●◯■□◆◇※▶▷▼▽▲△◆◇★☆]/.test(text)
            || /^[-*#]/.test(text)
            || /^\d+[\.)．、]/.test(text)
            || /^\([0-9０-９一二三四五六七八九十]+\)/.test(text)
            || /^[ 　]{2,}/.test(text);
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
            if (merged.length > 0 && merged[merged.length - 1] !== '') {
                merged.push('');
            }
            continue;
        }

        if (merged.length === 0 || merged[merged.length - 1] === '') {
            merged.push(trimmed);
            continue;
        }

        const prev = merged[merged.length - 1];
        if (endsSentence(prev) || startsStructuredLine(trimmed)) {
            merged.push(trimmed);
        } else {
            merged[merged.length - 1] = prev + trimmed;
        }
    }

    return merged.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getNdlocrParallelJobs() {
    const ndlocrLite = getToolConfig('ndlocrLite');
    const raw = ndlocrLite?.parallelJobs;

    const cpuCount = (() => {
        try {
            const cpus = os.cpus();
            return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;
        } catch (_e) {
            return 1;
        }
    })();
    const autoJobs = Math.max(1, Math.min(4, Math.ceil(cpuCount / 2)));

    if (raw === undefined || raw === null || raw === '' || String(raw).toLowerCase() === 'auto') {
        return autoJobs;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) return autoJobs;
    return Math.min(parsed, 16);
}

function parsePositiveIntSetting(raw, defaultValue, maxValue) {
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) return defaultValue;
    return Math.min(parsed, maxValue);
}

function parseNonNegativeIntSetting(raw, defaultValue, maxValue) {
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
    return Math.min(parsed, maxValue);
}

function getNdlocrPageChunkSize() {
    const ndlocrLite = getToolConfig('ndlocrLite');
    return parsePositiveIntSetting(ndlocrLite?.pageChunkSize, 8, 200);
}

function getNdlocrWorkerStartDelayMs() {
    const ndlocrLite = getToolConfig('ndlocrLite');
    return parseNonNegativeIntSetting(ndlocrLite?.workerStartDelayMs, 1500, 60000);
}

function getNdlocrImageDpi() {
    const ndlocrLite = getToolConfig('ndlocrLite');
    return parsePositiveIntSetting(ndlocrLite?.imageDpi, 300, 600);
}

function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(items, chunkSize) {
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

function copyFilesFromDir(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return;
    for (const fileName of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, fileName);
        const stat = fs.statSync(src);
        if (!stat.isFile()) continue;
        const dst = path.join(destDir, fileName);
        fs.copyFileSync(src, dst);
    }
}

function removeDirIfExists(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
}

async function runNdlocrJobQueue(jobs, maxConcurrent, workerStartDelayMs, finalOutDir, prepareJobFn = null) {
    let nextIndex = 0;
    const workerCount = Math.min(maxConcurrent, jobs.length);

    async function worker(slotIndex) {
        if (slotIndex > 0 && workerStartDelayMs > 0) {
            await sleep(slotIndex * workerStartDelayMs);
        }

        while (true) {
            const jobIndex = nextIndex;
            nextIndex++;
            if (jobIndex >= jobs.length) return;

            const job = jobs[jobIndex];
            console.log(`[ndlocr] チャンク ${jobIndex + 1}/${jobs.length} 開始 (ワーカー ${slotIndex + 1}/${workerCount}, ${job.pageCount}ページ)`);
            try {
                if (typeof prepareJobFn === 'function') {
                    await prepareJobFn(job, jobIndex, slotIndex, workerCount);
                }
                await runNdlocr(job.srcDir, job.outDir, true);
                copyFilesFromDir(job.outDir, finalOutDir);
                console.log(`[ndlocr] チャンク ${jobIndex + 1}/${jobs.length} 完了`);
            } finally {
                removeDirIfExists(job.srcDir);
                removeDirIfExists(job.outDir);
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, (_v, idx) => worker(idx)));
}

function getRawTextFormattingPrompt(contextInstruction = "") {
    return `
# ROLE
High-precision document formatting engine converting raw OCR text to clean Markdown.

${contextInstruction}

# INPUT
Raw text extracted by an OCR engine, separated by page markers. The content may contain some OCR errors or formatting artifacts.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **Formatting**: Reconstruct the original document's structure into clean Markdown paragraphs. Merge lines that are part of the same logical sentence.
3. **Headings**: Identify probable headings and format them with Markdown (#, ##, etc.).
4. **Errors**: Correct obvious OCR text recognition errors using surrounding context if possible.
5. **Numbers**: Convert ALL full-width numbers to half-width (e.g., "１" -> "1").
6. **Page Markers**:
   - Retain the exact same \`### -- Begin Page N --\` and \`### -- End --\` markers around each page's content in your output.
7. **No Skipping**: Format the entire input text completely from the beginning to the end.
`;
}

function createRawTextRequest(batchPages, pageTextMap, contextInstruction = "") {
    let combinedText = "";
    for (let j = 0; j < batchPages.length; j++) {
        const pNum = batchPages[j];
        const sourceText = pageTextMap.get(pNum) || "[未検出]";
        combinedText += `\n### -- Begin Page ${j + 1} --\n${sourceText}\n### -- End --\n`;
    }

    const prompt = getRawTextFormattingPrompt(contextInstruction);
    return {
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt },
                    { text: "--- RAW OCR TEXT START ---\n" + combinedText + "\n--- RAW OCR TEXT END ---" }
                ]
            }
        ]
    };
}

async function extractEmbeddedTextFromPdfPages(pdfPath, pageNumbers) {
    const result = new Map();
    if (!pageNumbers || pageNumbers.length === 0) {
        return result;
    }

    const pdfjsLib = await loadPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(buildDocumentParameters(pdfPath));

    let srcPdf = null;
    try {
        srcPdf = await loadingTask.promise;
        for (const pageNum of pageNumbers) {
            const page = await srcPdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const lines = textContent.items
                .map(item => (item && typeof item.str === 'string') ? item.str.trim() : '')
                .filter(Boolean);

            const joined = lines.join('\n').trim();
            if (joined.replace(/[\s\u3000]/g, '').length > 0) {
                result.set(pageNum, joined);
            }

            if (typeof page.cleanup === 'function') {
                page.cleanup();
            }
        }
    } finally {
        await cleanupPdfResources(srcPdf, loadingTask);
    }

    return result;
}

function normalizeTextForSimilarity(text) {
    return stripOcrPageMarkers(String(text || ''))
        .replace(/<!--\s*mimi-ocr-fallback:[\s\S]*?-->/g, '')
        .normalize('NFKC')
        .replace(/[\s\p{P}\p{S}]/gu, '');
}

function compareTextSimilarity(left, right) {
    const a = normalizeTextForSimilarity(left);
    const b = normalizeTextForSimilarity(right);
    const maxLength = Math.max(a.length, b.length);
    const lengthRatio = maxLength > 0 ? Math.min(a.length, b.length) / maxLength : 0;
    const toBigrams = (value) => {
        const grams = new Set();
        for (let i = 0; i < value.length - 1; i++) grams.add(value.slice(i, i + 2));
        return grams;
    };
    const aBigrams = toBigrams(a);
    const bBigrams = toBigrams(b);
    const union = new Set([...aBigrams, ...bBigrams]);
    let common = 0;
    for (const gram of aBigrams) {
        if (bBigrams.has(gram)) common++;
    }
    const bigramJaccard = union.size > 0 ? common / union.size : 0;
    return { leftLength: a.length, rightLength: b.length, lengthRatio, bigramJaccard };
}

function buildEmbeddedTextFallbackPageContent(pageNum, embeddedText, validation) {
    const jaccard = Number(validation?.bigramJaccard || 0).toFixed(3);
    const lengthRatio = Number(validation?.lengthRatio || 0).toFixed(3);
    return [
        `### -- Begin Page ${pageNum} --`,
        '',
        `<!-- mimi-ocr-fallback: embedded-pdf-text; neighborJaccard=${jaccard}; neighborLengthRatio=${lengthRatio} -->`,
        '',
        String(embeddedText || '').trim(),
        '',
        '### -- End --'
    ].join('\n');
}

async function recoverPagesFromTrustedEmbeddedText(pdfPath, pageNumbers, pageMap, totalPages) {
    const unresolvedPages: number[] = Array.from(new Set<number>(
        (pageNumbers || []).map(pageNum => Number(pageNum))
    ))
        .filter(pageNum => Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= totalPages);
    if (unresolvedPages.length === 0) return [];

    // Fix the trust anchors before adding fallbacks so one recovered page cannot
    // validate the next unresolved page and cascade through a damaged range.
    const trustedNeighborPages = new Set(
        Array.from(pageMap.entries())
            .filter(([, content]) => !String(content || '').includes('mimi-ocr-fallback: embedded-pdf-text'))
            .map(([pageNum]) => Number(pageNum))
    );

    const pagesToRead = new Set<number>(unresolvedPages);
    for (const pageNum of unresolvedPages) {
        if (pageNum > 1) pagesToRead.add(pageNum - 1);
        if (pageNum < totalPages) pagesToRead.add(pageNum + 1);
    }
    const embeddedText = await extractEmbeddedTextFromPdfPages(pdfPath, Array.from(pagesToRead));
    const recovered = [];

    for (const pageNum of unresolvedPages) {
        const candidate = embeddedText.get(pageNum);
        if (normalizeTextForSimilarity(candidate).length < 80) continue;

        const neighborMetrics = [];
        for (const neighborPage of [pageNum - 1, pageNum + 1]) {
            if (!trustedNeighborPages.has(neighborPage) || !embeddedText.has(neighborPage)) continue;
            neighborMetrics.push(compareTextSimilarity(
                embeddedText.get(neighborPage),
                pageMap.get(neighborPage)
            ));
        }
        if (neighborMetrics.length === 0) continue;
        if (neighborMetrics.some(metric => metric.bigramJaccard < 0.75 || metric.lengthRatio < 0.75)) continue;

        const validation = {
            bigramJaccard: neighborMetrics.reduce((sum, metric) => sum + metric.bigramJaccard, 0) / neighborMetrics.length,
            lengthRatio: neighborMetrics.reduce((sum, metric) => sum + metric.lengthRatio, 0) / neighborMetrics.length,
            neighborCount: neighborMetrics.length
        };
        pageMap.set(pageNum, buildEmbeddedTextFallbackPageContent(pageNum, candidate, validation));
        recovered.push({ pageNum, ...validation });
    }
    return recovered;
}

async function getPdfPageCount(pdfPath) {
    const pdfjsLib = await loadPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(buildDocumentParameters(pdfPath));

    let srcPdf = null;
    try {
        srcPdf = await loadingTask.promise;
        return srcPdf.numPages;
    } finally {
        try {
            if (srcPdf && typeof srcPdf.cleanup === 'function') {
                srcPdf.cleanup();
            }
        } catch (_e) {
        }
        try {
            if (srcPdf && typeof srcPdf.destroy === 'function') {
                await srcPdf.destroy();
            }
        } catch (_e) {
        }
        try {
            if (loadingTask && typeof loadingTask.destroy === 'function') {
                await loadingTask.destroy();
            }
        } catch (_e) {
        }
    }
}

async function pdfToText(pdfPath, batchSize = 5, startPage = 1, endPage = null, contextInstruction = "", aiProvider = "gemini", processMode = "batch", useNdlocr = false, ndlocrOnly = false, preferPdfText = false, metadataOptions = {}) {
    if (ndlocrOnly) {
        useNdlocr = true;
    }

    // 出力ファイルが既に存在する場合はスキップ
    const normalPath = pdfPath.replace(/\.pdf$/i, "_paged.md");
    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    const errorPath = pdfPath.replace(/\.pdf$/i, "_ERROR_paged.md");
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');
    ensureWritableOutputPath(errorPath, 'OCR中間結果ファイル');

    console.log(`[情報] AI: ${ndlocrOnly ? '使用しない' : getAiModelLabel(aiProvider)} / モード: ${processMode === 'sync' ? '同期' : 'バッチ'} / ndlocr: ${useNdlocr ? (ndlocrOnly ? 'Only' : 'Pre-OCR') : 'Off'} / PDFテキスト優先: ${preferPdfText ? 'On' : 'Off'}`);
    const geminiModelPriority = !ndlocrOnly && aiProvider === 'gemini'
        ? getGeminiChatModels()
        : [];
    if (geminiModelPriority.length > 1) {
        console.log(`[情報] Geminiモデル優先順: ${geminiModelPriority.join(' -> ')}`);
    }
    const primaryGeminiRequestMeta = geminiModelPriority.length > 0
        ? { modelIndex: 0, modelId: geminiModelPriority[0] }
        : {};
    const totalPages = await getPdfPageCount(pdfPath);
    let srcDoc = null;
    let pdfBuffer = null;
    let pdfLibLoadFailed = false;
    
    const actualEndPage = endPage || totalPages;
    console.log(`[情報] 処理開始: ${pdfPath} (${totalPages} ページ中 ${startPage} から ${actualEndPage} ページまで)`);

    // normalPath は関数冒頭で定義済み

    let pageMap = new Map();
    const pageErrorMap = new Map();
    const setPageError = (pageNum, detail) => {
        if (!Number.isFinite(pageNum)) return;
        const next = normalizeErrorDetail(detail);
        const prev = pageErrorMap.get(pageNum);
        if (prev === next) return;
        pageErrorMap.set(pageNum, next);
    };
    const setPageErrorForPages = (pages, detail) => {
        if (!Array.isArray(pages)) return;
        for (const p of pages) {
            setPageError(p, detail);
        }
    };
    const clearPageErrorsForPages = (pages) => {
        if (!Array.isArray(pages)) return;
        for (const p of pages) {
            pageErrorMap.delete(p);
        }
    };
    let resumedFromErrorFile = false;
    if (!ndlocrOnly && fs.existsSync(errorPath)) {
        const existingContent = fs.readFileSync(errorPath, 'utf-8');
        pageMap = extractPagesFromMarkdown(existingContent);
        if (pageMap.size > 0) {
            resumedFromErrorFile = true;
            console.log(`[情報] ${errorPath} から再開します (${pageMap.size} ページ完了済み)`);
        }
    }

    let pageIndices = [];
    for (let i = startPage; i <= actualEndPage; i++) {
        if (!pageMap.has(i)) {
            pageIndices.push(i);
        }
    }

    if (pageIndices.length === 0) {
        console.log(`[情報] すべての対象ページは既に完了しています。`);
        return fs.existsSync(errorPath) ? errorPath : normalPath;
    }

    try {
        console.log(`[空白検出] OCR前に ${pageIndices.length} ページを確認中...`);
        const blankPages = await detectBlankPdfPages(pdfPath, pageIndices);
        const blankPageSet = new Set(blankPages);
        for (const pageNum of blankPages) {
            pageMap.set(pageNum, buildBlankOcrPageContent(pageNum, ndlocrOnly));
            pageErrorMap.delete(pageNum);
        }
        pageIndices = pageIndices.filter(pageNum => !blankPageSet.has(pageNum));
        if (blankPages.length > 0) {
            console.log(`[空白検出] ${blankPages.length} ページをOCR対象から除外しました: ${blankPages.join(', ')}`);
        } else {
            console.log(`[空白検出] 白紙ページはありませんでした。`);
        }
    } catch (e) {
        // 白紙判定自体の失敗でOCR全体を止めず、安全側として全ページをOCRへ回す。
        console.warn(`[空白検出] 判定に失敗したため全ページをOCR処理します: ${e.message}`);
    }

    // A resume file already contains AI-confirmed neighboring pages. If those
    // pages prove that the PDF text layer is faithful, fill isolated failures
    // locally before paying for and repeating the same provider request.
    if (resumedFromErrorFile && pageIndices.length > 0) {
        try {
            const recovered = await recoverPagesFromTrustedEmbeddedText(
                pdfPath,
                pageIndices,
                pageMap,
                totalPages
            );
            if (recovered.length > 0) {
                const recoveredPages = new Set(recovered.map(item => item.pageNum));
                pageIndices = pageIndices.filter(pageNum => !recoveredPages.has(pageNum));
                for (const item of recovered) {
                    pageErrorMap.delete(item.pageNum);
                    console.warn(
                        `[PDFテキスト救済] 再開ページ ${item.pageNum} をAPI再送前にローカル復旧しました ` +
                        `(近接${item.neighborCount}頁、Jaccard=${item.bigramJaccard.toFixed(3)}、長さ比=${item.lengthRatio.toFixed(3)})。`
                    );
                }
            }
        } catch (e) {
            console.warn(`[PDFテキスト救済] 再開時の事前判定に失敗したため通常OCRへ進みます: ${e.message}`);
        }
    }

    let embeddedTextMap = new Map();
    if (preferPdfText && pageIndices.length > 0) {
        try {
            console.log(`[PDFテキスト] 埋め込みテキストを確認中...`);
            embeddedTextMap = await extractEmbeddedTextFromPdfPages(pdfPath, pageIndices);
            console.log(`[PDFテキスト] ${embeddedTextMap.size}/${pageIndices.length} ページで埋め込みテキストを検出`);
        } catch (e) {
            console.warn(`[PDFテキスト] 抽出に失敗したためOCR処理へフォールバックします: ${e.message}`);
            embeddedTextMap = new Map();
        }
    }

    const ndlocrTargetPages = pageIndices.filter(pNum => !embeddedTextMap.has(pNum));

    let ndlocrOutDir = null;
    let tmpDir = null;
    const cleanupNdlocrTempDir = () => {
        if (!tmpDir || !fs.existsSync(tmpDir)) return;
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[警告] 一時ディレクトリの削除に失敗しました: ${e.message}`);
            return;
        }
        tmpDir = null;
    };
    if (useNdlocr && ndlocrTargetPages.length > 0) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndlocr_'));
        ndlocrOutDir = path.join(tmpDir, 'output');
        fs.mkdirSync(ndlocrOutDir);

        const parallelJobs = getNdlocrParallelJobs();
        const pageChunkSize = getNdlocrPageChunkSize();
        const workerStartDelayMs = getNdlocrWorkerStartDelayMs();
        const ndlocrImageDpi = getNdlocrImageDpi();
        const workersRoot = path.join(tmpDir, 'workers');
        fs.mkdirSync(workersRoot, { recursive: true });

        const sortedTargetPages = [...ndlocrTargetPages].sort((a, b) => a - b);
        const pageChunks = chunkArray(sortedTargetPages, pageChunkSize);
        const jobs = [];
        for (let i = 0; i < pageChunks.length; i++) {
            const pages = pageChunks[i];
            const jobRoot = path.join(workersRoot, `job${String(i + 1).padStart(4, '0')}`);
            const srcDir = path.join(jobRoot, 'images');
            const outDir = path.join(jobRoot, 'output');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.mkdirSync(outDir, { recursive: true });
            jobs.push({ srcDir, outDir, pageCount: pages.length, pages });
        }

        if (jobs.length === 0) {
            throw new Error('ndlocr の処理チャンクを作成できませんでした');
        }
        
        console.log(`[ndlocr] 対象 ${ndlocrTargetPages.length} ページを処理します。`);
        console.log(`[ndlocr] 並列ワーカー数: ${parallelJobs}`);
        try {
            const workerCount = Math.min(parallelJobs, jobs.length);
            console.log(`[ndlocr] チャンクサイズ: ${pageChunkSize}ページ / チャンク数: ${jobs.length} / 起動間隔: ${workerStartDelayMs}ms / 画像DPI: ${ndlocrImageDpi}`);

            const seenPages = new Set();
            const totalPages = ndlocrTargetPages.length;
            const scanProgress = () => {
                if (!fs.existsSync(ndlocrOutDir)) return;
                for (const fileName of fs.readdirSync(ndlocrOutDir)) {
                    const match = fileName.match(/^page_(\d+)\.txt$/i);
                    if (!match) continue;
                    const pageNum = parseInt(match[1], 10);
                    if (seenPages.has(pageNum)) continue;
                    seenPages.add(pageNum);
                    console.log(`[ndlocr] 完了: ページ ${pageNum} (${seenPages.size}/${totalPages})`);
                }
            };

            const timer = setInterval(scanProgress, 1000);
            let renderChain = Promise.resolve();
            const renderWithLock = async (taskFn) => {
                const run = () => taskFn();
                const next = renderChain.then(run, run);
                renderChain = next.catch(() => { });
                return next;
            };
            const prepareJob = async (job) => {
                await renderWithLock(async () => {
                    const firstPage = job.pages[0];
                    const lastPage = job.pages[job.pages.length - 1];
                    const pageLabel = firstPage === lastPage ? `${firstPage}` : `${firstPage}-${lastPage}`;
                    console.log(`[ndlocr] 画像化中: ページ ${pageLabel}`);
                    await extractPdfPagesToImages(pdfPath, job.srcDir, ndlocrImageDpi, job.pages);
                });
            };

            try {
                await runNdlocrJobQueue(jobs, workerCount, workerStartDelayMs, ndlocrOutDir, prepareJob);
            } finally {
                clearInterval(timer);
                scanProgress();
            }

            console.log(`[ndlocr] ndlocr-lite の処理が完了しました。`);
        } catch (err) {
            console.error(`[ndlocr エラー] ${err.message}`);
            cleanupNdlocrTempDir();
            throw new Error(`ndlocr-lite の実行に失敗しました。OCRモードの暗黙フォールバックは行いません: ${err.message}`);
        }
    } else if (useNdlocr && ndlocrTargetPages.length === 0) {
        console.log(`[ndlocr] すべての対象ページで埋め込みテキストを検出したため、ndlocr実行をスキップします。`);
    }

    if (ndlocrOnly) {
        console.log(`[ndlocr-only] AI後処理なしでテキストを組み立てます。`);
        for (const pNum of pageIndices) {
            let sourceText = null;
            if (embeddedTextMap.has(pNum)) {
                sourceText = embeddedTextMap.get(pNum);
            } else if (ndlocrOutDir) {
                const fileName = `page_${String(pNum).padStart(4, '0')}.txt`;
                const txtPath = path.join(ndlocrOutDir, fileName);
                if (fs.existsSync(txtPath)) {
                    sourceText = fs.readFileSync(txtPath, 'utf8');
                }
            }

            if (sourceText !== null) {
                const pageContent = normalizeNdlocrText(sourceText);
                pageMap.set(pNum, pageContent);
                pageErrorMap.delete(pNum);
            } else {
                setPageError(pNum, 'ndlocr または埋め込みテキストからページ内容を取得できませんでした。');
            }
        }
    } else {
        const pageTextMap = new Map();
        for (const pNum of pageIndices) {
            if (embeddedTextMap.has(pNum)) {
                pageTextMap.set(pNum, embeddedTextMap.get(pNum));
            } else if (useNdlocr && ndlocrOutDir) {
                const fileName = `page_${String(pNum).padStart(4, '0')}.txt`;
                const txtPath = path.join(ndlocrOutDir, fileName);
                if (fs.existsSync(txtPath)) {
                    pageTextMap.set(pNum, fs.readFileSync(txtPath, 'utf8'));
                }
            }
        }

        // 1. Prepare all requests
        const requests = [];
        const batchMetadata = [];
        const effectiveBatchSize = preferPdfText ? 1 : batchSize;
        
        for (let i = 0; i < pageIndices.length; i += effectiveBatchSize) {
            const batch = pageIndices.slice(i, i + effectiveBatchSize);

            const hasTextForAllPages = batch.every(pNum => pageTextMap.has(pNum));

            if (hasTextForAllPages) {
                requests.push(createRawTextRequest(batch, pageTextMap, contextInstruction));
                batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch, ...primaryGeminiRequestMeta });
                continue;
            }

            if (useNdlocr) {
                const fallbackTextMap = new Map();
                for (const pNum of batch) {
                    fallbackTextMap.set(pNum, pageTextMap.get(pNum) || "[未検出]");
                }
                requests.push(createRawTextRequest(batch, fallbackTextMap, contextInstruction));
                batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch, ...primaryGeminiRequestMeta });
                continue;
            }

            if (aiProvider === 'gemini' && processMode === 'sync') {
                console.log(`[同期] Gemini PDF直読み回避: ページ ${batch.join(',')} を画像化してOCRします`);
                requests.push(await createImageOcrRequestFromPdfPages(pdfPath, batch, contextInstruction));
            } else {
                if (!srcDoc && !pdfLibLoadFailed) {
                    try {
                        pdfBuffer = await fsPromises.readFile(pdfPath);
                        srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
                    } catch (e) {
                        pdfBuffer = null;
                        pdfLibLoadFailed = true;
                        console.warn(`[警告] PDFの部分切り出しに失敗したため、ページ画像化でOCRします: ${e.message}`);
                    }
                }

                if (!srcDoc) {
                    console.log(`[情報] ページ ${batch.join(',')} を画像化してOCRします`);
                    requests.push(await createImageOcrRequestFromPdfPages(pdfPath, batch, contextInstruction));
                    batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch, ...primaryGeminiRequestMeta });
                    continue;
                }

                const newDoc = await PDFDocument.create();
                for (const pNum of batch) {
                    const [copiedPage] = await newDoc.copyPages(srcDoc, [pNum - 1]);
                    newDoc.addPage(copiedPage);
                }

                const batchPdfBytes = await newDoc.save();
                requests.push(createOcrRequest(Buffer.from(batchPdfBytes), batch.length, contextInstruction));
            }
            
            batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch, ...primaryGeminiRequestMeta });
        }

        // PDFDocument は元PDF全体を保持するため、API送信前に参照を解放する。
        // 特に大容量PDFでは、リクエスト本文との同時保持を避ける必要がある。
        srcDoc = null;
        pdfBuffer = null;

        // 2. Run Batch(es) with Retry Logic
        // 全ページが白紙ならリクエストは0件。APIキー確認を含むprovider初期化も行わない。
        const batchProcessor = aiProvider === 'gemini' && requests.length > 0
            ? new GeminiBatchProcessor()
            : null;
        let pendingIndices = requests.map((_, i) => i);
        const MAX_RETRIES = 3;
        const MIN_EMPTY_CONFIRMATIONS = 2;
        const retryBudget = createIndependentRetryBudget(MAX_RETRIES);
        const emptyResponseCounts = new Map();
        const splitBatchIndices = new Set();
        // 表を書き起こさず説明だけを返したページの再試行管理。
        // 直前の本文は捨てずに保持し、再試行が実らなければ元の本文へ戻す。
        const MAX_TABLE_RETRIES = 2;
        const droppedTableAttempts = new Map();
        const droppedTableFallback = new Map();

        const progressState = {
            completed: 0,
            total: requests.length,
            startTime: Date.now()
        };

        // ページマップの中間結果をディスクに保存するヘルパー
        const saveIntermediateResults = () => {
            if (pageMap.size === 0 && pageErrorMap.size === 0) return;
            let tmpMarkdown = "";
            for (let i = startPage; i <= actualEndPage; i++) {
                if (pageMap.has(i)) {
                    tmpMarkdown += pageMap.get(i) + "\n\n";
                } else {
                    tmpMarkdown += buildOcrErrorPageContent(i, pageErrorMap.get(i));
                }
            }
            const contentWithMetadata = appendOcrSettingsComment(tmpMarkdown, pdfPath, 'pdf', {
                ...metadataOptions,
                aiProvider,
                processMode,
                batchSize,
                startPage,
                endPage: actualEndPage,
                requestedEndPage: endPage,
                totalPages,
                useNdlocr,
                ndlocrOnly,
                preferPdfText,
                hasError: true
            });
            writeTextFileWithContext(errorPath, contentWithMetadata, 'OCR中間結果ファイル');
            console.log(`[情報] 中間結果を ${errorPath} に保存しました (${pageMap.size} ページ完了)`);
        };

        const enqueueSinglePageRetries = async (originalIndex, meta, unresolvedPages, nextPendingIndices) => {
            const canCrossFromBatchToSync = (
                processMode === 'batch' &&
                meta.pages.length === 1 &&
                !meta.forceSync
            );
            if (
                aiProvider !== 'gemini' ||
                (meta.pages.length <= 1 && !canCrossFromBatchToSync) ||
                unresolvedPages.length === 0 ||
                splitBatchIndices.has(originalIndex)
            ) {
                return false;
            }

            const recoveryLabel = canCrossFromBatchToSync
                ? '同期inline用の単ページ要求へ切替えます'
                : '独立した単ページ要求へ分割します';
            console.warn(`[再試行] バッチ ${originalIndex} の未解決ページ ${unresolvedPages.join(', ')} を${recoveryLabel}。`);
            try {
                const splitRequests = [];
                for (const pageNum of unresolvedPages) {
                    splitRequests.push({
                        pageNum,
                        request: await createImageOcrRequestFromPdfPages(pdfPath, [pageNum], contextInstruction)
                    });
                }
                for (const item of splitRequests) {
                    const newIndex = requests.length;
                    requests.push(item.request);
                    batchMetadata.push({
                        startPage: item.pageNum,
                        numPages: 1,
                        pages: [item.pageNum],
                        forceSync: processMode === 'batch',
                        modelIndex: Number(meta.modelIndex || 0),
                        modelId: meta.modelId || geminiModelPriority[Number(meta.modelIndex || 0)]
                    });
                    nextPendingIndices.push(newIndex);
                }
                splitBatchIndices.add(originalIndex);
                progressState.total = requests.length;
            } catch (e) {
                const detail = `単ページ再試行用の画像化に失敗: ${e.message}`;
                setPageErrorForPages(unresolvedPages, detail);
                console.warn(`[再試行] ${detail}。`);

                // 一部ページを既に確定した親バッチは再送しない。
                // 全ページ未解決で親側の枠が残る場合だけ、親要求を再試行する。
                const hasResolvedPage = meta.pages.some(pageNum => pageMap.has(pageNum));
                if (!hasResolvedPage && retryBudget.canRetry(originalIndex)) {
                    nextPendingIndices.push(originalIndex);
                }
            }
            return true;
        };

        const enqueueNextGeminiModel = async (meta, unresolvedPages, nextPendingIndices, response = null) => {
            if (aiProvider !== 'gemini' || unresolvedPages.length === 0) return false;
            const nextModel = selectNextGeminiModel(geminiModelPriority, meta.modelIndex, response);
            if (!nextModel) return false;
            const { modelIndex: nextModelIndex, modelId: nextModelId } = nextModel;

            console.warn(
                `[モデル切替] ${meta.modelId || geminiModelPriority[Number(meta.modelIndex || 0)]} で未解決の ` +
                `ページ ${unresolvedPages.join(', ')} を ${nextModelId} へ切替えます。`
            );
            try {
                for (const pageNum of unresolvedPages) {
                    const newIndex = requests.length;
                    requests.push(await createImageOcrRequestFromPdfPages(pdfPath, [pageNum], contextInstruction));
                    batchMetadata.push({
                        startPage: pageNum,
                        numPages: 1,
                        pages: [pageNum],
                        forceSync: processMode === 'batch',
                        modelIndex: nextModelIndex,
                        modelId: nextModelId
                    });
                    nextPendingIndices.push(newIndex);
                }
                progressState.total = requests.length;
                return true;
            } catch (e) {
                const detail = `次モデル再試行用の画像化に失敗: ${e.message}`;
                setPageErrorForPages(unresolvedPages, detail);
                console.warn(`[モデル切替] ${detail}。`);
                return false;
            }
        };

        while (pendingIndices.length > 0) {
            const currentRequests = pendingIndices.map(i => requests[i]);
            const currentMetadata = pendingIndices.map(i => batchMetadata[i]);
            const currentAttempts = pendingIndices.map(i => retryBudget.begin(i));
            const maxCurrentAttempt = Math.max(...currentAttempts);
            if (maxCurrentAttempt > 1) {
                console.log(`[情報] ${pendingIndices.length} 件の要求をリトライ中 (個別試行 最大 ${maxCurrentAttempt}/${MAX_RETRIES})...`);
            }
            
            let batchResults;
            try {
                if (aiProvider === 'claude') {
                    batchResults = await runClaudeBatch(currentRequests, progressState, processMode);
                } else if (aiProvider === 'openai') {
                    const persistenceFile = `${pdfPath}.batch_state.txt`;
                    batchResults = await runOpenAIBatch(currentRequests, progressState, processMode, persistenceFile);
                } else {
                    // Resilience: Use a persistence file for the batch state
                    const persistenceFile = `${pdfPath}.batch_state.txt`;
                    batchResults = await runGeminiRequestsWithRecoveryTransport(
                        currentRequests,
                        currentMetadata,
                        batchProcessor,
                        progressState,
                        persistenceFile,
                        processMode
                    );
                }
            } catch (batchError) {
                console.error(`[エラー] バッチAPI呼び出しが失敗しました: ${batchError.message}`);
                const nextPendingIndices = [];
                for (let i = 0; i < currentMetadata.length; i++) {
                    const originalIndex = pendingIndices[i];
                    const meta = currentMetadata[i];
                    const attempt = currentAttempts[i];
                    const unresolvedPages = meta.pages.filter(pageNum => !pageMap.has(pageNum));
                    const detail = `バッチAPI呼び出し失敗 (試行 ${attempt}/${MAX_RETRIES}): ${batchError.message}`;
                    setPageErrorForPages(unresolvedPages, detail);

                    if (retryBudget.canRetry(originalIndex)) {
                        nextPendingIndices.push(originalIndex);
                        continue;
                    }

                    const splitQueued = await enqueueSinglePageRetries(
                        originalIndex,
                        meta,
                        unresolvedPages,
                        nextPendingIndices
                    );
                    const modelQueued = splitQueued
                        ? false
                        : await enqueueNextGeminiModel(meta, unresolvedPages, nextPendingIndices);
                    if (!splitQueued && !modelQueued && unresolvedPages.length > 0) {
                        console.error(`[エラー] 要求 ${originalIndex} (ページ ${unresolvedPages.join(', ')}) は再試行上限に達しました。`);
                    }
                }

                pendingIndices = nextPendingIndices;
                if (pageMap.size > 0 || pageErrorMap.size > 0) {
                    saveIntermediateResults();
                }
                continue;
            }

            const nextPendingIndices = [];

            for (let i = 0; i < currentRequests.length; i++) {
                const originalIndex = pendingIndices[i];
                const result = batchResults[i] || { error: { message: 'Result missing for this request item' } };
                const meta = batchMetadata[originalIndex];
                
                let success = false;
                let text = "";
                let splitPages = [];
                const responseDiagnostic = summarizeAiResponse(result.response);
                const explicitSafetyStop = isExplicitSafetyStop(result.response);

                if (!result.error && result.response?.candidates?.[0]) {
                    const responseParts = result.response.candidates[0].content?.parts || [];
                    text = responseParts.map(p => p.text || '').join('');
                    const assessment = applyOcrBatchTextResult(
                        text,
                        meta.pages,
                        pageMap,
                        emptyResponseCounts
                    );
                    const normalized = assessment.normalized;
                    const strictMarkerMatch = normalized.beginCount === meta.numPages && normalized.endCount === meta.numPages;

                    if (normalized.ok && !(strictMarkerMatch && normalized.validRelativeCount === meta.numPages)) {
                        if (normalized.missingRelativePages.length > 0) {
                            console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) で空ページまたはマーカー欠落を検出しました。相対ページ ${normalized.missingRelativePages.join(',')} だけを再試行します。`);
                        } else {
                            console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) のマーカー形式にゆらぎがありましたが、抽出結果を採用しました。開始:${normalized.beginCount}, 終了:${normalized.endCount}`);
                        }
                    } else if (!normalized.ok && !(meta.pages.length === 1 && text.trim().length === 0)) {
                        const detail = `バッチ検証失敗: expected markers=${meta.numPages}, begin=${normalized.beginCount}, end=${normalized.endCount}, validRelative=${normalized.validRelativeCount}`;
                        setPageErrorForPages(assessment.unresolvedPages, detail);
                        console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) の検証に失敗しました。期待されるマーカー数: ${meta.numPages}, 実際: 開始:${normalized.beginCount}, 終了:${normalized.endCount}。`);
                    }

                    clearPageErrorsForPages(assessment.usefulPages);

                    if (assessment.emptyPages.length > 0) {
                        const detail = `AI OCRがページマーカーのみ、または空本文を返しました。空本文ページ: ${assessment.emptyPages.join(', ')}。応答診断: ${responseDiagnostic}`;
                        setPageErrorForPages(assessment.emptyPages, detail);
                        console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) で空本文を検出しました: ${assessment.emptyPages.join(', ')}。`);
                        console.warn(`[診断] ${responseDiagnostic}`);
                    }

                    // 表を書き起こさず説明だけを返したページは、本文を退避してから未解決へ戻す。
                    // 未解決になれば既存の単ページ再試行・モデル切替がそのまま働く。
                    const droppedTablePages = findDroppedTablePages(pageMap, assessment.usefulPages)
                        .filter(pageNum => (droppedTableAttempts.get(pageNum) || 0) < MAX_TABLE_RETRIES);
                    if (droppedTablePages.length > 0) {
                        for (const pageNum of droppedTablePages) {
                            if (!droppedTableFallback.has(pageNum)) {
                                droppedTableFallback.set(pageNum, pageMap.get(pageNum));
                            }
                            droppedTableAttempts.set(pageNum, (droppedTableAttempts.get(pageNum) || 0) + 1);
                            pageMap.delete(pageNum);
                        }
                        const detail = `表が書き起こされず説明文で置き換えられました。対象ページ: ${droppedTablePages.join(', ')}`;
                        setPageErrorForPages(droppedTablePages, detail);
                        console.warn(`[警告] バッチ ${originalIndex} で表の取りこぼしを検出しました: ページ ${droppedTablePages.join(', ')}。再試行します。`);
                    }

                    const confirmationCandidates = assessment.unresolvedPages.filter(
                        pageNum => (emptyResponseCounts.get(pageNum) || 0) >= MIN_EMPTY_CONFIRMATIONS
                    );
                    if (confirmationCandidates.length > 0) {
                        try {
                            const confirmedBlankPages = await confirmRepeatedEmptyPdfPages(pdfPath, confirmationCandidates);
                            for (const pageNum of confirmedBlankPages) {
                                pageMap.set(pageNum, buildBlankOcrPageContent(pageNum, false));
                            }
                            clearPageErrorsForPages(confirmedBlankPages);
                            if (confirmedBlankPages.length > 0) {
                                console.warn(`[白紙確認] Geminiの反復空応答とスキャナ汚れ許容判定が一致したため、ページ ${confirmedBlankPages.join(', ')} を白紙として確定しました。`);
                            }
                        } catch (e) {
                            console.warn(`[白紙確認] 二次判定に失敗したため空本文ページを白紙確定しません: ${e.message}`);
                        }
                    }

                    const unresolvedPages = meta.pages.filter(pageNum => !pageMap.has(pageNum));
                    success = unresolvedPages.length === 0;
                    if (
                        !success &&
                        !explicitSafetyStop &&
                        aiProvider === 'gemini' &&
                        (meta.pages.length > 1 || (processMode === 'batch' && !meta.forceSync)) &&
                        !splitBatchIndices.has(originalIndex)
                    ) {
                        splitPages = unresolvedPages;
                    }
                } else {
                    const unresolvedPages = meta.pages.filter(pageNum => !pageMap.has(pageNum));
                    const errorMessage = result.error?.message
                        ? normalizeErrorDetail(result.error.message)
                        : `AI応答にOCR本文なし。応答診断: ${responseDiagnostic}`;
                    setPageErrorForPages(unresolvedPages, errorMessage);
                    console.warn(`[警告] バッチ ${originalIndex} のOCR応答を採用できません: ${errorMessage}`);
                    if (
                        !retryBudget.canRetry(originalIndex) &&
                        !explicitSafetyStop &&
                        aiProvider === 'gemini' &&
                        (meta.pages.length > 1 || (processMode === 'batch' && !meta.forceSync)) &&
                        !splitBatchIndices.has(originalIndex)
                    ) {
                        splitPages = unresolvedPages;
                    }
                }

                if (success) {
                    clearPageErrorsForPages(meta.pages);
                } else if (explicitSafetyStop) {
                    console.warn(`[安全停止] ページ ${meta.pages.join(', ')} は別Geminiモデルへ自動送信しません。`);
                } else if (splitPages.length > 0) {
                    const splitQueued = await enqueueSinglePageRetries(
                        originalIndex,
                        meta,
                        splitPages,
                        nextPendingIndices
                    );
                    if (!splitQueued) {
                        if (retryBudget.canRetry(originalIndex)) {
                            nextPendingIndices.push(originalIndex);
                        } else {
                            await enqueueNextGeminiModel(meta, splitPages, nextPendingIndices, result.response);
                        }
                    }
                } else if (retryBudget.canRetry(originalIndex)) {
                    nextPendingIndices.push(originalIndex);
                } else {
                    const unresolvedPages = meta.pages.filter(pageNum => !pageMap.has(pageNum));
                    const modelQueued = await enqueueNextGeminiModel(meta, unresolvedPages, nextPendingIndices, result.response);
                    if (!modelQueued && unresolvedPages.length > 0) {
                        console.error(`[エラー] 要求 ${originalIndex} (ページ ${unresolvedPages.join(', ')}) は再試行上限に達しました。`);
                    }
                }
            }

            pendingIndices = nextPendingIndices;

            // リトライ間で中間結果を保存（クラッシュ耐性）
            if (pendingIndices.length > 0 && (pageMap.size > 0 || pageErrorMap.size > 0)) {
                saveIntermediateResults();
            }
        }

        // 表の再取得に失敗したページは、退避しておいた本文へ戻す。
        // 表は欠けたままだが、周囲の本文まで失うよりはよい。
        const tableFallbackPages = [];
        for (const [pageNum, fallbackBlock] of droppedTableFallback) {
            if (pageMap.has(pageNum) || !fallbackBlock) continue;
            pageMap.set(pageNum, fallbackBlock);
            tableFallbackPages.push(pageNum);
        }
        if (tableFallbackPages.length > 0) {
            clearPageErrorsForPages(tableFallbackPages);
            console.warn(
                `[警告] ページ ${tableFallbackPages.join(', ')} は再試行しても表を書き起こせませんでした。` +
                `表以外の本文を採用しています。該当ページは目視確認してください。`
            );
        }

        const unresolvedAfterAi = pageIndices.filter(pageNum => !pageMap.has(pageNum));
        if (unresolvedAfterAi.length > 0) {
            try {
                const recovered = await recoverPagesFromTrustedEmbeddedText(
                    pdfPath,
                    unresolvedAfterAi,
                    pageMap,
                    totalPages
                );
                for (const item of recovered) {
                    pageErrorMap.delete(item.pageNum);
                    console.warn(
                        `[PDFテキスト救済] ページ ${item.pageNum} を埋め込み文字層から復旧しました ` +
                        `(近接${item.neighborCount}頁、Jaccard=${item.bigramJaccard.toFixed(3)}、長さ比=${item.lengthRatio.toFixed(3)})。`
                    );
                }
            } catch (e) {
                console.warn(`[PDFテキスト救済] ローカル復旧判定に失敗しました: ${e.message}`);
            }
        }
    }

    // 3. Assemble results
    let allMarkdown = "";
    let hasError = false;

    if (ndlocrOnly) {
        for (let i = startPage; i <= actualEndPage; i++) {
            if (pageMap.has(i)) {
                allMarkdown += `----- Page ${i} -----\n${pageMap.get(i)}\n\n`;
            } else {
                allMarkdown += buildOcrErrorPageContent(i, pageErrorMap.get(i), true);
                hasError = true;
            }
        }
    } else {
        for (let i = startPage; i <= actualEndPage; i++) {
            if (pageMap.has(i)) {
                allMarkdown += pageMap.get(i) + "\n\n";
            } else {
                allMarkdown += buildOcrErrorPageContent(i, pageErrorMap.get(i));
                hasError = true;
            }
        }
    }

    cleanupNdlocrTempDir();

    if (hasError) {
        writeTextFileWithContext(errorPath, appendOcrSettingsComment(allMarkdown, pdfPath, 'pdf', {
            ...metadataOptions,
            aiProvider,
            processMode,
            batchSize,
            startPage,
            endPage: actualEndPage,
            requestedEndPage: endPage,
            totalPages,
            useNdlocr,
            ndlocrOnly,
            preferPdfText,
            hasError: true
        }), 'OCR中間結果ファイル');
        console.log(`[警告] エラーを含んだ状態で ${errorPath} に保存されました`);
        removeFileIfExists(normalPath, 'OCR結果ファイル');
        return errorPath;
    } else {
        writeTextFileWithContext(normalPath, appendOcrSettingsComment(allMarkdown, pdfPath, 'pdf', {
            ...metadataOptions,
            aiProvider,
            processMode,
            batchSize,
            startPage,
            endPage: actualEndPage,
            requestedEndPage: endPage,
            totalPages,
            useNdlocr,
            ndlocrOnly,
            preferPdfText,
            hasError: false
        }), 'OCR結果ファイル');
        console.log(`[成功] ${normalPath} に保存されました`);
        removeFileIfExists(errorPath, 'OCR中間結果ファイル');
        return normalPath;
    }
}

async function docToText(docPath, contextInstruction = "", aiProvider = "gemini", processMode = "batch", metadataOptions = {}) {
    const normalPath = docPath.replace(/\.doc$/i, "_paged.md");
    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');
    console.log(`[情報] Word文書(doc)の解析を開始: ${docPath} (AI: ${getAiModelLabel(aiProvider)}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

    try {
        // word-extractorを使用してテキストを抽出
        const extractor = new WordExtractor();
        const extracted = await extractor.extract(docPath);
        const extractedText = extracted.getBody();
        
        if (!extractedText || extractedText.trim().length === 0) {
            throw new Error("テキストを抽出できませんでした");
        }
        
        console.log(`[情報] テキスト抽出完了 (${extractedText.length} 文字)`);

        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        const progressState = {
            completed: 0,
            total: 1,
            startTime: Date.now()
        };

        const request = createDocTextRequest(extractedText, contextInstruction);

        const persistenceFile = `${docPath}.batch_state.txt`;
        const results = await runSingleBatch([request], batchProcessor, progressState, "word-batch-job", persistenceFile, aiProvider, processMode);
        const result = results[0];

        if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
            let text = result.response.candidates[0].content.parts.map(p => p.text).join('');
            writeTextFileWithContext(normalPath, appendOcrSettingsComment(text, docPath, 'doc', {
                ...metadataOptions,
                aiProvider,
                processMode,
                hasError: false
            }), 'OCR結果ファイル');
            console.log(`[成功] ${normalPath} に保存されました`);
            return normalPath;
        } else {
            throw new Error(JSON.stringify(result.error || "内容なし"));
        }
    } catch (e) {
        const errorMsg = `[エラー] Word文書(doc)の処理に失敗しました: ${e.message}`;
        console.error(errorMsg);
        throw e;
    }
}

async function docxToText(docxPath, contextInstruction = "", aiProvider = "gemini", processMode = "batch", metadataOptions = {}) {
    const normalPath = docxPath.replace(/\.docx$/i, "_paged.md");
    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');
    console.log(`[情報] Word文書(docx)の解析を開始: ${docxPath} (AI: ${getAiModelLabel(aiProvider)}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

    try {
        const zip = new AdminZip(docxPath);
        const dataParts = [];

        // 1. 本文XMLの抽出
        const documentXml = zip.readAsText("word/document.xml");
        if (documentXml) {
            dataParts.push({ text: "--- WORD DOCUMENT XML START ---\n" + documentXml + "\n--- WORD DOCUMENT XML END ---" });
        }

        // 2. 画像ファイルの抽出 (word/media/ 内の全ファイル)
        const entries = zip.getEntries();
        for (const entry of entries) {
            if (entry.entryName.startsWith("word/media/") && !entry.isDirectory) {
                const buffer = entry.getData();
                const ext = path.extname(entry.entryName).toLowerCase();
                let mimeType = "image/jpeg"; // default
                if (ext === ".png") mimeType = "image/png";
                else if (ext === ".webp") mimeType = "image/webp";
                else if (ext === ".gif") mimeType = "image/gif";

                dataParts.push({
                    inlineData: {
                        mimeType: mimeType,
                        data: buffer.toString('base64')
                    }
                });
            }
        }

        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        const progressState = {
            completed: 0,
            total: 1,
            startTime: Date.now()
        };

        const request = createDocRequest(
            { dataParts: dataParts, numPages: "Unknown" },
            contextInstruction,
            true
        );

        const persistenceFile = `${docxPath}.batch_state.txt`;
        const results = await runSingleBatch([request], batchProcessor, progressState, "word-batch-job", persistenceFile, aiProvider, processMode);
        const result = results[0];

        if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
            let text = result.response.candidates[0].content.parts.map(p => p.text).join('');
            writeTextFileWithContext(normalPath, appendOcrSettingsComment(text, docxPath, 'docx', {
                ...metadataOptions,
                aiProvider,
                processMode,
                hasError: false
            }), 'OCR結果ファイル');
            console.log(`[成功] ${normalPath} に保存されました`);
            return normalPath;
        } else {
            throw new Error(JSON.stringify(result.error || "内容なし"));
        }
    } catch (e) {
        const errorMsg = `[エラー] Word文書の処理に失敗しました: ${e.message}`;
        console.error(errorMsg);
        throw e;
    }
}

async function odtToText(odtPath, contextInstruction = "", aiProvider = "gemini", processMode = "batch", metadataOptions = {}) {
    const normalPath = odtPath.replace(/\.odt$/i, "_paged.md");
    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');
    console.log(`[情報] ODT文書の解析を開始: ${odtPath} (AI: ${getAiModelLabel(aiProvider)}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

    try {
        const zip = new AdminZip(odtPath);
        const dataParts = [];

        // 1. 本文XMLの抽出
        const contentXml = zip.readAsText("content.xml");
        if (contentXml) {
            dataParts.push({ text: "--- ODT CONTENT XML START ---\n" + contentXml + "\n--- ODT CONTENT XML END ---" });
        }

        // 2. スタイルXMLの抽出（構造の理解に役立つ）
        const stylesXml = zip.readAsText("styles.xml");
        if (stylesXml) {
            dataParts.push({ text: "--- ODT STYLES XML START ---\n" + stylesXml + "\n--- ODT STYLES XML END ---" });
        }

        // 3. 画像ファイルの抽出 (Pictures/ 内の全ファイル)
        const entries = zip.getEntries();
        for (const entry of entries) {
            if (entry.entryName.startsWith("Pictures/") && !entry.isDirectory) {
                const buffer = entry.getData();
                const ext = path.extname(entry.entryName).toLowerCase();
                let mimeType = "image/jpeg";
                if (ext === ".png") mimeType = "image/png";
                else if (ext === ".webp") mimeType = "image/webp";
                else if (ext === ".gif") mimeType = "image/gif";
                else if (ext === ".svg") continue; // SVGはスキップ

                dataParts.push({
                    inlineData: {
                        mimeType: mimeType,
                        data: buffer.toString('base64')
                    }
                });
            }
        }

        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        const progressState = { completed: 0, total: 1, startTime: Date.now() };

        const prompt = getWordPrompt(contextInstruction); // Word用プロンプトを流用（XML→Markdown変換として十分）
        const request = {
            contents: [{
                role: "user",
                parts: [...dataParts, { text: prompt }]
            }]
        };

        const persistenceFile = `${odtPath}.batch_state.txt`;
        const results = await runSingleBatch([request], batchProcessor, progressState, "odt-batch-job", persistenceFile, aiProvider, processMode);
        const result = results[0];

        if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
            let text = result.response.candidates[0].content.parts.map(p => p.text).join('');
            writeTextFileWithContext(normalPath, appendOcrSettingsComment(text, odtPath, 'odt', {
                ...metadataOptions,
                aiProvider,
                processMode,
                hasError: false
            }), 'OCR結果ファイル');
            console.log(`[成功] ${normalPath} に保存されました`);
            return normalPath;
        } else {
            throw new Error(JSON.stringify(result.error || "内容なし"));
        }
    } catch (e) {
        console.error(`[エラー] ODT文書の処理に失敗しました: ${e.message}`);
        throw e;
    }
}

function getPptxPrompt(contextInstruction = "") {
    return `
# ROLE
High-precision document transcribing engine converting Japanese PowerPoint (.pptx) slide content (XML and associated images) to clean Markdown.

${contextInstruction}

# INPUT
The following parts represent a Japanese PowerPoint (.pptx) presentation:
1. **XML Content**: The raw slide XML files containing text and structural tags.
2. **Images**: Visuals (photos, diagrams) extracted from the slides.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **No Skipping**: Transcribe every slide from the very beginning.
3. **Page Markers**:
   - **Start**: At the start of each slide, output \`### -- Begin Page N --\`.
     - N: Slide number (1-based).
   - **End**: At the end of each slide, output \`### -- End --\`.
4. **Transcription Rules**:
   - **No Indentation**: Standard Markdown paragraphs.
   - **Numbers**: Convert ALL full-width numbers to half-width.
   - **Slide Titles**: Use ## for slide titles.
   - **Bullet Points**: Use standard Markdown list syntax.
   - **Tables**: Format as Markdown tables.
   - **Visuals**: Correlate the provided images with their positions. For each, provide a Japanese explanation formatted as \`(--! Explanation)\`.
   - **Speaker Notes**: If present in the XML, include them formatted as \`> Note: ...\`.
   - **Exclusions**: Omit system tags/metadata. Keep the content clean.
`;
}

async function pptxToText(pptxPath, contextInstruction = "", aiProvider = "gemini", processMode = "batch", metadataOptions = {}) {
    const normalPath = pptxPath.replace(/\.pptx$/i, "_paged.md");
    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');
    console.log(`[情報] PowerPoint文書の解析を開始: ${pptxPath} (AI: ${getAiModelLabel(aiProvider)}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

    try {
        const zip = new AdminZip(pptxPath);
        const dataParts = [];

        // 1. スライドXMLの抽出（番号順にソート）
        const entries = zip.getEntries();
        const slideEntries = entries
            .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
            .sort((a, b) => {
                const numA = parseInt(a.entryName.match(/slide(\d+)/)[1]);
                const numB = parseInt(b.entryName.match(/slide(\d+)/)[1]);
                return numA - numB;
            });

        for (const entry of slideEntries) {
            const xml = zip.readAsText(entry.entryName);
            const slideNum = entry.entryName.match(/slide(\d+)/)[1];
            dataParts.push({ text: `--- SLIDE ${slideNum} XML START ---\n${xml}\n--- SLIDE ${slideNum} XML END ---` });
        }

        // 2. ノートの抽出
        const noteEntries = entries
            .filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName))
            .sort((a, b) => {
                const numA = parseInt(a.entryName.match(/notesSlide(\d+)/)[1]);
                const numB = parseInt(b.entryName.match(/notesSlide(\d+)/)[1]);
                return numA - numB;
            });

        for (const entry of noteEntries) {
            const xml = zip.readAsText(entry.entryName);
            const noteNum = entry.entryName.match(/notesSlide(\d+)/)[1];
            dataParts.push({ text: `--- NOTES FOR SLIDE ${noteNum} START ---\n${xml}\n--- NOTES FOR SLIDE ${noteNum} END ---` });
        }

        // 3. 画像ファイルの抽出 (ppt/media/ 内)
        for (const entry of entries) {
            if (entry.entryName.startsWith("ppt/media/") && !entry.isDirectory) {
                const buffer = entry.getData();
                const ext = path.extname(entry.entryName).toLowerCase();
                let mimeType = "image/jpeg";
                if (ext === ".png") mimeType = "image/png";
                else if (ext === ".webp") mimeType = "image/webp";
                else if (ext === ".gif") mimeType = "image/gif";
                else if (ext === ".emf" || ext === ".wmf" || ext === ".svg") continue; // 非対応形式はスキップ

                dataParts.push({
                    inlineData: {
                        mimeType: mimeType,
                        data: buffer.toString('base64')
                    }
                });
            }
        }

        console.log(`[情報] ${slideEntries.length} スライドを検出`);

        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        const progressState = { completed: 0, total: 1, startTime: Date.now() };

        const prompt = getPptxPrompt(contextInstruction);
        const request = {
            contents: [{
                role: "user",
                parts: [...dataParts, { text: prompt }]
            }]
        };

        const persistenceFile = `${pptxPath}.batch_state.txt`;
        const results = await runSingleBatch([request], batchProcessor, progressState, "pptx-batch-job", persistenceFile, aiProvider, processMode);
        const result = results[0];

        if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
            let text = result.response.candidates[0].content.parts.map(p => p.text).join('');
            writeTextFileWithContext(normalPath, appendOcrSettingsComment(text, pptxPath, 'pptx', {
                ...metadataOptions,
                aiProvider,
                processMode,
                hasError: false
            }), 'OCR結果ファイル');
            console.log(`[成功] ${normalPath} に保存されました`);
            return normalPath;
        } else {
            throw new Error(JSON.stringify(result.error || "内容なし"));
        }
    } catch (e) {
        console.error(`[エラー] PowerPoint文書の処理に失敗しました: ${e.message}`);
        throw e;
    }
}

async function imageToText(imagePath, contextInstruction = "", aiProvider = "gemini", processMode = "batch", metadataOptions = {}) {
    const ext = path.extname(imagePath).toLowerCase();
    const baseName = path.basename(imagePath, ext);
    const normalPath = path.join(path.dirname(imagePath), baseName + "_paged.md");

    if (hasExistingOutputFile(normalPath, 'OCR結果ファイル')) {
        console.log(`[スキップ] 出力ファイルが既に存在します: ${normalPath}`);
        return normalPath;
    }
    ensureWritableOutputPath(normalPath, 'OCR結果ファイル');

    console.log(`[情報] 画像のOCR処理を開始: ${imagePath} (AI: ${getAiModelLabel(aiProvider)}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        let mimeType = "image/jpeg";
        if (ext === ".png") mimeType = "image/png";
        else if (ext === ".webp") mimeType = "image/webp";
        else if (ext === ".gif") mimeType = "image/gif";
        else if (ext === ".bmp") mimeType = "image/bmp";
        else if (ext === ".tif" || ext === ".tiff") mimeType = "image/tiff";

        const request = createDocRequest({
            dataParts: [{
                inlineData: {
                    mimeType: mimeType,
                    data: imageBuffer.toString('base64')
                }
            }],
            numPages: 1
        }, contextInstruction, false);

        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        const progressState = { completed: 0, total: 1, startTime: Date.now() };
        const persistenceFile = `${imagePath}.batch_state.txt`;

        const results = await runSingleBatch([request], batchProcessor, progressState, "image-ocr-job", persistenceFile, aiProvider, processMode);
        const result = results[0];

        if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
            let text = result.response.candidates[0].content.parts.map(p => p.text).join('');
            writeTextFileWithContext(normalPath, appendOcrSettingsComment(text, imagePath, 'image', {
                ...metadataOptions,
                aiProvider,
                processMode,
                hasError: false
            }), 'OCR結果ファイル');
            console.log(`[成功] ${normalPath} に保存されました`);
            return normalPath;
        } else {
            throw new Error(JSON.stringify(result.error || "内容なし"));
        }
    } catch (e) {
        console.error(`[エラー] 画像のOCR処理に失敗しました: ${e.message}`);
        throw e;
    }
}

module.exports = {
    pdfToText,
    docToText,
    docxToText,
    odtToText,
    pptxToText,
    imageToText,
    getOcrPrompt,
    estimateRequestsPayloadBytes,
    applyOcrBatchTextResult,
    confirmRepeatedEmptyPdfPages,
    createIndependentRetryBudget,
    extractPagesFromMarkdown,
    stripOcrSettingsComments,
    summarizeAiResponse,
    hasUsableAiResponseText,
    isExplicitSafetyStop,
    selectNextGeminiModel,
    runSingleBatch,
    runGeminiRequestsWithRecoveryTransport,
    compareTextSimilarity,
    recoverPagesFromTrustedEmbeddedText,
    describesTableWithoutTranscribing,
    findDroppedTablePages
};
