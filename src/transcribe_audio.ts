/**
 * 音声ファイルを発言者分離つき Markdown に変換します。
 *
 * 使い方:
 *   node src/transcribe_audio.js --target=general|houhi --provider=openai|gemini|reazon-k2 --mode=sync|batch --model=MODEL <音声ファイル...>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { loadConfig, getProviderConfig } = require('./lib/gemini_client');
const {
    parsePositiveInt,
    normalizeTarget,
    normalizeMode,
    readOptionalTextFile,
    compactTextParts,
    getPathKey,
} = require('./lib/shared_options');
const {
    prepareAudioForTranscription,
    mapTranscriptItemsToOriginalTime,
    summarizeSilenceTrim,
    getAudioDurationSeconds,
    parseTimestamp,
    formatTimestamp,
} = require('./lib/audio_silence');
const { resolveFfmpegTools, resolveReazonK2 } = require('./lib/tool_resolver');

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
    '.mp3',
    '.mp4',
    '.mpeg',
    '.mpga',
    '.m4a',
    '.wav',
    '.webm',
    '.aac',
    '.flac',
    '.ogg',
    '.oga',
]);

const DEFAULT_OPENAI_MODEL = 'gpt-4o-transcribe-diarize';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_REAZON_K2_MODEL = 'ja';
const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_TARGET = 'general';
const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const GEMINI_INLINE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const GEMINI_FETCH_MAX_RETRIES = 3;
const GEMINI_CHUNK_TARGET_BYTES = 16 * 1024 * 1024;
const GEMINI_CHUNK_MAX_DURATION_SEC = 10 * 60;
const GEMINI_CHUNK_MIN_DURATION_SEC = 2 * 60;
const REAZON_K2_DEFAULT_CHUNK_SEC = 25;
const REAZON_K2_MIN_CHUNK_SEC = 5;
const REAZON_K2_MAX_CHUNK_SEC = 120;
const TRANSCRIPT_NAMING_EXCERPT_CHARS = 2000;
const TRANSCRIPT_AUTO_RENAME_PATTERN = /^\d{4}-\d{2}-\d{2}_(?:音声認識|反訳書)_.+$/;

type TranscriptItem = {
    speaker: string;
    time: string;
    text: string;
};

type TranscriptionOptions = {
    provider: string;
    model?: string;
    language: string;
    target: string;
    mode: string;
    batchSize: number;
    autoRename: boolean;
    skipFormattedRename: boolean;
    contextText: string;
    postprocessAi: string;
    silenceTrim: Record<string, any>;
    reazonK2: Record<string, any>;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    openaiChatModel?: string;
    geminiApiKey?: string;
    geminiChatModel?: string;
};

function isSupportedAudioPath(filePath: string) {
    return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function parseArgs(argv: string[]) {
    const options: Record<string, string | boolean> = {};
    const files: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const readValue = (prefix: string) => {
            if (arg.startsWith(`${prefix}=`)) {
                return arg.slice(prefix.length + 1).trim();
            }
            return String(argv[++i] || '').trim();
        };

        if (arg.startsWith('--provider=')) {
            options.provider = arg.slice('--provider='.length).trim();
        } else if (arg === '--provider') {
            options.provider = readValue('--provider');
        } else if (arg.startsWith('--model=')) {
            options.model = arg.slice('--model='.length).trim();
        } else if (arg === '--model') {
            options.model = readValue('--model');
        } else if (arg.startsWith('--language=')) {
            options.language = arg.slice('--language='.length).trim();
        } else if (arg === '--language') {
            options.language = readValue('--language');
        } else if (arg.startsWith('--target=')) {
            options.target = arg.slice('--target='.length).trim();
        } else if (arg === '--target') {
            options.target = readValue('--target');
        } else if (arg.startsWith('--mode=')) {
            options.mode = arg.slice('--mode='.length).trim();
        } else if (arg === '--mode') {
            options.mode = readValue('--mode');
        } else if (arg.startsWith('--batch_size=')) {
            options.batchSize = arg.slice('--batch_size='.length).trim();
        } else if (arg === '--batch_size') {
            options.batchSize = readValue('--batch_size');
        } else if (arg.startsWith('--batch-size=')) {
            options.batchSize = arg.slice('--batch-size='.length).trim();
        } else if (arg === '--batch-size') {
            options.batchSize = readValue('--batch-size');
        } else if (arg === '--auto_rename' || arg === '--auto-rename') {
            options.autoRename = true;
        } else if (arg === '--no_auto_rename' || arg === '--no-auto-rename') {
            options.autoRename = false;
        } else if (arg === '--skip_formatted_rename' || arg === '--skip-formatted-rename') {
            options.skipFormattedRename = true;
        } else if (arg === '--no_skip_formatted_rename' || arg === '--no-skip-formatted-rename') {
            options.skipFormattedRename = false;
        } else if (arg.startsWith('--context-text=')) {
            options.contextText = arg.slice('--context-text='.length).trim();
        } else if (arg === '--context-text') {
            options.contextText = readValue('--context-text');
        } else if (arg.startsWith('--context_file=')) {
            options.contextFile = arg.slice('--context_file='.length).trim();
        } else if (arg === '--context_file') {
            options.contextFile = readValue('--context_file');
        } else if (arg.startsWith('--context-file=')) {
            options.contextFile = arg.slice('--context-file='.length).trim();
        } else if (arg === '--context-file') {
            options.contextFile = readValue('--context-file');
        } else if (arg.startsWith('--postprocess-ai=')) {
            options.postprocessAi = arg.slice('--postprocess-ai='.length).trim();
        } else if (arg === '--postprocess-ai' || arg === '--postprocess_ai') {
            options.postprocessAi = readValue(arg);
        } else if (arg.startsWith('--postprocess_ai=')) {
            options.postprocessAi = arg.slice('--postprocess_ai='.length).trim();
        } else if (arg.startsWith('--reazon-language=')) {
            options.reazonLanguage = arg.slice('--reazon-language='.length).trim();
        } else if (arg === '--reazon-language' || arg === '--reazon_language') {
            options.reazonLanguage = readValue(arg);
        } else if (arg.startsWith('--reazon_language=')) {
            options.reazonLanguage = arg.slice('--reazon_language='.length).trim();
        } else if (arg.startsWith('--reazon-device=')) {
            options.reazonDevice = arg.slice('--reazon-device='.length).trim();
        } else if (arg === '--reazon-device' || arg === '--reazon_device') {
            options.reazonDevice = readValue(arg);
        } else if (arg.startsWith('--reazon_device=')) {
            options.reazonDevice = arg.slice('--reazon_device='.length).trim();
        } else if (arg.startsWith('--reazon-precision=')) {
            options.reazonPrecision = arg.slice('--reazon-precision='.length).trim();
        } else if (arg === '--reazon-precision' || arg === '--reazon_precision') {
            options.reazonPrecision = readValue(arg);
        } else if (arg.startsWith('--reazon_precision=')) {
            options.reazonPrecision = arg.slice('--reazon_precision='.length).trim();
        } else if (arg.startsWith('--reazon-chunk-sec=')) {
            options.reazonChunkSec = arg.slice('--reazon-chunk-sec='.length).trim();
        } else if (arg === '--reazon-chunk-sec' || arg === '--reazon_chunk_sec') {
            options.reazonChunkSec = readValue(arg);
        } else if (arg.startsWith('--reazon_chunk_sec=')) {
            options.reazonChunkSec = arg.slice('--reazon_chunk_sec='.length).trim();
        } else if (arg.startsWith('--reazon-python=')) {
            options.reazonPython = arg.slice('--reazon-python='.length).trim();
        } else if (arg === '--reazon-python' || arg === '--reazon_python') {
            options.reazonPython = readValue(arg);
        } else if (arg.startsWith('--reazon_python=')) {
            options.reazonPython = arg.slice('--reazon_python='.length).trim();
        } else if (arg === '--trim_silence' || arg === '--trim-silence') {
            options.trimSilence = true;
        } else if (arg === '--no_trim_silence' || arg === '--no-trim-silence') {
            options.trimSilence = false;
        } else if (arg.startsWith('--silence_threshold_db=')) {
            options.silenceThresholdDb = arg.slice('--silence_threshold_db='.length).trim();
        } else if (arg === '--silence_threshold_db' || arg === '--silence-threshold-db') {
            options.silenceThresholdDb = readValue(arg);
        } else if (arg.startsWith('--min_silence_sec=')) {
            options.minSilenceSec = arg.slice('--min_silence_sec='.length).trim();
        } else if (arg === '--min_silence_sec' || arg === '--min-silence-sec') {
            options.minSilenceSec = readValue(arg);
        } else if (arg.startsWith('--silence_padding_sec=')) {
            options.silencePaddingSec = arg.slice('--silence_padding_sec='.length).trim();
        } else if (arg === '--silence_padding_sec' || arg === '--silence-padding-sec') {
            options.silencePaddingSec = readValue(arg);
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            files.push(arg);
        }
    }

    return { options, files };
}

function normalizeProvider(value: any) {
    const text = String(value || '').toLowerCase().trim();
    if (text === 'gemini') return 'gemini';
    if (text === 'reazon' || text === 'reazon-k2' || text === 'reazonspeech' || text === 'sherpa' || text === 'sherpa-onnx') {
        return 'reazon-k2';
    }
    return 'openai';
}

function normalizePostprocessAi(value: any) {
    const text = String(value || '').toLowerCase().trim();
    if (text === 'gemini') return 'gemini';
    if (text === 'openai') return 'openai';
    if (text === 'off' || text === 'none' || text === 'false' || text === 'no') return 'off';
    return 'auto';
}

function normalizeReazonLanguage(value: any) {
    const text = String(value || '').toLowerCase().trim();
    if (text === 'ja-en' || text === 'ja-en-mls-5k') return text;
    return 'ja';
}

function normalizeReazonDevice(value: any) {
    const text = String(value || '').toLowerCase().trim();
    if (text === 'cuda' || text === 'coreml') return text;
    return 'cpu';
}

function normalizeReazonPrecision(value: any) {
    const text = String(value || '').toLowerCase().trim();
    if (text === 'int8' || text === 'int8-fp32') return text;
    return 'fp32';
}

function normalizeContextText(cliOptions: Record<string, string | boolean>, transcription: Record<string, any>) {
    return compactTextParts(
        transcription.contextText,
        readOptionalTextFile(transcription.contextFilePath, '音声認識コンテキストファイル'),
        cliOptions.contextText,
        readOptionalTextFile(cliOptions.contextFile, '音声認識コンテキストファイル'),
    );
}

function parseNumberOption(value: any, fallback: number, min: number, max: number) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function normalizeSilenceTrimOptions(cliOptions: Record<string, string | boolean>, transcription: Record<string, any>, config: Record<string, any>) {
    const silenceTrim = transcription.silenceTrim || {};
    const ffmpeg = config.tools?.ffmpeg || {};
    const enabled = typeof cliOptions.trimSilence === 'boolean'
        ? cliOptions.trimSilence
        : silenceTrim.enabled === true;
    return {
        enabled,
        thresholdDb: parseNumberOption(cliOptions.silenceThresholdDb, Number(silenceTrim.thresholdDb ?? -35), -80, -5),
        minSilenceSec: parseNumberOption(cliOptions.minSilenceSec, Number(silenceTrim.minSilenceSec ?? 1), 0.1, 30),
        paddingSec: parseNumberOption(cliOptions.silencePaddingSec, Number(silenceTrim.paddingSec ?? 0.2), 0, 5),
        outputFormat: String(silenceTrim.outputFormat || 'm4a'),
        outputBitrate: String(silenceTrim.outputBitrate || '96k'),
        ffmpegPath: ffmpeg.ffmpegPath || 'ffmpeg',
        ffprobePath: ffmpeg.ffprobePath || '',
    };
}

function normalizeOptions(cliOptions: Record<string, string | boolean>): TranscriptionOptions {
    const config = loadConfig() || {};
    const transcription = config.transcription || {};
    const openai = getProviderConfig('openai') || {};
    const gemini = getProviderConfig('gemini') || {};
    const reazonK2Config = config.tools?.reazonK2 || {};
    const provider = normalizeProvider(cliOptions.provider || transcription.provider || DEFAULT_PROVIDER);
    const target = normalizeTarget(cliOptions.target || transcription.target || DEFAULT_TARGET);
    const language = String(cliOptions.language || transcription.language || 'ja');
    const autoRename = typeof cliOptions.autoRename === 'boolean'
        ? cliOptions.autoRename
        : transcription.autoRename === true;
    const skipFormattedRename = typeof cliOptions.skipFormattedRename === 'boolean'
        ? cliOptions.skipFormattedRename
        : transcription.skipFormattedRename === true;
    const providerModel = provider === 'gemini'
        ? gemini.transcriptionModel || DEFAULT_GEMINI_MODEL
        : provider === 'reazon-k2'
            ? transcription.reazonLanguage || reazonK2Config.language || DEFAULT_REAZON_K2_MODEL
            : openai.transcriptionModel || DEFAULT_OPENAI_MODEL;
    const reazonLanguage = normalizeReazonLanguage(cliOptions.reazonLanguage || cliOptions.model || transcription.reazonLanguage || reazonK2Config.language || providerModel);

    return {
        provider,
        model: String(cliOptions.model || providerModel || '').trim() || undefined,
        language,
        target,
        mode: normalizeMode(cliOptions.mode || transcription.mode || 'sync'),
        batchSize: parsePositiveInt(cliOptions.batchSize || transcription.batchSize, 4, 1, 20),
        autoRename,
        skipFormattedRename,
        contextText: normalizeContextText(cliOptions, transcription),
        postprocessAi: normalizePostprocessAi(cliOptions.postprocessAi || transcription.postprocessAi || 'auto'),
        silenceTrim: normalizeSilenceTrimOptions(cliOptions, transcription, config),
        reazonK2: {
            language: reazonLanguage,
            device: normalizeReazonDevice(cliOptions.reazonDevice || transcription.reazonDevice || reazonK2Config.device || 'cpu'),
            precision: normalizeReazonPrecision(cliOptions.reazonPrecision || transcription.reazonPrecision || reazonK2Config.precision || 'fp32'),
            chunkSeconds: parseNumberOption(cliOptions.reazonChunkSec || transcription.reazonChunkSec || reazonK2Config.chunkSeconds, REAZON_K2_DEFAULT_CHUNK_SEC, REAZON_K2_MIN_CHUNK_SEC, REAZON_K2_MAX_CHUNK_SEC),
            pythonPath: String(cliOptions.reazonPython || reazonK2Config.pythonPath || '').trim(),
            basePythonPath: String(reazonK2Config.basePythonPath || '').trim(),
            autoInstall: reazonK2Config.autoInstall !== false,
            cacheDir: String(reazonK2Config.cacheDir || '').trim(),
            packageSpec: String(reazonK2Config.packageSpec || '').trim(),
        },
        openaiApiKey: openai.apiKey || process.env.OPENAI_API_KEY,
        openaiBaseUrl: openai.baseUrl || 'https://api.openai.com/v1/chat/completions',
        openaiChatModel: openai.chatModel || 'gpt-4o',
        geminiApiKey: gemini.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        geminiChatModel: gemini.chatModel || process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash-preview',
    };
}

function getMimeType(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.mp4': 'audio/mp4',
        '.mpeg': 'audio/mpeg',
        '.mpga': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.wav': 'audio/wav',
        '.webm': 'audio/webm',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.ogg': 'audio/ogg',
        '.oga': 'audio/ogg',
    };
    return map[ext] || 'application/octet-stream';
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runProcess(command: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${path.basename(command)} failed (${code}): ${stderr || stdout}`));
            }
        });
    });
}

function removeFileQuietly(filePath: string) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_err) {
    }
}

function isRetryableHttpStatus(status: number) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(label: string, requestFactory: () => Promise<Response>, maxRetries = GEMINI_FETCH_MAX_RETRIES) {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await requestFactory();
            if (!isRetryableHttpStatus(response.status) || attempt >= maxRetries) {
                return response;
            }
            const body = await response.text().catch(() => '');
            console.warn(`[再試行] ${label}: HTTP ${response.status}${body ? ` / ${body.slice(0, 160)}` : ''}`);
        } catch (err: any) {
            lastError = err;
            if (attempt >= maxRetries) break;
            console.warn(`[再試行] ${label}: ${err?.message || String(err)}`);
        }
        await sleep(1500 * attempt);
    }
    throw new Error(`${label} failed after ${maxRetries} attempts: ${lastError?.message || String(lastError || 'unknown error')}`);
}

function defaultModelForProvider(provider: string) {
    if (provider === 'gemini') return DEFAULT_GEMINI_MODEL;
    if (provider === 'reazon-k2') return DEFAULT_REAZON_K2_MODEL;
    return DEFAULT_OPENAI_MODEL;
}

function selectTextAiProvider(options: TranscriptionOptions) {
    if (options.provider === 'openai') return options.openaiApiKey ? 'openai' : '';
    if (options.provider === 'gemini') return options.geminiApiKey ? 'gemini' : '';

    const preference = normalizePostprocessAi(options.postprocessAi);
    if (preference === 'off') return '';
    if (preference === 'gemini') return options.geminiApiKey ? 'gemini' : '';
    if (preference === 'openai') return options.openaiApiKey ? 'openai' : '';
    if (options.geminiApiKey) return 'gemini';
    if (options.openaiApiKey) return 'openai';
    return '';
}

async function requestTextAiJson(prompt: string, options: TranscriptionOptions, label: string, preferredProvider = '') {
    const provider = preferredProvider || selectTextAiProvider(options);
    if (provider === 'openai') {
        const response = await fetchWithRetry(`OpenAI ${label}`, () => fetch(options.openaiBaseUrl || 'https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.openaiApiKey}`,
            },
            body: JSON.stringify({
                model: options.openaiChatModel || 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                response_format: { type: 'json_object' },
            }),
        }));
        const body = await response.text();
        if (!response.ok) throw new Error(`OpenAI ${label} failed: ${response.status} ${body}`);
        const json = JSON.parse(body);
        return json?.choices?.[0]?.message?.content || '';
    }

    if (provider === 'gemini') {
        const model = options.geminiChatModel || 'gemini-2.5-flash-preview';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.geminiApiKey || '')}`;
        const response = await fetchWithRetry(`Gemini ${label}`, () => fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                },
            }),
        }));
        const body = await response.text();
        if (!response.ok) throw new Error(`Gemini ${label} failed: ${response.status} ${body}`);
        const json = JSON.parse(body);
        return json?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || '';
    }

    return '';
}

async function getFfmpegPathForTranscription(options: TranscriptionOptions) {
    const { ffmpegPath } = await resolveFfmpegTools(options.silenceTrim || {});
    return ffmpegPath;
}

function getChunkOutputBitrate(options: TranscriptionOptions) {
    return String(options.silenceTrim?.outputBitrate || '96k');
}

function chooseGeminiChunkDuration(durationSec: number, fileSize: number) {
    const sizeBased = fileSize > 0
        ? Math.floor(durationSec * (GEMINI_CHUNK_TARGET_BYTES / fileSize))
        : GEMINI_CHUNK_MAX_DURATION_SEC;
    return Math.max(
        GEMINI_CHUNK_MIN_DURATION_SEC,
        Math.min(GEMINI_CHUNK_MAX_DURATION_SEC, sizeBased || GEMINI_CHUNK_MAX_DURATION_SEC),
    );
}

async function createGeminiAudioChunks(filePath: string, options: TranscriptionOptions) {
    const fileSize = fs.statSync(filePath).size;
    if (fileSize <= GEMINI_INLINE_MAX_AUDIO_BYTES) {
        return { chunks: [{ audioPath: filePath, startSec: 0, durationSec: 0, bytes: fileSize, temporary: false }], cleanup: () => {} };
    }

    const durationSec = await getAudioDurationSeconds(filePath, options.silenceTrim);
    if (!durationSec || durationSec <= 0) {
        return { chunks: [{ audioPath: filePath, startSec: 0, durationSec: 0, bytes: fileSize, temporary: false }], cleanup: () => {} };
    }

    const ffmpeg = await getFfmpegPathForTranscription(options);
    const outputBitrate = getChunkOutputBitrate(options);
    const chunkDurationSec = chooseGeminiChunkDuration(durationSec, fileSize);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-audio-chunks-'));
    const chunks = [];

    try {
        for (let startSec = 0, index = 1; startSec < durationSec - 0.05; startSec += chunkDurationSec, index++) {
            const duration = Math.min(chunkDurationSec, durationSec - startSec);
            const chunkPath = path.join(tempDir, `chunk-${String(index).padStart(3, '0')}.m4a`);
            await runProcess(ffmpeg, [
                '-y',
                '-hide_banner',
                '-nostdin',
                '-ss', startSec.toFixed(3),
                '-t', duration.toFixed(3),
                '-i', filePath,
                '-vn',
                '-c:a', 'aac',
                '-b:a', outputBitrate,
                '-movflags', '+faststart',
                chunkPath,
            ]);
            chunks.push({
                audioPath: chunkPath,
                startSec,
                durationSec: duration,
                bytes: fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0,
                temporary: true,
            });
        }
    } catch (err) {
        for (const chunk of chunks) removeFileQuietly(chunk.audioPath);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_cleanupError) {}
        throw err;
    }

    return {
        chunks,
        cleanup: () => {
            for (const chunk of chunks) {
                if (chunk.temporary) removeFileQuietly(chunk.audioPath);
            }
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_err) {}
        },
    };
}

async function createReazonAudioChunks(filePath: string, options: TranscriptionOptions) {
    const durationSec = await getAudioDurationSeconds(filePath, options.silenceTrim);
    const chunkSeconds = parseNumberOption(options.reazonK2?.chunkSeconds, REAZON_K2_DEFAULT_CHUNK_SEC, REAZON_K2_MIN_CHUNK_SEC, REAZON_K2_MAX_CHUNK_SEC);
    const ffmpeg = await getFfmpegPathForTranscription(options);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ocr-reazon-k2-'));
    const chunks: any[] = [];

    const ranges: { startSec: number; durationSec: number }[] = [];
    if (durationSec && durationSec > 0) {
        for (let startSec = 0; startSec < durationSec - 0.05; startSec += chunkSeconds) {
            ranges.push({ startSec, durationSec: Math.min(chunkSeconds, durationSec - startSec) });
        }
    } else {
        ranges.push({ startSec: 0, durationSec: 0 });
    }

    try {
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            const chunkPath = path.join(tempDir, `reazon-${String(i + 1).padStart(4, '0')}.wav`);
            const args = [
                '-y',
                '-hide_banner',
                '-nostdin',
                '-ss', range.startSec.toFixed(3),
            ];
            if (range.durationSec > 0) {
                args.push('-t', range.durationSec.toFixed(3));
            }
            args.push(
                '-i', filePath,
                '-vn',
                '-ac', '1',
                '-ar', '16000',
                '-c:a', 'pcm_s16le',
                chunkPath,
            );
            await runProcess(ffmpeg, args);
            chunks.push({
                audioPath: chunkPath,
                startSec: range.startSec,
                durationSec: range.durationSec,
                bytes: fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0,
                temporary: true,
            });
        }
    } catch (err) {
        for (const chunk of chunks) removeFileQuietly(chunk.audioPath);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_cleanupError) {}
        throw err;
    }

    return {
        chunks,
        cleanup: () => {
            for (const chunk of chunks) removeFileQuietly(chunk.audioPath);
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_err) {}
        },
    };
}

const REAZON_K2_RUNNER = String.raw`
import argparse
import json
import sys
import warnings

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from reazonspeech.k2.asr import load_model, transcribe, audio_from_path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--precision", default="fp32")
    parser.add_argument("--language", default="ja")
    parser.add_argument("audio", nargs="+")
    args = parser.parse_args()

    model = load_model(device=args.device, precision=args.precision, language=args.language)
    chunks = []
    for audio_path in args.audio:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            audio = audio_from_path(audio_path)
            result = transcribe(model, audio)
        chunks.append({
            "path": audio_path,
            "text": result.text,
            "subwords": [
                {"time": float(item.seconds), "token": item.token}
                for item in getattr(result, "subwords", [])
            ],
            "warnings": [str(item.message) for item in caught],
        })

    print(json.dumps({"chunks": chunks}, ensure_ascii=True))

if __name__ == "__main__":
    main()
`;

function writeTempReazonRunner() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-reazon-runner-'));
    const scriptPath = path.join(dir, 'run_reazon_k2.py');
    fs.writeFileSync(scriptPath, REAZON_K2_RUNNER, 'utf-8');
    return {
        scriptPath,
        cleanup: () => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) {}
        },
    };
}

function runProcessWithEnv(command: string, args: string[], env: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${path.basename(command)} failed (${code}): ${stderr || stdout}`));
            }
        });
    });
}

function parseReazonK2RunnerOutput(stdout: any) {
    const text = String(stdout || '').trim();
    const parsed = extractJson(text);
    if (parsed !== null) return parsed;
    try {
        return JSON.parse(text);
    } catch (err: any) {
        throw new Error(`Reazon K2 のJSON出力を解析できませんでした。Pythonの標準出力にJSON以外のログが混ざったか、文字エンコーディングが壊れています: ${err?.message || String(err)}`);
    }
}

async function runReazonK2(chunks: any[], options: TranscriptionOptions) {
    const resolved = await resolveReazonK2(options.reazonK2 || {});
    const runner = writeTempReazonRunner();
    const env = {
        ...process.env,
        HF_HOME: process.env.HF_HOME || resolved.cacheDir,
        HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE || path.join(resolved.cacheDir, 'hub'),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
    };
    try {
        const args = [
            runner.scriptPath,
            '--device', options.reazonK2?.device || 'cpu',
            '--precision', options.reazonK2?.precision || 'fp32',
            '--language', options.reazonK2?.language || DEFAULT_REAZON_K2_MODEL,
            ...chunks.map(chunk => chunk.audioPath),
        ];
        const result = await runProcessWithEnv(resolved.pythonPath, args, env as Record<string, string>);
        if (String(result.stderr || '').trim()) {
            console.warn(`[Reazon K2] ${String(result.stderr).trim()}`);
        }
        const parsed = parseReazonK2RunnerOutput(result.stdout);
        return Array.isArray(parsed?.chunks) ? parsed.chunks : [];
    } finally {
        runner.cleanup();
    }
}

function buildReazonRawItems(chunks: any[], results: any[]): TranscriptItem[] {
    return chunks.map((chunk, index) => {
        const result = results[index] || {};
        const text = String(result.text || '').trim();
        if (Array.isArray(result.warnings)) {
            result.warnings.filter(Boolean).forEach((message: string) => console.warn(`[Reazon K2] ${message}`));
        }
        return {
            speaker: '話者1',
            time: formatTimestamp(chunk.startSec || 0, (chunk.startSec || 0) >= 3600),
            text: text || '【文字起こし結果が空です】',
        };
    }).filter(item => item.text && item.text !== '【文字起こし結果が空です】');
}

function offsetTranscriptItems(items: TranscriptItem[] = [], offsetSec = 0) {
    if (!offsetSec) return items;
    return items.map(item => {
        const parsed = parseTimestamp(item.time);
        if (parsed === null) return item;
        const preferHours = String(item.time || '').split(':').length >= 3 || offsetSec + parsed >= 3600;
        return {
            ...item,
            time: formatTimestamp(parsed + offsetSec, preferHours),
        };
    });
}

function mergeOverview(base: Record<string, string> = {}, next: Record<string, string> = {}) {
    const merged = { ...base };
    for (const key of ['date', 'place', 'people', 'title', 'subject']) {
        if (!merged[key] && next?.[key]) merged[key] = next[key];
    }
    return merged;
}

function summarizeAudioChunking(preprocess: Record<string, any>) {
    const chunks = preprocess?.geminiChunks;
    if (Array.isArray(chunks) && chunks.length > 0) {
        return {
            applied: true,
            engine: 'gemini',
            count: chunks.length,
            targetBytes: GEMINI_CHUNK_TARGET_BYTES,
            maxDurationSec: GEMINI_CHUNK_MAX_DURATION_SEC,
            chunks: chunks.map((chunk: any) => ({
                startSec: Number(chunk.startSec.toFixed(3)),
                durationSec: Number(chunk.durationSec.toFixed(3)),
                bytes: chunk.bytes,
            })),
        };
    }

    const reazonChunks = preprocess?.reazonK2Chunks;
    if (Array.isArray(reazonChunks) && reazonChunks.length > 0) {
        return {
            applied: true,
            engine: 'reazon-k2',
            count: reazonChunks.length,
            chunks: reazonChunks.map((chunk: any) => ({
                startSec: Number(chunk.startSec.toFixed(3)),
                durationSec: Number(chunk.durationSec.toFixed(3)),
                bytes: chunk.bytes,
            })),
        };
    }

    return { applied: false };
}

function pad2(value: number) {
    return String(value).padStart(2, '0');
}

function formatDate(date: Date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isValidDateParts(year: number, month: number, day: number) {
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function getFileDate(filePath: string) {
    try {
        return formatDate(fs.statSync(filePath).mtime);
    } catch (_err) {
        return formatDate(new Date());
    }
}

function resolveConfiguredFfprobePath() {
    const config = loadConfig() || {};
    const ffmpeg = config.tools?.ffmpeg || {};
    if (ffmpeg.ffprobePath) return ffmpeg.ffprobePath;
    if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
    const ffmpegPath = ffmpeg.ffmpegPath || process.env.FFMPEG_PATH || '';
    if (ffmpegPath && /ffmpeg(?:\.exe)?$/i.test(ffmpegPath)) {
        const candidate = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'ffprobe';
}

function normalizeMetadataDateForFilename(value: any) {
    const text = String(value || '').trim();
    if (!text) return '';

    const dateLike = text.match(/(\d{4})[-/:年](\d{1,2})[-/:月](\d{1,2})/);
    if (dateLike) {
        const year = Number(dateLike[1]);
        const month = Number(dateLike[2]);
        const day = Number(dateLike[3]);
        if (isValidDateParts(year, month, day)) {
            return `${dateLike[1]}-${pad2(month)}-${pad2(day)}`;
        }
    }

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
        return formatDate(parsed);
    }
    return '';
}

function normalizeMetadataKey(key: string) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function collectMetadataTags(ffprobeJson: any) {
    const tagSets = [
        ffprobeJson?.format?.tags,
        ...(Array.isArray(ffprobeJson?.streams) ? ffprobeJson.streams.map((stream: any) => stream?.tags) : []),
    ];
    const tags: Record<string, any[]> = {};
    for (const tagSet of tagSets) {
        if (!tagSet || typeof tagSet !== 'object') continue;
        for (const [key, value] of Object.entries(tagSet)) {
            const normalized = normalizeMetadataKey(key);
            if (!normalized) continue;
            if (!tags[normalized]) tags[normalized] = [];
            tags[normalized].push(value);
        }
    }
    return tags;
}

function getAudioMetadataDate(filePath: string) {
    try {
        const result = spawnSync(resolveConfiguredFfprobePath(), [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath,
        ], { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        if (result.status !== 0 || !result.stdout) return '';

        const tags = collectMetadataTags(JSON.parse(result.stdout));
        const priorityKeys = [
            'com_apple_quicktime_creationdate',
            'creation_time',
            'media_create_date',
            'media_created',
            'media_creation_time',
            'date',
            'encoded_date',
            'tagged_date',
        ];
        for (const key of priorityKeys) {
            for (const value of tags[key] || []) {
                const date = normalizeMetadataDateForFilename(value);
                if (date) return date;
            }
        }
    } catch (_err) {
    }
    return '';
}

function basenameWithoutExt(filePath: string) {
    return path.basename(filePath, path.extname(filePath));
}

function isTranscriptAutoRenameFormatted(filePath: string) {
    return TRANSCRIPT_AUTO_RENAME_PATTERN.test(basenameWithoutExt(filePath));
}

function normalizeJapaneseDateForFilename(value: any) {
    const text = String(value || '').trim();
    const iso = text.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
    if (iso) {
        return `${iso[1]}-${pad2(Number(iso[2]))}-${pad2(Number(iso[3]))}`;
    }

    const era = text.match(/(令和|平成|昭和)(元|\d{1,2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    if (!era) return '';

    const eraYear = era[2] === '元' ? 1 : Number(era[2]);
    const base = era[1] === '令和' ? 2018 : era[1] === '平成' ? 1988 : 1925;
    return `${base + eraYear}-${pad2(Number(era[3]))}-${pad2(Number(era[4]))}`;
}

function sanitizeFilenamePart(value: string, maxLength = 40) {
    let text = String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.。・,，、]+|[\s.。・,，、]+$/g, '')
        .trim();

    if (text.length > maxLength) {
        text = text.slice(0, maxLength).replace(/[、，。,.・\s]+$/g, '').trim();
    }
    return text || '録音内容';
}

function removeGreetingPrefix(text: string) {
    return text
        .replace(/^(はい、?|ええ、?|あの、?|えっと、?|えーと、?|えー、?|その、?|まあ、?|お世話になります。?|ありがとうございます。?|失礼します。?)+/g, '')
        .trim();
}

function isUsefulTranscriptTitle(value: string) {
    const text = String(value || '').trim();
    if (!text || text === '録音内容') return false;
    if (/話者\d/.test(text)) return false;
    const normalized = text
        .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\s+/g, ' ')
        .trim();
    return !/^\d{1,2}(?:[:： ]\d{2}){1,2}$/.test(normalized);
}

function normalizeTitleSupportText(value: string) {
    return String(value || '')
        .replace(/[「」『』【】\[\]（）()、，,。.!！?？:：\s]/g, '')
        .toLowerCase();
}

function isTitleSupportedByTranscript(title: string, items: TranscriptItem[]) {
    return isTitleSupportedByText(title, items.map(item => item.text).join(' ').slice(0, 8000));
}

function isTitleSupportedByText(title: string, text: string) {
    const normalizedTitle = normalizeTitleSupportText(title);
    if (normalizedTitle.length < 8) return true;

    const transcriptText = normalizeTitleSupportText(text);
    if (!transcriptText) return false;
    if (transcriptText.includes(normalizedTitle)) return true;

    const titleTerms = String(title || '')
        .replace(/[「」『』【】\[\]（）()]/g, ' ')
        .split(/[、，,。.!！?？:：\sとやのにへをがはで]+/)
        .map(term => normalizeTitleSupportText(term))
        .filter(term => term.length >= 3);
    if (titleTerms.length > 0) {
        const supportedCount = titleTerms.filter(term => transcriptText.includes(term)).length;
        if (supportedCount >= Math.min(2, titleTerms.length)) return true;
    }

    let supportedFragments = 0;
    for (let i = 0; i <= normalizedTitle.length - 4; i += 4) {
        if (transcriptText.includes(normalizedTitle.slice(i, i + 4))) supportedFragments++;
    }
    return supportedFragments >= 2;
}

function markdownExcerptForNaming(markdownText: string) {
    return String(markdownText || '')
        .replace(/<!-- mimi-ocr-transcription-settings[\s\S]*?-->\s*$/m, '')
        .slice(0, TRANSCRIPT_NAMING_EXCERPT_CHARS);
}

function extractNamingTextFromMarkdown(markdownText: string) {
    const excerpt = markdownExcerptForNaming(markdownText);
    const parts = [];
    for (const rawLine of excerpt.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || /^日時[:：]/.test(line) || /^場所[:：]/.test(line) || /^登場人物[:：]/.test(line)) continue;
        if (/^-\s*(日時|日付|音声ファイル|話者)[:：]/.test(line)) continue;
        if (/^\|\s*:?-{2,}/.test(line) || /発言者.*発言内容/.test(line)) continue;
        if (line.startsWith('|') && line.endsWith('|')) {
            const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
            if (cells.length >= 4) {
                parts.push(cells.slice(3).join(' '));
                continue;
            }
        }
        if (!/音声ファイル[:：]|話者[:：]/.test(line)) parts.push(line);
    }
    return parts.join(' ');
}

function cleanTitleCandidate(value: string) {
    return removeGreetingPrefix(String(value || '')
        .replace(/\[[^\]]+\]\([^)]*\)/g, '')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}

function compactUtteranceTitle(value: string) {
    let text = cleanTitleCandidate(value)
        .replace(/^(今日は|本日は|今回[はの]?|まず|それでは|じゃあ|では)[、，\s]*/g, '')
        .replace(/(について|に関する|をめぐる)(?:確認|相談|説明|打合せ|協議|検討|報告)(?:します|しました|です)?[。.!！?？]*$/g, '$1$2')
        .replace(/(?:を|について|に関して)(?:確認|相談|説明|打合せ|協議|検討|報告)(?:します|しました|する|した)?[。.!！?？]*$/g, '$1$2')
        .replace(/[。.!！?？]+$/g, '')
        .replace(/(?:です|ます|ました|でした|だろうって)$/g, '')
        .replace(/[、，\s]*(?:は|が|を|に|で)$/g, '')
        .trim();
    if (!text) text = cleanTitleCandidate(value);
    return text;
}

