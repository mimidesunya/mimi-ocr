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
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { extractPdfPagesToImages } = require('./pdf_to_image');
const { runNdlocr } = require('./ndlocr_runner');
const { loadConfig, getGeminiChatModel } = require('./gemini_client');

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
   - **Visuals**: If there are photos or diagrams, provide an explanation for them in Japanese formatted as \`(--! Explanation)\`.
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

async function runBatches(requests, metadata, batchProcessor, progressState, persistenceFile, processMode = 'batch') {
    const modelId = getGeminiChatModel();
    if (processMode === 'sync') {
        console.log(`[同期] ${requests.length} 件のリクエストを同期モードで処理中...`);
        return await batchProcessor.runSync(requests, modelId, progressState);
    }
    
    // リクエストサイズを見積もり、閾値に応じてインラインかファイルバッチを選択
    const INLINE_THRESHOLD = 15 * 1024 * 1024; // 15MB（安全マージン込み）
    
    const payloadEstimate = JSON.stringify(requests).length;
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
    const modelId = getGeminiChatModel();
    if (aiProvider === 'claude') {
        return await runClaudeBatch(requests, progressState, processMode);
    }
    if (aiProvider === 'openai') {
        return await runOpenAIBatch(requests, progressState, processMode, persistenceFile);
    }
    
    if (processMode === 'sync') {
        console.log(`[同期] リクエストを同期モードで処理中...`);
        return await batchProcessor.runSync(requests, modelId, progressState);
    }
    
    const INLINE_THRESHOLD = 15 * 1024 * 1024; // 15MB
    
    const payloadEstimate = JSON.stringify(requests).length;
    const sizeMB = (payloadEstimate / 1024 / 1024).toFixed(2);
    
    console.log(`[バッチ] リクエスト送信中... (見積もりサイズ: ${sizeMB} MB)`);
    
    if (payloadEstimate < INLINE_THRESHOLD) {
        console.log(`[バッチ] インラインバッチを使用 (高速モード)`);
        return await batchProcessor.runInlineBatch(requests, modelId, progressState, displayName);
    } else {
        console.log(`[バッチ] ファイルバッチを使用 (大容量モード)`);
        return await batchProcessor.runFileBatch(requests, modelId, progressState, displayName, persistenceFile);
    }
}

function extractPagesFromMarkdown(content) {
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
    const config = loadConfig() || {};
    const aiProvider = runtimeOptions.aiProvider || 'gemini';
    const providerConfig = config?.[aiProvider] || {};
    const ndlocrConfig = config?.ndlocrLite || {};
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
                model: providerConfig.chatModel || providerConfig.model
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
    const config = loadConfig();
    const raw = config?.ndlocrLite?.parallelJobs;

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
    const config = loadConfig();
    return parsePositiveIntSetting(config?.ndlocrLite?.pageChunkSize, 8, 200);
}

function getNdlocrWorkerStartDelayMs() {
    const config = loadConfig();
    return parseNonNegativeIntSetting(config?.ndlocrLite?.workerStartDelayMs, 1500, 60000);
}

function getNdlocrImageDpi() {
    const config = loadConfig();
    return parsePositiveIntSetting(config?.ndlocrLite?.imageDpi, 300, 600);
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

    const pdfjsPackageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const standardFontDataUrl = path.join(pdfjsPackageDir, 'standard_fonts') + path.sep;
    const cMapUrl = path.join(pdfjsPackageDir, 'cmaps') + path.sep;
    const pdfBytes = fs.readFileSync(pdfPath);

    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        isEvalSupported: false
    });

    const srcPdf = await loadingTask.promise;
    try {
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
        if (typeof srcPdf.cleanup === 'function') {
            srcPdf.cleanup();
        }
    }

    return result;
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

    console.log(`[情報] AIプロバイダー: ${aiProvider} / モード: ${processMode === 'sync' ? '同期' : 'バッチ'} / ndlocr: ${useNdlocr ? (ndlocrOnly ? 'Only' : 'Pre-OCR') : 'Off'} / PDFテキスト優先: ${preferPdfText ? 'On' : 'Off'}`);
    const pdfBuffer = await fsPromises.readFile(pdfPath);
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    
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
    if (!ndlocrOnly && fs.existsSync(errorPath)) {
        const existingContent = fs.readFileSync(errorPath, 'utf-8');
        pageMap = extractPagesFromMarkdown(existingContent);
        if (pageMap.size > 0) {
            console.log(`[情報] ${errorPath} から再開します (${pageMap.size} ページ完了済み)`);
        }
    }

    const pageIndices = [];
    for (let i = startPage; i <= actualEndPage; i++) {
        if (!pageMap.has(i)) {
            pageIndices.push(i);
        }
    }

    if (pageIndices.length === 0) {
        console.log(`[情報] すべての対象ページは既に完了しています。`);
        return fs.existsSync(errorPath) ? errorPath : normalPath;
    }

    let embeddedTextMap = new Map();
    if (preferPdfText) {
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
            if (ndlocrOnly) {
                throw err;
            }
            console.log(`[ndlocr] ndlocr-lite の結果なしで通常のAI OCRを続行します。`);
            useNdlocr = false;
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
                batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch });
                continue;
            }

            if (useNdlocr) {
                const fallbackTextMap = new Map();
                for (const pNum of batch) {
                    fallbackTextMap.set(pNum, pageTextMap.get(pNum) || "[未検出]");
                }
                requests.push(createRawTextRequest(batch, fallbackTextMap, contextInstruction));
                batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch });
                continue;
            }

            const newDoc = await PDFDocument.create();
            for (const pNum of batch) {
                const [copiedPage] = await newDoc.copyPages(srcDoc, [pNum - 1]);
                newDoc.addPage(copiedPage);
            }

            const batchPdfBytes = await newDoc.save();

            requests.push(createOcrRequest(Buffer.from(batchPdfBytes), batch.length, contextInstruction));
            
            batchMetadata.push({ startPage: batch[0], numPages: batch.length, pages: batch });
        }

        // 2. Run Batch(es) with Retry Logic
        const batchProcessor = aiProvider === 'claude' ? null : new GeminiBatchProcessor();
        let pendingIndices = requests.map((_, i) => i);
        let retryCount = 0;
        const MAX_RETRIES = 3;

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

        while (pendingIndices.length > 0) {
            if (retryCount >= MAX_RETRIES) {
                console.error(`[エラー] リトライ上限に達しました。${pendingIndices.length} 件のバッチが失敗しました。`);
                break;
            }
            
            if (retryCount > 0) {
                console.log(`[情報] ${pendingIndices.length} 件のバッチをリトライ中 (試行 ${retryCount}/${MAX_RETRIES})...`);
            }

            const currentRequests = pendingIndices.map(i => requests[i]);
            const currentMetadata = pendingIndices.map(i => batchMetadata[i]);
            
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
                    batchResults = await runBatches(currentRequests, currentMetadata, batchProcessor, progressState, persistenceFile, processMode);
                }
            } catch (batchError) {
                console.error(`[エラー] バッチAPI呼び出しが失敗しました: ${batchError.message}`);
                const detail = `バッチAPI呼び出し失敗 (試行 ${retryCount + 1}/${MAX_RETRIES}): ${batchError.message}`;
                for (const m of currentMetadata) {
                    setPageErrorForPages(m.pages, detail);
                }
                // バッチ全体が失敗した場合、中間結果を保存してリトライを続行
                saveIntermediateResults();
                retryCount++;
                continue;
            }

            const nextPendingIndices = [];

            for (let i = 0; i < batchResults.length; i++) {
                const originalIndex = pendingIndices[i];
                const result = batchResults[i];
                const meta = batchMetadata[originalIndex];
                
                let success = false;
                let text = "";
                let normalizedPageMap = null;

                if (!result.error && result.response?.candidates?.[0]?.content?.parts) {
                    text = result.response.candidates[0].content.parts.map(p => p.text).join('');

                    const normalized = toAbsoluteBatchPageMap(text, meta.pages);
                    const strictMarkerMatch = normalized.beginCount === meta.numPages && normalized.endCount === meta.numPages;

                    if (strictMarkerMatch && normalized.validRelativeCount === meta.numPages) {
                        success = true;
                        normalizedPageMap = normalized.pageMap;
                    } else if (normalized.ok) {
                        success = true;
                        normalizedPageMap = normalized.pageMap;
                        if (normalized.missingRelativePages.length > 0) {
                            console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) で空ページまたはマーカー欠落を検出。相対ページ ${normalized.missingRelativePages.join(',')} を空本文で補完しました。`);
                        } else {
                            console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) のマーカー形式にゆらぎがありましたが、抽出結果を採用しました。開始:${normalized.beginCount}, 終了:${normalized.endCount}`);
                        }
                    } else {
                        const detail = `バッチ検証失敗: expected markers=${meta.numPages}, begin=${normalized.beginCount}, end=${normalized.endCount}, validRelative=${normalized.validRelativeCount}`;
                        setPageErrorForPages(meta.pages, detail);
                        console.warn(`[警告] バッチ ${originalIndex} (ページ ${meta.pages.join(',')}) の検証に失敗しました。期待されるマーカー数: ${meta.numPages}, 実際: 開始:${normalized.beginCount}, 終了:${normalized.endCount}。`);
                    }
                } else {
                    setPageErrorForPages(meta.pages, `バッチAPIエラー: ${JSON.stringify(result.error || "内容なし")}`);
                    console.warn(`[警告] バッチ ${originalIndex} APIエラー: ${JSON.stringify(result.error || "内容なし")}`);
                }

                if (success) {
                    clearPageErrorsForPages(meta.pages);
                    for (const [pNum, pContent] of normalizedPageMap) {
                        pageMap.set(pNum, pContent);
                    }
                } else {
                    nextPendingIndices.push(originalIndex);
                }
            }

            pendingIndices = nextPendingIndices;
            retryCount++;

            // リトライ間で中間結果を保存（クラッシュ耐性）
            if (pendingIndices.length > 0 && (pageMap.size > 0 || pageErrorMap.size > 0)) {
                saveIntermediateResults();
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

    if (tmpDir && fs.existsSync(tmpDir)) {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[警告] 一時ディレクトリの削除に失敗しました: ${e.message}`);
        }
    }

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
    console.log(`[情報] Word文書(doc)の解析を開始: ${docPath} (AI: ${aiProvider}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

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
    console.log(`[情報] Word文書(docx)の解析を開始: ${docxPath} (AI: ${aiProvider}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

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
    console.log(`[情報] ODT文書の解析を開始: ${odtPath} (AI: ${aiProvider}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

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
    console.log(`[情報] PowerPoint文書の解析を開始: ${pptxPath} (AI: ${aiProvider}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

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

    console.log(`[情報] 画像のOCR処理を開始: ${imagePath} (AI: ${aiProvider}, モード: ${processMode === 'sync' ? '同期' : 'バッチ'})`);

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
    getOcrPrompt
};