function splitTitleCandidates(text: string) {
    return String(text || '')
        .split(/(?<=[。！？!?])|[\r\n]+/)
        .map(compactUtteranceTitle)
        .filter(Boolean);
}

function scoreTitleCandidate(candidate: string, index: number) {
    const text = cleanTitleCandidate(candidate);
    if (!isUsefulTranscriptTitle(text)) return -1;
    if (text.length < 8) return -1;
    if (/^(はい|ええ|あの|えっと|えー|まあ|そうですね)[、。,\s]/.test(text)) return -1;
    if (/^(分かりました|わかりました|了解です|お願いします|ありがとうございます|お疲れ様です)/.test(text) && text.length < 18) return -1;
    const lengthScore = Math.min(text.length, 44);
    const punctuationBonus = /[。！？!?]$/.test(text) ? 4 : 0;
    const contentBonus = /について|確認|説明|相談|協議|打合せ|契約|裁判|期日|資料|予定|申請|主張|証拠/.test(text) ? 10 : 0;
    return lengthScore + punctuationBonus + contentBonus - index * 0.25;
}

function inferTranscriptTitleFromMarkdown(markdownText: string) {
    const namingText = extractNamingTextFromMarkdown(markdownText);
    const candidates = splitTitleCandidates(namingText);
    let best = '';
    let bestScore = -1;
    candidates.slice(0, 40).forEach((candidate, index) => {
        const score = scoreTitleCandidate(candidate, index);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    });
    return best ? sanitizeFilenamePart(best, 36) : '';
}

function buildTranscriptNamingPrompt(markdownText: string, target = DEFAULT_TARGET) {
    const excerpt = markdownExcerptForNaming(markdownText);
    const documentKind = normalizeTarget(target) === 'houhi' ? '反訳書' : '音声認識';
    return [
        '# ROLE',
        '日本語の音声認識Markdownを読み、ファイル名用の短いタイトルを決めるアシスタントです。',
        '',
        '# TASK',
        `次の${documentKind}Markdown冒頭を読み、会話内容全体にふさわしいファイル名用タイトルを1つ作ってください。`,
        '',
        '# RULES',
        '- 出力はJSONのみです。説明やコードブロックは禁止です。',
        '- title は12〜32文字程度の日本語の名詞句にしてください。',
        '- 発言の一文や途中フレーズをそのまま抜き出さず、会話の主題を要約してください。',
        '- 文末が「です」「ます」「した」「どうするんだろうって」「は」「が」「を」「に」「で」などで終わる文章断片にしないでください。',
        '- 例: 「先の工程で、Cオリゴに分けることができなかった場合」ではなく「Cオリゴ分割工程の確認」。',
        '- 例: 「ライブであったり、アニメーションであったり」ではなく「政治活動ブログの表現方針」。',
        '- 日付、時刻、話者名だけ、音声認識、反訳書、録音内容、ファイル名は title に入れないでください。',
        '- 冒頭の案内、着席、携帯電話、挨拶、相槌などが主題でない場合はタイトルにしないでください。',
        '- Markdownに実際に書かれている内容だけを根拠にしてください。外部知識や想像で動画名・作品名・事件名を作らないでください。',
        '- 固有名詞、対象物、作業名、論点が分かる場合は、それらを組み合わせて短い表題にしてください。',
        '- 複数の話題がある場合は、冒頭2000文字内で最も具体的で中心的な話題を選んでください。',
        '',
        '# OUTPUT',
        '{"title":"タイトル"}',
        '',
        '--- MARKDOWN START ---',
        excerpt,
        '--- MARKDOWN END ---',
    ].join('\n');
}

function parseTranscriptNamingTitle(text: string, markdownText: string) {
    const parsed = extractJson(text) || (() => {
        try { return JSON.parse(String(text || '').trim()); } catch (_err) { return null; }
    })();
    const rawTitle = parsed?.title || parsed?.name || parsed?.subject || text;
    const title = sanitizeFilenamePart(String(rawTitle || '').replace(/^タイトル[:：]\s*/, ''), 36);
    const supportText = extractNamingTextFromMarkdown(markdownText);
    if (!isUsefulTranscriptTitle(title) || !isTitleSupportedByText(title, supportText) || /(?:です|ます|ました|でした|だろうって|[はがをにで、，])$/.test(title)) {
        return '';
    }
    return title;
}

async function inferTranscriptTitleWithAi(markdownText: string, options: TranscriptionOptions) {
    const prompt = buildTranscriptNamingPrompt(markdownText, options.target);
    try {
        const provider = selectTextAiProvider(options);
        if (provider) {
            const content = await requestTextAiJson(prompt, options, 'transcript naming request', provider);
            return parseTranscriptNamingTitle(content, markdownText);
        }
    } catch (err: any) {
        console.warn(`[自動改名] AIタイトル判定に失敗したため本文から推定します: ${err?.message || String(err)}`);
    }
    return '';
}

function inferTranscriptTitle(items: TranscriptItem[], overview: Record<string, string> = {}, markdownText = '') {
    const explicit = sanitizeFilenamePart(String(overview.title || overview.subject || '').trim(), 36);
    if (isUsefulTranscriptTitle(explicit) && isTitleSupportedByTranscript(explicit, items)) return explicit;

    const markdownTitle = inferTranscriptTitleFromMarkdown(markdownText);
    if (markdownTitle) return markdownTitle;

    const candidate = items
        .map(item => removeGreetingPrefix(item.text))
        .find(text => text.length >= 8) || items.map(item => item.text).find(Boolean) || '';

    return sanitizeFilenamePart(candidate, 36);
}

function buildTranscriptBaseName(filePath: string, items: TranscriptItem[] = [], overview: Record<string, string> = {}, target = DEFAULT_TARGET, markdownText = '') {
    const date = getAudioMetadataDate(filePath) || normalizeJapaneseDateForFilename(overview.date) || getFileDate(filePath);
    const title = inferTranscriptTitle(items, overview, markdownText);
    const documentKind = normalizeTarget(target) === 'houhi' ? '反訳書' : '音声認識';
    return sanitizeFilenamePart(`${date}_${documentKind}_${title}`, 90);
}

function resolveUniqueOutputPath(outputPath: string) {
    if (!fs.existsSync(outputPath)) return outputPath;

    const ext = path.extname(outputPath);
    const stem = path.basename(outputPath, ext);
    const dir = path.dirname(outputPath);

    for (let i = 2; i < Number.MAX_SAFE_INTEGER; i++) {
        const candidate = path.join(dir, `${stem} (${i})${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`空いている出力ファイル名が見つかりません: ${outputPath}`);
}

function resolveUniqueTranscriptPair(filePath: string, baseName: string) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const originalAudioKey = getPathKey(filePath);

    for (let i = 1; i < Number.MAX_SAFE_INTEGER; i++) {
        const suffix = i === 1 ? '' : ` (${i})`;
        const candidateBase = `${baseName}${suffix}`;
        const audioPath = path.join(dir, `${candidateBase}${ext}`);
        const markdownPath = path.join(dir, `${candidateBase}.md`);
        const audioAvailable = getPathKey(audioPath) === originalAudioKey || !fs.existsSync(audioPath);
        const markdownAvailable = !fs.existsSync(markdownPath);

        if (audioAvailable && markdownAvailable) {
            return { audioPath, markdownPath, baseName: candidateBase };
        }
    }

    throw new Error(`空いている音声・Markdownファイル名が見つかりません: ${baseName}`);
}

function resolveUniqueExistingTranscriptPair(filePath: string, markdownPath: string, baseName: string) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const originalAudioKey = getPathKey(filePath);
    const originalMarkdownKey = getPathKey(markdownPath);

    for (let i = 1; i < Number.MAX_SAFE_INTEGER; i++) {
        const suffix = i === 1 ? '' : ` (${i})`;
        const candidateBase = `${baseName}${suffix}`;
        const audioPath = path.join(dir, `${candidateBase}${ext}`);
        const newMarkdownPath = path.join(dir, `${candidateBase}.md`);
        const audioAvailable = getPathKey(audioPath) === originalAudioKey || !fs.existsSync(audioPath);
        const markdownAvailable = getPathKey(newMarkdownPath) === originalMarkdownKey || !fs.existsSync(newMarkdownPath);

        if (audioAvailable && markdownAvailable) {
            return { audioPath, markdownPath: newMarkdownPath, baseName: candidateBase };
        }
    }

    throw new Error(`空いている音声・Markdownファイル名が見つかりません: ${baseName}`);
}

function buildOriginalTranscriptBaseName(filePath: string, target = DEFAULT_TARGET) {
    const suffix = normalizeTarget(target) === 'houhi' ? '反訳書' : '音声認識';
    return sanitizeFilenamePart(`${basenameWithoutExt(filePath)}_${suffix}`, 90);
}

function expectedOriginalTranscriptPath(filePath: string, target = DEFAULT_TARGET) {
    return path.join(path.dirname(filePath), `${buildOriginalTranscriptBaseName(filePath, target)}.md`);
}

function findExistingTranscriptMarkdown(filePath: string, target = DEFAULT_TARGET) {
    const candidates = [
        path.join(path.dirname(filePath), `${basenameWithoutExt(filePath)}.md`),
        expectedOriginalTranscriptPath(filePath, target),
    ];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = getPathKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function outputPathForAudio(filePath: string, items: TranscriptItem[] = [], overview: Record<string, string> = {}, target = DEFAULT_TARGET, autoRename = true, markdownText = '') {
    const baseName = autoRename
        ? buildTranscriptBaseName(filePath, items, overview, target, markdownText)
        : buildOriginalTranscriptBaseName(filePath, target);
    if (!autoRename) {
        return resolveUniqueOutputPath(path.join(path.dirname(filePath), `${baseName}.md`));
    }
    return resolveUniqueTranscriptPair(filePath, baseName).markdownPath;
}

function buildTranscriptOutputPlan(filePath: string, items: TranscriptItem[] = [], overview: Record<string, string> = {}, target = DEFAULT_TARGET, autoRename = true, markdownText = '') {
    const baseName = autoRename
        ? buildTranscriptBaseName(filePath, items, overview, target, markdownText)
        : buildOriginalTranscriptBaseName(filePath, target);

    if (!autoRename) {
        return {
            audioPath: filePath,
            markdownPath: resolveUniqueOutputPath(path.join(path.dirname(filePath), `${baseName}.md`)),
            audioRenamed: false,
        };
    }

    const pair = resolveUniqueTranscriptPair(filePath, baseName);
    return {
        audioPath: pair.audioPath,
        markdownPath: pair.markdownPath,
        audioRenamed: getPathKey(pair.audioPath) !== getPathKey(filePath),
    };
}

function renameAudioFileForTranscript(filePath: string, targetAudioPath: string) {
    if (getPathKey(filePath) === getPathKey(targetAudioPath)) {
        return filePath;
    }
    fs.renameSync(filePath, targetAudioPath);
    console.log(`[自動改名] 音声: ${path.basename(filePath)} -> ${path.basename(targetAudioPath)}`);
    return targetAudioPath;
}

function renameMarkdownFileForTranscript(markdownPath: string, targetMarkdownPath: string) {
    if (getPathKey(markdownPath) === getPathKey(targetMarkdownPath)) {
        return markdownPath;
    }
    fs.renameSync(markdownPath, targetMarkdownPath);
    console.log(`[自動改名] Markdown: ${path.basename(markdownPath)} -> ${path.basename(targetMarkdownPath)}`);
    return targetMarkdownPath;
}

async function autoRenameExistingTranscript(filePath: string, markdownPath: string, target = DEFAULT_TARGET, options: TranscriptionOptions | null = null) {
    const markdown = fs.readFileSync(markdownPath, 'utf-8');
    const parsed = parseTranscriptMarkdown(markdown);
    const overview = { ...parsed.overview };
    if (options) {
        const aiTitle = await inferTranscriptTitleWithAi(markdown, options);
        if (aiTitle) {
            overview.title = aiTitle;
            overview.subject = aiTitle;
        }
    }
    const baseName = buildTranscriptBaseName(filePath, parsed.items, overview, target, markdown);
    const plan = resolveUniqueExistingTranscriptPair(filePath, markdownPath, baseName);

    const audioSame = getPathKey(filePath) === getPathKey(plan.audioPath);
    const markdownSame = getPathKey(markdownPath) === getPathKey(plan.markdownPath);
    if (audioSame && markdownSame) {
        console.log(`[自動改名] 既に形式通りのため変更しません: ${path.basename(filePath)}`);
        return { audioPath: filePath, markdownPath };
    }

    let currentAudioPath = filePath;
    let audioWasRenamed = false;
    try {
        currentAudioPath = renameAudioFileForTranscript(filePath, plan.audioPath);
        audioWasRenamed = getPathKey(currentAudioPath) !== getPathKey(filePath);
        renameMarkdownFileForTranscript(markdownPath, plan.markdownPath);
        return { audioPath: currentAudioPath, markdownPath: plan.markdownPath };
    } catch (err) {
        if (audioWasRenamed && fs.existsSync(currentAudioPath) && !fs.existsSync(filePath)) {
            try {
                fs.renameSync(currentAudioPath, filePath);
                console.warn(`[自動改名] Markdown改名失敗のため音声ファイル名を戻しました: ${path.basename(filePath)}`);
            } catch (_rollbackError) {
            }
        }
        throw err;
    }
}

function sanitizeMarkdownCell(value: string) {
    return String(value || '')
        .replace(/\r?\n+/g, ' ')
        .replace(/\|/g, '｜')
        .trim();
}

function secondsToTimestamp(value: any) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return '';

    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeSpeaker(value: any, fallback = '不明') {
    const text = String(value || '').trim();
    if (!text) return fallback;
    if (/^[A-Z]$/i.test(text)) return `話者${text.toUpperCase()}`;
    return text
        .replace(/^speaker[_\s-]*/i, '話者')
        .replace(/^話者\s*(\d+)$/i, '話者$1');
}

function stripCodeFence(text: string) {
    const trimmed = String(text || '').trim();
    const fenced = trimmed.match(/^```(?:json|markdown|md)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function extractJson(text: string) {
    const cleaned = stripCodeFence(text);
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch (_err) {
        return null;
    }
}

function normalizeTranscriptItems(raw: any): TranscriptItem[] {
    const source = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.items)
            ? raw.items
            : Array.isArray(raw?.segments)
                ? raw.segments
                : Array.isArray(raw?.transcript)
                    ? raw.transcript
                    : [];

    return source
        .map((item: any, index: number) => {
            const text = String(item?.text || item?.content || item?.utterance || '').trim();
            if (!text) return null;
            return {
                speaker: normalizeSpeaker(item?.speaker || item?.speaker_label || item?.speakerLabel || item?.role, `話者${index + 1}`),
                time: String(item?.time || item?.timestamp || secondsToTimestamp(item?.start || item?.start_time || item?.startTime) || '').trim(),
                text,
            };
        })
        .filter(Boolean) as TranscriptItem[];
}

function parsePlainTranscript(text: string): TranscriptItem[] {
    const cleaned = stripCodeFence(text);
    const lines = cleaned
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const parsed: TranscriptItem[] = [];
    for (const line of lines) {
        const match = line.match(/^(?:\[(?<time1>\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?<speaker>[^:：]{1,24})[:：]\s*(?<text>.+)$/);
        if (match?.groups?.text) {
            parsed.push({
                speaker: normalizeSpeaker(match.groups.speaker, '不明'),
                time: match.groups.time1 || '',
                text: match.groups.text.trim(),
            });
        }
    }

    if (parsed.length > 0) return parsed;

    return cleaned
        .split(/\n{2,}/)
        .map(part => part.trim())
        .filter(Boolean)
        .map((part, index) => ({
            speaker: index % 2 === 0 ? '話者1' : '話者2',
            time: '',
            text: part.replace(/\s+/g, ' '),
        }));
}

function parseTranscriptResponse(text: string): TranscriptItem[] {
    const json = extractJson(text);
    const jsonItems = normalizeTranscriptItems(json);
    if (jsonItems.length > 0) return jsonItems;
    return parsePlainTranscript(text);
}

function parseTranscriptMarkdown(markdown: string) {
    const text = String(markdown || '');
    const overview: Record<string, string> = {};
    const dateMatch = text.match(/(?:^|\n)(?:日時|日付)[:：]\s*([^\n]+)/) || text.match(/(?:^|\n)\s*-\s*日時[:：]\s*([^\n]+)/);
    const peopleMatch = text.match(/(?:^|\n)(?:登場人物|話者)[:：]\s*([^\n]+)/) || text.match(/(?:^|\n)\s*-\s*話者[:：]\s*([^\n]+)/);
    const titleMatch = text.match(/^#\s+(.+)$/m);
    if (dateMatch) overview.date = dateMatch[1].trim();
    if (peopleMatch) overview.people = peopleMatch[1].trim();
    if (titleMatch && !/^(反訳書|音声認識結果)$/.test(titleMatch[1].trim())) {
        overview.title = titleMatch[1].trim();
    }

    const items: TranscriptItem[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
        if (/^\|\s*:?-{2,}/.test(trimmed) || /発言者.*発言内容/.test(trimmed)) continue;

        const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
        if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
        const speaker = cells[1] || '不明';
        const time = cells[2] || '';
        const itemText = cells.slice(3).join(' ').trim();
        if (!itemText) continue;
        items.push({ speaker, time, text: itemText });
    }

    if (items.length === 0) {
        return { overview, items: parsePlainTranscript(text) };
    }
    return { overview, items };
}

function getTemplateInstruction() {
    const candidates = [
        path.resolve(process.cwd(), '..', 'houhi', 'houhi-drafting-kit', '反訳書.md'),
        path.resolve(process.cwd(), 'houhi-drafting-kit', '反訳書.md'),
        path.resolve(__dirname, '..', '..', 'houhi-drafting-kit', '反訳書.md'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return fs.readFileSync(candidate, 'utf-8');
        }
    }
    return '';
}

function buildTranscriptPrompt(fileName: string, language: string, target = DEFAULT_TARGET, contextText = '') {
    const isHouhi = normalizeTarget(target) === 'houhi';
    const template = getTemplateInstruction();
    const trimmedContext = String(contextText || '').trim();
    return [
        isHouhi
            ? '音声を日本語の裁判提出用「反訳書」Markdownにするため、発言者分離つきで文字起こししてください。'
            : '音声を一般用途のMarkdown記録にするため、発言者分離つきで文字起こししてください。',
        '出力はJSONのみです。Markdownや説明文は出力しないでください。',
        '形式: {"overview":{"date":"","place":"","people":"","title":""},"items":[{"speaker":"話者1","time":"00:00","text":"発言内容"}]}',
        'time は発言開始時刻を MM:SS または HH:MM:SS で入れてください。不明なら空文字にしてください。',
        'speaker は分かる範囲で氏名・役職にし、不明なら 話者1, 話者2 のようにしてください。',
        '重要: 音声ファイルの終端まで必ず文字起こししてください。「休廷します」「一旦休廷します」「再開します」「以上です」「終わります」「次回期日」などの発言を、録音終了や出力終了の合図として扱わないでください。長い無音、休廷、再開、場面転換があっても、その後に音声があれば続けてください。途中で要約、省略、打ち切りをしないでください。',
        isHouhi ? '法匪・反訳書では、具体的な氏名や役職が事前コンテキストにない場合でも、発言内容から妥当に推定できる範囲で speaker を 原告、被告、控訴人、被控訴人、裁判官、証人、原告代理人、被告代理人、書記官 などの訴訟上の立場にしてください。第一審らしければ 原告/被告、控訴審らしければ 控訴人/被控訴人 を優先してください。聞き取れない内容や立場を無理に創作しないでください。' : '',
        isHouhi ? '裁判期日では「休廷」「再開」「合議」「次回期日」などが途中に現れることがあります。これらは手続の一部であり、録音終了を意味しません。必ず録音末尾まで反訳してください。' : '',
        trimmedContext ? `事前コンテキスト:\n${trimmedContext}\n\n上記の登場人物、固有名詞、役職、事件名、呼称を優先して、聞こえた内容に合う場合だけ反映してください。聞こえない内容を補わないでください。` : '',
        `音声ファイル名: ${fileName}`,
        `言語: ${language}`,
        isHouhi && template ? `反訳書テンプレート:\n${template}` : '',
    ].filter(Boolean).join('\n\n');
}

function buildTranscriptPostprocessPrompt(fileName: string, items: TranscriptItem[], options: TranscriptionOptions) {
    const isHouhi = normalizeTarget(options.target) === 'houhi';
    const trimmedContext = String(options.contextText || '').trim();
    return [
        '# ROLE',
        '日本語のローカル音声認識結果を、Markdown化に使う構造化JSONへ整えるアシスタントです。',
        '',
        '# TASK',
        'ReazonSpeech K2 / sherpa-onnx の文字起こし結果を読み、発言単位に整形してください。',
        '出力はJSONのみです。Markdownや説明文は出力しないでください。',
        '',
        '# OUTPUT FORMAT',
        '{"overview":{"date":"","place":"","people":"","title":""},"items":[{"speaker":"話者1","time":"00:00","text":"発言内容"}]}',
        '',
        '# RULES',
        '- 入力にない発言、日付、氏名、事件名、話者名、結論を創作しないでください。',
        '- 誤字修正、句読点、文区切り、明らかな表記ゆれ修正は行って構いません。',
        '- 音声認識の内容を要約しないでください。発言内容はできるだけ全文に近く保持してください。',
        '- time は元の chunk time を基準に MM:SS または HH:MM:SS で入れてください。',
        '- 話者が分からない場合は 話者1 のままにしてください。',
        '- 複数話者が文脈から明確な場合だけ、話者1, 話者2 または役職名へ分けてください。',
        isHouhi ? '- 裁判期日らしい場合でも、原告、被告、裁判官などの役割は発言内容から明確な場合だけ使ってください。無理に創作しないでください。' : '',
        trimmedContext ? `- 次の事前コンテキストは、聞こえた内容に合う場合だけ固有名詞・役職・呼称の補正に使ってください:\n${trimmedContext}` : '',
        '',
        `# AUDIO FILE\n${fileName}`,
        '',
        '# RAW CHUNKS JSON',
        JSON.stringify(items.map(item => ({ time: item.time, text: item.text })), null, 2),
    ].filter(Boolean).join('\n');
}

async function postprocessTranscriptWithAi(filePath: string, rawItems: TranscriptItem[], options: TranscriptionOptions) {
    const provider = selectTextAiProvider(options);
    if (!provider || options.postprocessAi === 'off') {
        return { items: rawItems, overview: {} };
    }

    const prompt = buildTranscriptPostprocessPrompt(path.basename(filePath), rawItems, options);
    try {
        console.log(`[Reazon K2] AI後処理: ${provider}`);
        const content = await requestTextAiJson(prompt, options, 'transcript postprocess request', provider);
        const json = extractJson(content) || (() => {
            try { return JSON.parse(String(content || '').trim()); } catch (_err) { return null; }
        })();
        const items = normalizeTranscriptItems(json);
        if (items.length > 0) {
            return { items, overview: json?.overview || {} };
        }
        console.warn('[Reazon K2] AI後処理の結果から発言項目を読めなかったため、生起こしを使います。');
    } catch (err: any) {
        console.warn(`[Reazon K2] AI後処理に失敗したため、生起こしを使います: ${err?.message || String(err)}`);
    }
    return { items: rawItems, overview: {} };
}

function buildTranscriptMarkdown(filePath: string, items: TranscriptItem[], overview: Record<string, string> = {}, target = DEFAULT_TARGET) {
    return normalizeTarget(target) === 'houhi'
        ? buildHouhiTranscriptMarkdown(filePath, items, overview)
        : buildGeneralTranscriptMarkdown(filePath, items, overview);
}

function buildTranscriptionSettingsComment(sourcePath: string, options: TranscriptionOptions, model: string, preprocess: Record<string, any>) {
    const metadata = {
        tool: 'mimi-ocr',
        input: 'audio',
        generatedAt: new Date().toISOString(),
        source: path.basename(sourcePath),
        settings: {
            target: options.target,
            provider: options.provider,
            model,
            language: options.language,
            processMode: options.mode,
            batchSize: options.batchSize,
            autoRename: options.autoRename,
            skipFormattedRename: options.skipFormattedRename,
            context: options.contextText ? 'provided' : 'none',
            postprocessAi: options.provider === 'reazon-k2' ? options.postprocessAi : undefined,
            reazonK2: options.provider === 'reazon-k2' ? {
                language: options.reazonK2?.language,
                device: options.reazonK2?.device,
                precision: options.reazonK2?.precision,
                chunkSeconds: options.reazonK2?.chunkSeconds,
            } : undefined,
            silenceTrim: summarizeSilenceTrim(preprocess),
            audioChunking: summarizeAudioChunking(preprocess),
        },
    };
    const json = JSON.stringify(metadata, null, 2).replace(/--/g, '\\u002d\\u002d');
    return `<!-- mimi-ocr-transcription-settings\n${json}\n-->`;
}

function appendTranscriptionSettingsComment(markdown: string, sourcePath: string, options: TranscriptionOptions, model: string, preprocess: Record<string, any>) {
    return `${String(markdown || '').trimEnd()}\n\n${buildTranscriptionSettingsComment(sourcePath, options, model, preprocess)}\n`;
}

function buildHouhiTranscriptMarkdown(filePath: string, items: TranscriptItem[], overview: Record<string, string> = {}) {
    const safeItems = items.length > 0 ? items : [{ speaker: '不明', time: '', text: '【文字起こし結果が空です】' }];
    const date = overview.date || '【要確認】';
    const place = overview.place || `【要確認】（${path.basename(filePath)}）`;
    const people = overview.people || Array.from(new Set(safeItems.map(item => item.speaker).filter(Boolean))).join('、') || '【要確認】';

    const rows = safeItems.map((item, index) => {
        return `| ${index + 1} | ${sanitizeMarkdownCell(item.speaker)} | ${sanitizeMarkdownCell(item.time)} | ${sanitizeMarkdownCell(item.text)} |`;
    });

    return [
        '# 反訳書',
        '',
        '## 1 録音概要',
        '',
        `日時：${sanitizeMarkdownCell(date)}`,
        '',
        `場所：${sanitizeMarkdownCell(place)}`,
        '',
        `登場人物：${sanitizeMarkdownCell(people)}`,
        '',
        '## 2 録音内容',
        '',
        '| No. | 発言者 | 時刻 | 発言内容 |',
        '| :---: | :--- | :---: | :--- |',
        ...rows,
        '',
        '以上',
        '',
    ].join('\n');
}

function buildGeneralTranscriptMarkdown(filePath: string, items: TranscriptItem[], overview: Record<string, string> = {}) {
    const safeItems = items.length > 0 ? items : [{ speaker: '不明', time: '', text: '【文字起こし結果が空です】' }];
    const rows = safeItems.map((item, index) => {
        return `| ${index + 1} | ${sanitizeMarkdownCell(item.speaker)} | ${sanitizeMarkdownCell(item.time)} | ${sanitizeMarkdownCell(item.text)} |`;
    });

    return [
        '# 音声認識結果',
        '',
        '## 概要',
        '',
        `- 音声ファイル: ${sanitizeMarkdownCell(path.basename(filePath))}`,
        overview.date ? `- 日時: ${sanitizeMarkdownCell(overview.date)}` : '',
        overview.people ? `- 話者: ${sanitizeMarkdownCell(overview.people)}` : '',
        '',
        '## 文字起こし',
        '',
        '| No. | 発言者 | 時刻 | 発言内容 |',
        '| :---: | :--- | :---: | :--- |',
        ...rows,
        '',
    ].filter(line => line !== '').join('\n');
}

async function transcribeWithOpenAI(filePath: string, options: TranscriptionOptions) {
    if (!options.openaiApiKey) {
        throw new Error('OpenAI APIキーがありません。config.json の providers.openai.apiKey または OPENAI_API_KEY を設定してください。');
    }

    const model = options.model || DEFAULT_OPENAI_MODEL;
    const fileSize = fs.statSync(filePath).size;
    if (fileSize > OPENAI_MAX_AUDIO_BYTES) {
        throw new Error('OpenAI Transcription API の音声ファイル上限 25MB を超えています。短く分割するか Gemini を使ってください。');
    }

    const form = new FormData();
    const buffer = fs.readFileSync(filePath);
    form.append('file', new Blob([buffer as any], { type: getMimeType(filePath) }), path.basename(filePath));
    form.append('model', model);
    form.append('language', options.language);
    form.append('prompt', buildTranscriptPrompt(path.basename(filePath), options.language, options.target, options.contextText));
    if (model.includes('diarize')) {
        form.append('response_format', 'diarized_json');
        form.append('chunking_strategy', 'auto');
    } else {
        form.append('response_format', 'json');
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.openaiApiKey}` },
        body: form as any,
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`OpenAI transcription failed: ${response.status} ${body}`);
    }

    const parsed = JSON.parse(body);
    const items = normalizeTranscriptItems(parsed);
    if (items.length > 0) return { items, overview: parsed.overview || {} };
    return { items: parseTranscriptResponse(parsed.text || body), overview: parsed.overview || {} };
}

async function uploadGeminiFile(filePath: string, apiKey: string) {
    const mimeType = getMimeType(filePath);
    const fileSize = fs.statSync(filePath).size;
    const startResponse = await fetchWithRetry('Gemini file upload start', () => fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
    }));

    const startBody = await startResponse.text();
    if (!startResponse.ok) {
        throw new Error(`Gemini file upload start failed: ${startResponse.status} ${startBody}`);
    }

    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('Gemini file upload URL が返されませんでした。');

    const uploadResponse = await fetchWithRetry('Gemini file upload body', () => fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(fileSize),
            'Content-Type': mimeType,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: fs.createReadStream(filePath),
        duplex: 'half',
    } as any));

    const uploadBody = await uploadResponse.text();
    if (!uploadResponse.ok) {
        throw new Error(`Gemini file upload failed: ${uploadResponse.status} ${uploadBody}`);
    }

    const parsed = JSON.parse(uploadBody);
    const fileUri = parsed?.file?.uri;
    if (!fileUri) throw new Error('Gemini file URI が返されませんでした。');
    return { fileUri, mimeType };
}

async function buildGeminiAudioPart(filePath: string, apiKey: string) {
    const mimeType = getMimeType(filePath);
    const fileSize = fs.statSync(filePath).size;
    if (fileSize <= GEMINI_INLINE_MAX_AUDIO_BYTES) {
        return {
            inlineData: {
                mimeType,
                data: fs.readFileSync(filePath).toString('base64'),
            },
        };
    }

    console.log(`[情報] 20MBを超える音声のため、Gemini Files API にアップロードします (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
    const uploaded = await uploadGeminiFile(filePath, apiKey);
    return {
        fileData: {
            mimeType: uploaded.mimeType,
            fileUri: uploaded.fileUri,
        },
    };
}

async function transcribeWithGemini(filePath: string, options: TranscriptionOptions) {
    if (!options.geminiApiKey) {
        throw new Error('Gemini APIキーがありません。config.json の providers.gemini.apiKey または GEMINI_API_KEY を設定してください。');
    }

    const model = options.model || DEFAULT_GEMINI_MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.geminiApiKey)}`;
    const request = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: buildTranscriptPrompt(path.basename(filePath), options.language, options.target, options.contextText) },
                    await buildGeminiAudioPart(filePath, options.geminiApiKey),
                ],
            },
        ],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
        },
    };

    const response = await fetchWithRetry('Gemini transcription request', () => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    }));

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Gemini transcription failed: ${response.status} ${body}`);
    }

    const parsed = JSON.parse(body);
    const text = parsed?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || '';
    const json = extractJson(text) || {};
    const items = normalizeTranscriptItems(json);
    return {
        items: items.length > 0 ? items : parseTranscriptResponse(text),
        overview: json.overview || {},
    };
}

async function transcribeWithReazonK2(filePath: string, options: TranscriptionOptions, preprocess: Record<string, any>) {
    const chunkSet = await createReazonAudioChunks(filePath, options);
    preprocess.reazonK2Chunks = chunkSet.chunks.map((chunk: any) => ({
        startSec: chunk.startSec,
        durationSec: chunk.durationSec,
        bytes: chunk.bytes,
    }));

    try {
        console.log(`[Reazon K2] ${chunkSet.chunks.length} チャンクをローカル音声認識します (language=${options.reazonK2?.language || DEFAULT_REAZON_K2_MODEL}, device=${options.reazonK2?.device || 'cpu'}, precision=${options.reazonK2?.precision || 'fp32'})`);
        const results = await runReazonK2(chunkSet.chunks, options);
        const rawItems = buildReazonRawItems(chunkSet.chunks, results);
        if (rawItems.length === 0) {
            return { items: [], overview: {} };
        }
        return await postprocessTranscriptWithAi(filePath, rawItems, options);
    } finally {
        chunkSet.cleanup?.();
    }
}

async function transcribeAudio(filePath: string, options: TranscriptionOptions) {
    if (options.provider === 'gemini') return transcribeWithGemini(filePath, options);
    if (options.provider === 'openai') return transcribeWithOpenAI(filePath, options);
    throw new Error(`未対応の音声認識プロバイダーです: ${options.provider}`);
}

async function transcribePreparedAudio(preprocess: Record<string, any>, options: TranscriptionOptions) {
    const audioPath = preprocess.audioPath;
    if (options.provider === 'reazon-k2') {
        return transcribeWithReazonK2(audioPath, options, preprocess);
    }

    if (options.provider !== 'gemini' || fs.statSync(audioPath).size <= GEMINI_INLINE_MAX_AUDIO_BYTES) {
        return transcribeAudio(audioPath, options);
    }

    const chunkSet = await createGeminiAudioChunks(audioPath, options);
    if (chunkSet.chunks.length <= 1 && chunkSet.chunks[0]?.audioPath === audioPath) {
        return transcribeAudio(audioPath, options);
    }

    console.log(`[情報] 大容量音声をGemini用に ${chunkSet.chunks.length} チャンクへ分割しました`);
    preprocess.geminiChunks = chunkSet.chunks.map((chunk: any) => ({
        startSec: chunk.startSec,
        durationSec: chunk.durationSec,
        bytes: chunk.bytes,
    }));
    const allItems: TranscriptItem[] = [];
    let overview: Record<string, string> = {};

    try {
        for (let i = 0; i < chunkSet.chunks.length; i++) {
            const chunk = chunkSet.chunks[i];
            console.log(`[情報] 音声チャンク ${i + 1}/${chunkSet.chunks.length}: ${formatTimestamp(chunk.startSec, true)} から ${formatTimestamp(chunk.durationSec, true)} 分 (${(chunk.bytes / 1024 / 1024).toFixed(2)}MB)`);
            const result = await transcribeAudio(chunk.audioPath, options);
            allItems.push(...offsetTranscriptItems(result.items, chunk.startSec));
            overview = mergeOverview(overview, result.overview || {});
        }
    } finally {
        chunkSet.cleanup?.();
    }

    return { items: allItems, overview };
}

function printUsage() {
    console.log('-------------------------------------------------------');
    console.log(' 音声ファイルを Markdown に変換します。');
    console.log('');
    console.log(' 使い方:');
    console.log('   node transcribe_audio.js --target=general|houhi --provider=openai|gemini|reazon-k2 --mode=sync|batch --batch_size=N --model=MODEL <音声ファイル...>');
    console.log('');
    console.log(' オプション: --auto_rename / --no_auto_rename / --skip_formatted_rename / --context-text <text> / --context-file <path>');
    console.log('           --trim_silence / --no_trim_silence / --silence_threshold_db=N / --min_silence_sec=N / --silence_padding_sec=N');
    console.log('           Reazon K2: --postprocess-ai=auto|gemini|openai|off / --reazon-language=ja|ja-en|ja-en-mls-5k / --reazon-device=cpu|cuda|coreml / --reazon-precision=fp32|int8|int8-fp32 / --reazon-chunk-sec=N');
    console.log(' 既存Markdownがある場合はOCRと同様にスキップし、--auto_rename 指定時は改名だけ実行します。');
    console.log(' 対応拡張子: ' + Array.from(SUPPORTED_AUDIO_EXTENSIONS).join(', '));
    console.log('-------------------------------------------------------');
}

async function processAudioFile(inputPath: string, options: TranscriptionOptions, model: string) {
    const filePath = path.resolve(inputPath);
    if (!fs.existsSync(filePath)) {
        console.error(`[エラー] ファイルが見つかりません: ${filePath}`);
        return false;
    }
    if (!isSupportedAudioPath(filePath)) {
        console.error(`[エラー] 未対応の音声形式です: ${path.basename(filePath)}`);
        return false;
    }

    const existingMarkdownPath = findExistingTranscriptMarkdown(filePath, options.target);
    if (existingMarkdownPath) {
        console.log(`[スキップ] 出力Markdownが既に存在します: ${existingMarkdownPath}`);
        if (options.autoRename) {
            if (options.skipFormattedRename && isTranscriptAutoRenameFormatted(filePath)) {
                console.log(`[自動改名] 既に形式通りのため変更しません: ${path.basename(filePath)}`);
            } else {
                console.log(`[自動改名] 既存Markdownを使って音声ファイルとMarkdownを改名します`);
                await autoRenameExistingTranscript(filePath, existingMarkdownPath, options.target, options);
            }
        }
        return true;
    }

    console.log(`[開始] ${path.basename(filePath)} を音声認識します`);
    const preprocess = await prepareAudioForTranscription(filePath, options.silenceTrim);
    if (preprocess.silenceTrimmed) {
        console.log(`[無音カット] ${preprocess.removedRanges.length} 箇所 / ${preprocess.removedDurationSec.toFixed(2)} 秒を削除しました`);
    } else if (options.silenceTrim?.enabled) {
        console.log(`[無音カット] 削除対象の無音区間はありませんでした`);
    }

    let result;
    try {
        result = await transcribePreparedAudio(preprocess, { ...options, model });
    } catch (err) {
        preprocess.cleanup?.();
        throw err;
    }

    const adjustedItems = mapTranscriptItemsToOriginalTime(result.items, preprocess);
    const draftMarkdown = buildTranscriptMarkdown(filePath, adjustedItems, result.overview, options.target);
    const shouldAutoRename = options.autoRename && !(options.skipFormattedRename && isTranscriptAutoRenameFormatted(filePath));
    if (options.autoRename && !shouldAutoRename) {
        console.log(`[自動改名] 既に形式通りのため変更しません: ${path.basename(filePath)}`);
    }
    const namingOverview = { ...result.overview };
    if (shouldAutoRename) {
        console.log(`[自動改名] AIで音声タイトルを判定中: ${path.basename(filePath)}`);
        const aiTitle = await inferTranscriptTitleWithAi(draftMarkdown, { ...options, model });
        if (aiTitle) {
            namingOverview.title = aiTitle;
            namingOverview.subject = aiTitle;
        }
    }
    const outputPlan = buildTranscriptOutputPlan(filePath, adjustedItems, namingOverview, options.target, shouldAutoRename, draftMarkdown);
    let currentAudioPath = filePath;
    let audioWasRenamed = false;

    try {
        if (shouldAutoRename) {
            currentAudioPath = renameAudioFileForTranscript(filePath, outputPlan.audioPath);
            audioWasRenamed = getPathKey(currentAudioPath) !== getPathKey(filePath);
        }
        const markdown = buildTranscriptMarkdown(currentAudioPath, adjustedItems, result.overview, options.target);
        fs.writeFileSync(outputPlan.markdownPath, appendTranscriptionSettingsComment(markdown, currentAudioPath, options, model, preprocess), 'utf-8');
        console.log(`[成功] ${outputPlan.markdownPath} に保存しました`);
    } catch (err) {
        if (audioWasRenamed && fs.existsSync(currentAudioPath) && !fs.existsSync(filePath)) {
            try {
                fs.renameSync(currentAudioPath, filePath);
                console.warn(`[自動改名] Markdown保存失敗のため音声ファイル名を戻しました: ${path.basename(filePath)}`);
            } catch (_rollbackError) {
            }
        }
        throw err;
    } finally {
        preprocess.cleanup?.();
    }
    return true;
}

async function processAudioFiles(files: string[], options: TranscriptionOptions, model: string) {
    if (options.mode !== 'batch') {
        let ok = true;
        for (const inputPath of files) {
            try {
                ok = await processAudioFile(inputPath, options, model) && ok;
            } catch (err: any) {
                console.error(`[エラー] ${err instanceof Error ? err.message : String(err)}`);
                ok = false;
            }
        }
        return ok;
    }

    let ok = true;
    const effectiveBatchSize = (options.provider === 'gemini' || options.provider === 'reazon-k2') ? 1 : options.batchSize;
    if (options.provider === 'gemini' && options.batchSize > effectiveBatchSize) {
        console.log(`[情報] Gemini音声認識は大容量アップロード安定化のため、実処理は1件ずつ行います`);
    }
    if (options.provider === 'reazon-k2' && options.batchSize > effectiveBatchSize) {
        console.log(`[情報] Reazon K2音声認識はモデルメモリ節約のため、実処理は1件ずつ行います`);
    }
    for (let i = 0; i < files.length; i += effectiveBatchSize) {
        const chunk = files.slice(i, i + effectiveBatchSize);
        console.log(`[情報] 音声バッチ処理中: ${i + 1}-${i + chunk.length} / ${files.length}`);
        const results = await Promise.all(chunk.map(async inputPath => {
            try {
                return await processAudioFile(inputPath, options, model);
            } catch (err: any) {
                console.error(`[エラー] ${path.basename(inputPath)}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        }));
        ok = results.every(Boolean) && ok;
    }
    return ok;
}

async function main() {
    const { options: cliOptions, files } = parseArgs(process.argv.slice(2));
    if (cliOptions.help || files.length === 0) {
        printUsage();
        return;
    }

    const options = normalizeOptions(cliOptions);
    const model = options.model || defaultModelForProvider(options.provider);
    console.log(`[情報] 音声認識プロバイダー: ${options.provider}`);
    console.log(`[情報] モデル: ${model}`);
    if (options.provider === 'reazon-k2') {
        console.log(`[情報] Reazon K2: language=${options.reazonK2.language} / device=${options.reazonK2.device} / precision=${options.reazonK2.precision} / chunk=${options.reazonK2.chunkSeconds}s / AI後処理=${options.postprocessAi}`);
    }
    console.log(`[情報] 出力形式: ${options.target === 'houhi' ? '法匪' : '一般'}`);
    console.log(`[情報] モード: ${options.mode === 'batch' ? `バッチ (サイズ ${options.batchSize})` : '同期'}`);
    console.log(`[情報] 自動改名: ${options.autoRename ? 'On' : 'Off'}`);
    console.log(`[情報] 事前コンテキスト: ${options.contextText ? 'あり' : 'なし'}`);

    const ok = await processAudioFiles(files, options, model);
    if (!ok) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[エラー] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    SUPPORTED_AUDIO_EXTENSIONS,
    isSupportedAudioPath,
    parseTranscriptResponse,
    buildTranscriptMarkdown,
    buildGeneralTranscriptMarkdown,
    buildHouhiTranscriptMarkdown,
    buildTranscriptionSettingsComment,
    appendTranscriptionSettingsComment,
    outputPathForAudio,
    buildTranscriptOutputPlan,
    findExistingTranscriptMarkdown,
    parseTranscriptMarkdown,
    autoRenameExistingTranscript,
    buildTranscriptBaseName,
    buildOriginalTranscriptBaseName,
    buildTranscriptPrompt,
    createGeminiAudioChunks,
};
