const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { mapTranscriptItemsToOriginalTime } = require('../dist/src/lib/audio_silence.js');
const {
    getProviderConfig,
    getProviderModel,
    setProviderModelOverride,
} = require('../dist/src/lib/gemini_client.js');

const {
    normalizeAudioModelSelection,
    normalizeAudioChatModelSelection,
    normalizeOcrModelSelection,
    migrateAudioGuiState,
    parseAudioModelSelection,
    parseAudioChatModelSelection,
    parseOcrModelSelection,
    resolveAudioExecutionOptions,
} = require('../dist/src/gui/audio_model_state.js');
const {
    getMimeType,
    isGeminiTranscribeModel,
    geminiTranscriptionLanguageCodes,
    buildGeminiTranscribeRequest,
    parseGeminiTranscribeResponse,
    shouldSplitGeminiAudio,
    buildGeminiChunkRanges,
    geminiChunkOwnedItems,
    requiresGeminiTranscribeConversion,
    namespaceGeminiChunkSpeakers,
    transcribeWithGemini,
    transcribePreparedAudio,
    postprocessTranscriptWithAi,
    anchorGeminiTranscribePostprocessItems,
    buildTranscriptContextPrompt,
    shouldChunkTranscriptPostprocess,
    createTranscriptPostprocessBatches,
    stableSortTranscriptItems,
    extractTranscriptPostprocessContext,
    buildGeneralTranscriptMarkdown,
    buildHouhiTranscriptMarkdown,
    buildTranscriptOutputPlan,
    parseTranscriptMarkdown,
    parseTranscriptionSettingsComment,
    assessExistingTranscriptForReuse,
    writeTranscriptMarkdown,
    parseArgs,
    normalizeOptions,
    selectTextAiProvider,
} = require('../dist/src/transcribe_audio.js');

function transcriptSettingsComment(settings, schemaVersion = 3) {
    return `<!-- mimi-ocr-transcription-settings\n${JSON.stringify({
        tool: 'mimi-ocr',
        schemaVersion,
        input: 'audio',
        settings,
    }, null, 2)}\n-->`;
}

test('GUI cloud audio selections use configured models and migrate only known legacy values', () => {
    assert.equal(normalizeAudioModelSelection('gemini:gemini-3.5-flash'), 'gemini:auto');
    assert.equal(normalizeAudioModelSelection('openai:gpt-4o-transcribe-diarize'), 'openai:auto');
    assert.equal(normalizeAudioModelSelection('gemini:explicit-future-model'), 'gemini:explicit-future-model');
    assert.equal(normalizeAudioModelSelection('reazon-k2:ja-en:gemini'), 'reazon-k2:ja-en:gemini');

    const original = {
        currentAudioModel: 'gemini:gemini-3.5-flash',
        batchSize: '7',
        contextText: '固有名詞',
    };
    assert.deepEqual(migrateAudioGuiState(original), {
        currentAudioModel: 'gemini:auto',
        currentAudioPostprocess: true,
        currentAudioChatModel: 'auto:auto',
        currentOcrModel: 'gemini:auto',
        batchSize: '7',
        contextText: '固有名詞',
    });
    assert.equal(migrateAudioGuiState({ currentAudioPostprocess: false }).currentAudioPostprocess, false);
    assert.deepEqual(parseAudioModelSelection('openai:auto'), {
        provider: 'openai',
        model: 'auto',
    });
    assert.equal(normalizeAudioChatModelSelection('openai:gpt-5.6-sol'), 'openai:gpt-5.6-sol');
    assert.equal(normalizeAudioChatModelSelection('unknown:model'), 'auto:auto');
    assert.deepEqual(parseAudioChatModelSelection('gemini:gemini-3.6-flash'), {
        postprocessAi: 'gemini',
        postprocessModel: 'gemini-3.6-flash',
    });
    assert.deepEqual(parseAudioChatModelSelection('auto:auto'), { postprocessAi: 'auto' });
    assert.equal(normalizeOcrModelSelection('claude:claude-sonnet-test'), 'claude:claude-sonnet-test');
    assert.deepEqual(parseOcrModelSelection('openai:gpt-ocr-test'), {
        provider: 'openai',
        model: 'gpt-ocr-test',
    });
    assert.equal(migrateAudioGuiState({ currentAiProvider: 'claude' }).currentOcrModel, 'claude:auto');
});

test('GUI resolves auto through provider transcription settings while preserving explicit CLI models', () => {
    const configured = {
        gemini: 'configured-gemini-transcription-model',
        openai: 'configured-openai-transcription-model',
    };
    const resolver = provider => configured[provider] || '';

    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'gemini', model: 'auto' }, resolver),
        { provider: 'gemini', model: configured.gemini, postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'openai', model: 'auto' }, resolver),
        { provider: 'openai', model: configured.openai, postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'gemini', model: 'explicit-gemini-model' }, resolver),
        { provider: 'gemini', model: 'explicit-gemini-model', postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'gemini', model: 'gemini-3.5-flash', postprocessAi: 'auto' }, resolver),
        { provider: 'gemini', model: configured.gemini, postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'openai', model: 'gpt-4o-transcribe-diarize' }, resolver),
        { provider: 'openai', model: configured.openai, postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({ provider: 'gemini', model: 'auto', postprocessAi: 'off' }, resolver),
        { provider: 'gemini', model: configured.gemini, postprocessAi: 'off' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({}, () => ''),
        { provider: 'gemini', model: 'gemini-3.5-transcribe', postprocessAi: 'auto' },
    );
    assert.deepEqual(
        resolveAudioExecutionOptions({
            provider: 'gemini',
            model: 'auto',
            postprocessAi: 'openai',
            postprocessModel: 'gpt-postprocess',
        }, resolver),
        {
            provider: 'gemini',
            model: configured.gemini,
            postprocessAi: 'openai',
            postprocessModel: 'gpt-postprocess',
        },
    );
});

test('built GUI uses comboboxes consistently for every runtime model selection', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'src', 'gui', 'index.html'), 'utf8');
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'src', 'gui', 'main.js'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'src', 'gui', 'preload.js'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'src', 'gui', 'renderer.js'), 'utf8');
    assert.match(html, /<select class="model-select" id="audioModelSelect"/);
    assert.match(html, /<select class="model-select" id="audioChatModelSelect"/);
    assert.match(html, /<select class="model-select" id="ocrModelSelect"/);
    assert.doesNotMatch(html, /data-audio-model=|data-ai=/);
    assert.match(html, /id="cfgGeminiChatModel1"[^>]+list="geminiChatModelOptions"/);
    assert.match(html, /id="cfgGeminiTranscriptionModel"[^>]+list="geminiTranscriptionModelOptions"/);
    assert.match(html, /id="cfgOpenaiChatModel"[^>]+list="openaiChatModelOptions"/);
    assert.match(html, /id="cfgOpenaiTranscriptionModel"[^>]+list="openaiTranscriptionModelOptions"/);
    assert.match(html, /id="cfgClaudeChatModel"[^>]+list="claudeChatModelOptions"/);
    assert.match(html, /id="audioPostprocessCheckbox" checked/);
    assert.match(html, />Chat APIで全体補正<\/span>/);
    assert.match(html, /value="auto:auto">自動（音声モデルとAPI設定に従う）<\/option>/);
    assert.match(mainSource, /ipcMain\.handle\('read-clipboard-text'.*clipboard\.readText\(\)/s);
    assert.match(preloadSource, /readClipboardText:\s*\(\) =>\s*ipcRenderer\.invoke\('read-clipboard-text'\)/s);
    assert.doesNotMatch(preloadSource, /\bclipboard\.readText\(/);
    assert.match(rendererSource, /data-paste-target|pasteTarget/);
});

test('OCR runtime model selection overrides the configured provider model', () => {
    try {
        setProviderModelOverride('openai', 'chat', 'gpt-ocr-combobox-test');
        assert.equal(getProviderModel('openai', 'chat'), 'gpt-ocr-combobox-test');
        assert.equal(getProviderConfig('openai').chatModel, 'gpt-ocr-combobox-test');

        const result = spawnSync(process.execPath, [
            path.join(__dirname, '..', 'dist', 'src', 'ocr.js'),
            '--ai', 'openai',
            '--model', 'gpt-ocr-cli-test',
        ], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
        });
        assert.match(`${result.stdout}\n${result.stderr}`, /OCRモデル（現在: gpt-ocr-cli-test）/);
    } finally {
        setProviderModelOverride('openai', 'chat', '');
    }
});

test('Chat postprocess provider and model are independent from the transcription model', () => {
    const parsed = parseArgs([
        '--provider=gemini',
        '--postprocess-ai=openai',
        '--postprocess-model=gpt-postprocess-only',
        'recording.mp3',
    ]);
    assert.equal(parsed.options.postprocessAi, 'openai');
    assert.equal(parsed.options.postprocessModel, 'gpt-postprocess-only');
    assert.deepEqual(parsed.files, ['recording.mp3']);

    const options = normalizeOptions({
        provider: 'gemini',
        model: 'gemini-transcription-only',
        postprocessAi: 'openai',
        postprocessModel: 'gpt-postprocess-only',
    });
    assert.equal(options.model, 'gemini-transcription-only');
    assert.equal(options.postprocessAi, 'openai');
    assert.equal(options.openaiChatModel, 'gpt-postprocess-only');
    assert.equal(selectTextAiProvider({
        ...options,
        geminiApiKey: 'gemini-test-key',
        openaiApiKey: 'openai-test-key',
    }), 'openai');
});

test('direct CLI resolves configured Gemini transcription model without contacting an API', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-audio-model-test-'));
    const defaultsPath = path.join(tempDir, 'app.defaults.json');
    const configPath = path.join(tempDir, 'config.json');
    try {
        fs.writeFileSync(defaultsPath, JSON.stringify({
            providers: {
                gemini: { transcriptionModel: 'defaults-gemini-model' },
                openai: { transcriptionModel: 'defaults-openai-model' },
            },
            transcription: { provider: 'gemini' },
        }));
        fs.writeFileSync(configPath, JSON.stringify({
            providers: { gemini: { transcriptionModel: 'configured-gemini-model' } },
        }));
        const result = spawnSync(process.execPath, [
            path.join(__dirname, '..', 'dist', 'src', 'transcribe_audio.js'),
            '--provider=gemini',
            '--model=auto',
            path.join(tempDir, 'missing.wav'),
        ], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                MIMI_OCR_CONFIG: configPath,
                MIMI_OCR_PROJECT_ROOT: tempDir,
                GEMINI_API_KEY: '',
                GOOGLE_API_KEY: '',
            },
            encoding: 'utf8',
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(output, /モデル: configured-gemini-model/);
        assert.match(output, /ファイルが見つかりません/);
        assert.doesNotMatch(output, /transcription failed|generateContent/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini transcript formatting honors chatModels and GEMINI_CHAT_MODELS priority', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-audio-chat-model-test-'));
    const defaultsPath = path.join(tempDir, 'app.defaults.json');
    const configPath = path.join(tempDir, 'config.json');
    const envKeys = [
        'MIMI_OCR_CONFIG',
        'MIMI_OCR_CONFIG_DIR',
        'MIMI_OCR_PROJECT_ROOT',
        'GEMINI_CHAT_MODELS',
        'GEMINI_CHAT_MODEL',
    ];
    const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    try {
        fs.writeFileSync(defaultsPath, JSON.stringify({
            providers: {
                gemini: {
                    chatModel: 'default-legacy-chat-model',
                    chatModels: ['default-priority-chat-model'],
                    transcriptionModel: 'gemini-3.5-transcribe',
                },
            },
            transcription: { provider: 'gemini' },
        }));
        fs.writeFileSync(configPath, JSON.stringify({
            providers: { gemini: { chatModels: ['configured-priority-chat-model'] } },
        }));
        process.env.MIMI_OCR_CONFIG = configPath;
        process.env.MIMI_OCR_CONFIG_DIR = '';
        process.env.MIMI_OCR_PROJECT_ROOT = tempDir;
        delete process.env.GEMINI_CHAT_MODELS;
        delete process.env.GEMINI_CHAT_MODEL;

        assert.equal(
            normalizeOptions({ provider: 'gemini' }).geminiChatModel,
            'configured-priority-chat-model',
        );

        fs.writeFileSync(configPath, '{}');
        process.env.GEMINI_CHAT_MODELS = 'environment-priority-chat-model,environment-secondary-chat-model';
        assert.equal(
            normalizeOptions({ provider: 'gemini' }).geminiChatModel,
            'environment-priority-chat-model',
        );
    } finally {
        for (const key of envKeys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini 3.5 Transcribe request follows the dedicated transcription contract', () => {
    assert.equal(isGeminiTranscribeModel('gemini-3.5-transcribe'), true);
    assert.equal(isGeminiTranscribeModel('gemini-3.5-transcribe-live'), false);
    assert.equal(isGeminiTranscribeModel('gemini-3.5-flash'), false);
    assert.deepEqual(geminiTranscriptionLanguageCodes('ja'), ['ja-JP']);
    const audioPart = { fileData: { fileUri: 'files/example', mimeType: 'audio/m4a' } };
    const request = buildGeminiTranscribeRequest(audioPart, {
        model: 'gemini-3.5-transcribe',
        language: 'ja',
        contextText: '登場人物: 田中、佐藤。専門用語: 反訳書',
    });
    assert.equal(request.model, 'gemini-3.5-transcribe');
    assert.deepEqual(request.input, [{
        type: 'audio',
        uri: 'files/example',
        mime_type: 'audio/m4a',
    }]);
    assert.deepEqual(request.generation_config.transcription_config, {
        language_codes: ['ja-JP'],
        mode: {
            type: 'verbatim',
            diarization_mode: 'speaker',
            timestamp_granularities: ['word'],
        },
    });
    assert.equal('custom_vocabulary' in request.generation_config.transcription_config, false);
    assert.equal(getMimeType('recording.m4a'), 'audio/m4a');
    assert.equal(requiresGeminiTranscribeConversion('recording.MP4'), true);
    assert.equal(requiresGeminiTranscribeConversion('recording.m4a'), false);
});

test('Gemini 3.5 Transcribe keeps supported files whole up to the diarization duration limit', () => {
    const mb = 1024 * 1024;
    assert.equal(shouldSplitGeminiAudio(10 * mb, 15 * 60, false, 30 * 60), false);
    assert.equal(shouldSplitGeminiAudio(25 * mb, 5 * 60, false, 30 * 60), false);
    assert.equal(shouldSplitGeminiAudio(10 * mb, 31 * 60, false, 30 * 60), true);
    assert.equal(shouldSplitGeminiAudio(25 * mb, 5 * 60, true, 30 * 60), true);

    assert.deepEqual(namespaceGeminiChunkSpeakers([
        { speaker: '話者1', time: '00:01', text: '発言' },
        { speaker: '話者不明', time: '', text: '不明' },
    ], 2), [
        { speaker: '話者1（区間2）', speakerSection: 2, time: '00:01', text: '発言' },
        { speaker: '話者不明', speakerSection: 2, time: '', text: '不明' },
    ]);
});

test('long Gemini transcription uses 10-minute owned ranges with five-second context overlap', () => {
    const ranges = buildGeminiChunkRanges(4927.738, 10 * 60, 5);
    assert.equal(ranges.length, 9);
    assert.deepEqual(ranges[0], { startSec: 0, durationSec: 605, contentStartSec: 0, contentEndSec: 600 });
    assert.deepEqual(ranges[1], { startSec: 595, durationSec: 610, contentStartSec: 600, contentEndSec: 1200 });
    assert.deepEqual(ranges.at(-1), { startSec: 4795, durationSec: 132.738, contentStartSec: 4800, contentEndSec: 4927.738 });
    assert.ok(ranges.every(range => range.contentEndSec - range.contentStartSec <= 600));
    assert.ok(ranges.every(range => range.durationSec <= 610));

    const overlapItems = [
        { speaker: '話者1', time: '00:09:59.900', startMs: 599900, text: '前区間' },
        { speaker: '話者1', time: '00:10:00.000', startMs: 600000, text: '次区間' },
        { speaker: '話者1', time: '00:10:00.100', startMs: 600100, text: '次区間続き' },
    ];
    assert.deepEqual(geminiChunkOwnedItems(overlapItems, ranges[0], false).map(item => item.text), ['前区間']);
    assert.deepEqual(geminiChunkOwnedItems(overlapItems, ranges[1], false).map(item => item.text), ['次区間', '次区間続き']);
});

function interactionWordInfo(source, text, speaker, startOffset, endOffset) {
    const startCharacter = source.indexOf(text);
    assert.notEqual(startCharacter, -1, `word not found in fixture: ${text}`);
    return {
        type: 'word_info',
        text,
        speaker,
        start_offset: startOffset,
        end_offset: endOffset,
        start_index: Buffer.byteLength(source.slice(0, startCharacter), 'utf8'),
        end_index: Buffer.byteLength(source.slice(0, startCharacter + text.length), 'utf8'),
    };
}

function geminiInteractionResponse(text, annotations) {
    return {
        status: 'completed',
        steps: [{
            type: 'model_output',
            content: [{ type: 'text', text, annotations }],
        }],
    };
}

test('Gemini 3.5 Transcribe word_info annotations become speaker- and sentence-level turns', () => {
    const text = 'こんにちは。次の文です。Hello world.';
    const parsed = parseGeminiTranscribeResponse(geminiInteractionResponse(text, [
        interactionWordInfo(text, 'こんにちは', 'spk_1', '0.100s', '0.500s'),
        interactionWordInfo(text, '次の', 'spk_1', '1.100s', '1.300s'),
        interactionWordInfo(text, '文', 'spk_1', '1.300s', '1.500s'),
        interactionWordInfo(text, 'です', 'spk_1', '1.500s', '1.800s'),
        interactionWordInfo(text, 'Hello', 'spk_2', '2.100s', '2.400s'),
        interactionWordInfo(text, 'world', 'spk_2', '2.500s', '2.900s'),
    ]));
    assert.deepEqual(parsed.items, [
        { speaker: '話者1', speakerId: 'spk_1', startMs: 100, endMs: 500, time: '00:00:00.100', endTime: '00:00:00.500', text: 'こんにちは。' },
        { speaker: '話者1', speakerId: 'spk_1', startMs: 1100, endMs: 1800, time: '00:00:01.100', endTime: '00:00:01.800', text: '次の文です。' },
        { speaker: '話者2', speakerId: 'spk_2', startMs: 2100, endMs: 2900, time: '00:00:02.100', endTime: '00:00:02.900', text: 'Hello world.' },
    ]);
    assert.equal(parsed.wordInfoCount, 6);

    const textOnly = parseGeminiTranscribeResponse({
        output_text: '話者情報のない全文です。',
    });
    assert.deepEqual(textOnly.items, [
        { speaker: '話者不明', time: '', text: '話者情報のない全文です。' },
    ]);
    assert.equal(textOnly.wordInfoCount, 0);
});

test('Gemini 3.5 Transcribe normalizes zero-based spk: labels from the live API', () => {
    const text = '質問です。回答します。';
    const parsed = parseGeminiTranscribeResponse(geminiInteractionResponse(text, [
        interactionWordInfo(text, '質問です', 'spk:0', '0.100s', '0.600s'),
        interactionWordInfo(text, '回答します', 'spk:1', '1.000s', '1.600s'),
    ]));

    assert.deepEqual(parsed.items, [
        { speaker: '話者1', speakerId: 'spk:0', startMs: 100, endMs: 600, time: '00:00:00.100', endTime: '00:00:00.600', text: '質問です。' },
        { speaker: '話者2', speakerId: 'spk:1', startMs: 1000, endMs: 1600, time: '00:00:01.000', endTime: '00:00:01.600', text: '回答します。' },
    ]);
});

test('Gemini sparse punctuation metadata is absorbed into neighboring timed speaker turns', () => {
    const text = 'こんにちは。次です!';
    const parsed = parseGeminiTranscribeResponse(geminiInteractionResponse(text, [
        interactionWordInfo(text, 'こんにちは', 'spk_1', '0.100s', '0.500s'),
        interactionWordInfo(text, '。', undefined, undefined, undefined),
        interactionWordInfo(text, '次', undefined, '1.000s', '1.200s'),
        interactionWordInfo(text, 'です', 'spk_2', '1.200s', '1.500s'),
        interactionWordInfo(text, '!', undefined, undefined, undefined),
    ]));

    assert.deepEqual(parsed.items, [
        { speaker: '話者1', speakerId: 'spk_1', startMs: 100, endMs: 500, time: '00:00:00.100', endTime: '00:00:00.500', text: 'こんにちは。' },
        { speaker: '話者2', speakerId: 'spk_2', startMs: 1000, endMs: 1500, time: '00:00:01.000', endTime: '00:00:01.500', text: '次です!' },
    ]);
    assert.equal(parsed.recoveredWordMetadataCount, 3);
});

test('Gemini word annotations are stably sorted by start time instead of response text order', () => {
    const text = '後です。先です。';
    const parsed = parseGeminiTranscribeResponse(geminiInteractionResponse(text, [
        interactionWordInfo(text, '後', 'spk:0', '2.000s', '2.500s'),
        interactionWordInfo(text, '先', 'spk:1', '1.000s', '1.400s'),
    ]));

    assert.deepEqual(parsed.items.map(item => ({ speakerId: item.speakerId, time: item.time, endTime: item.endTime, text: item.text })), [
        { speakerId: 'spk:1', time: '00:00:01.000', endTime: '00:00:01.400', text: '先です。' },
        { speakerId: 'spk:0', time: '00:00:02.000', endTime: '00:00:02.500', text: '後です。' },
    ]);
});

test('Gemini parser reports a large timestamp rollback before stable sorting hides it', () => {
    const text = '最初です。後半です。巻き戻ります。';
    const parsed = parseGeminiTranscribeResponse(geminiInteractionResponse(text, [
        interactionWordInfo(text, '最初です', 'spk_1', '0.100s', '1.000s'),
        interactionWordInfo(text, '後半です', 'spk_1', '100.000s', '101.000s'),
        interactionWordInfo(text, '巻き戻ります', 'spk_1', '40.000s', '41.000s'),
    ]));

    assert.equal(parsed.timestampRegressionMs, 60000);
    assert.deepEqual(parsed.items.map(item => item.time), [
        '00:00:00.100',
        '00:00:40.000',
        '00:01:40.000',
    ]);
});

test('one acoustic speaker ID keeps one fixed name across the whole ASR section', () => {
    const rawItems = [
        { speaker: '話者1', speakerId: 'spk:0', time: '00:00:00.100', endTime: '00:00:00.600', startMs: 100, endMs: 600, text: 'もしもし、寺村です。' },
        { speaker: '話者2', speakerId: 'spk:1', time: '00:00:01.000', endTime: '00:00:01.500', startMs: 1000, endMs: 1500, text: '宮部です。' },
        { speaker: '話者1', speakerId: 'spk:0', time: '00:04:25.000', endTime: '00:04:27.000', startMs: 265000, endMs: 267000, text: '勤務実態を教えてください。' },
        { speaker: '話者2', speakerId: 'spk:1', time: '00:04:28.000', endTime: '00:04:32.000', startMs: 268000, endMs: 272000, text: '夜勤がありました。' },
    ];
    const context = extractTranscriptPostprocessContext({
        speaker_map: { 'spk:0': '寺村', 'spk:1': '宮部' },
    });
    const deliberatelySwappedByLaterBatch = rawItems.map((item, index) => ({
        id: index + 1,
        speaker: index < 2 ? item.speaker : (item.speaker === '話者1' ? '宮部' : '寺村'),
        text: item.text,
    }));
    const corrected = anchorGeminiTranscribePostprocessItems(rawItems, deliberatelySwappedByLaterBatch, context.speakerMap);

    assert.deepEqual(corrected.map(item => ({ speaker: item.speaker, speakerId: item.speakerId })), [
        { speaker: '寺村', speakerId: 'spk:0' },
        { speaker: '宮部', speakerId: 'spk:1' },
        { speaker: '寺村', speakerId: 'spk:0' },
        { speaker: '宮部', speakerId: 'spk:1' },
    ]);
});

test('Markdown exposes acoustic speaker IDs and millisecond start/end timestamps', () => {
    const markdown = buildGeneralTranscriptMarkdown('interview.mp3', [{
        speaker: '寺村',
        speakerId: 'spk:0',
        time: '00:00:00.100',
        endTime: '00:00:01.250',
        startMs: 100,
        endMs: 1250,
        text: 'もしもし、寺村です。',
    }], { people: '寺村、宮部' });
    assert.match(markdown, /\| No\. \| 発言者 \| 話者ID \| 開始時刻 \| 終了時刻 \| 発言内容 \|/);
    assert.match(markdown, /\| 1 \| 寺村 \| spk:0 \| 00:00:00\.100 \| 00:00:01\.250 \|/);
});

test('Houhi transcript hides acoustic IDs and renders court-facing timestamps to whole seconds', () => {
    const markdown = buildHouhiTranscriptMarkdown('interview.mp3', [{
        speaker: '寺村',
        speakerId: 'spk:0',
        time: '00:00:00.100',
        endTime: '01:02:03.987',
        startMs: 100,
        endMs: 3723987,
        text: 'もしもし、寺村です。',
    }], { people: '寺村、宮部' });
    assert.match(markdown, /\| No\. \| 発言者 \| 開始時刻 \| 終了時刻 \| 発言内容 \|/);
    assert.match(markdown, /\| 1 \| 寺村 \| 00:00:00 \| 01:02:03 \| もしもし、寺村です。 \|/);
    assert.doesNotMatch(markdown, /話者ID|spk:0|\.100|\.987/);
    assert.deepEqual(parseTranscriptMarkdown(markdown).items, [{
        speaker: '寺村',
        time: '00:00:00',
        endTime: '01:02:03',
        startMs: 0,
        endMs: 3723000,
        text: 'もしもし、寺村です。',
    }]);
});

test('legacy general transcripts are reprocessed when speaker metadata or the effective Chat model is stale', () => {
    const options = {
        target: 'general',
        provider: 'gemini',
        language: 'ja',
        contextText: '',
        postprocessAi: 'auto',
        geminiApiKey: 'synthetic-test-key',
        geminiChatModel: 'gemini-chat-current',
    };
    const legacyMarkdown = [
        '# 音声認識結果',
        '',
        '| No. | 発言者 | 時刻 | 発言内容 |',
        '| :---: | :--- | :---: | :--- |',
        '| 1 | 話者不明 |  | 全文が一つの発言です。 |',
        '',
        transcriptSettingsComment({
            target: 'general',
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            language: 'ja',
            context: 'none',
            postprocessAi: 'auto',
        }, 2),
    ].join('\n');

    const metadata = parseTranscriptionSettingsComment(legacyMarkdown);
    assert.equal(metadata.settings.model, 'gemini-3.5-transcribe');
    const assessment = assessExistingTranscriptForReuse(legacyMarkdown, options, 'gemini-3.5-transcribe');
    assert.equal(assessment.reusable, false);
    assert.ok(assessment.reasons.some(reason => /補正の成功を確認できない旧形式/.test(reason)));
    assert.ok(assessment.reasons.some(reason => /全体補正プロバイダー/.test(reason)));
    assert.ok(assessment.reasons.some(reason => /話者ID・開始時刻・終了時刻/.test(reason)));
});

test('current structured general transcripts are reused and hand-edited Markdown remains protected', () => {
    const options = {
        target: 'general',
        provider: 'gemini',
        language: 'ja',
        contextText: '',
        postprocessAi: 'gemini',
        geminiApiKey: 'synthetic-test-key',
        geminiChatModel: 'gemini-chat-current',
    };
    const currentMarkdown = `${buildGeneralTranscriptMarkdown('interview.mp3', [{
        speaker: '寺村',
        speakerId: 'spk:0',
        time: '00:00:00.100',
        endTime: '00:00:01.250',
        startMs: 100,
        endMs: 1250,
        text: 'もしもし、寺村です。',
    }])}\n\n${transcriptSettingsComment({
        target: 'general',
        provider: 'gemini',
        model: 'gemini-3.5-transcribe',
        language: 'ja',
        context: 'none',
        postprocessAi: 'gemini',
        postprocessProvider: 'gemini',
        postprocessModel: 'gemini-chat-current',
    })}`;

    assert.deepEqual(
        assessExistingTranscriptForReuse(currentMarkdown, options, 'gemini-3.5-transcribe'),
        { reusable: true, reasons: [] },
    );
    assert.deepEqual(
        assessExistingTranscriptForReuse('# 手作業で編集した反訳', options, 'gemini-3.5-transcribe'),
        { reusable: true, reasons: [] },
    );
});

test('reprocessed transcripts replace the stale path while preserving the old Markdown', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-transcript-reprocess-'));
    const audioPath = path.join(tempDir, 'call.mp3');
    const existingMarkdownPath = path.join(tempDir, 'call_音声認識.md');
    fs.writeFileSync(audioPath, 'synthetic-audio');
    fs.writeFileSync(existingMarkdownPath, 'old transcript', 'utf8');
    try {
        const plan = buildTranscriptOutputPlan(
            audioPath,
            [{ speaker: '担当者', time: '00:00:00.000', text: 'ご案内です。' }],
            {},
            'general',
            false,
            '',
            existingMarkdownPath,
        );
        assert.equal(plan.markdownPath, existingMarkdownPath);
        const archivePath = writeTranscriptMarkdown(plan.markdownPath, 'new transcript', existingMarkdownPath);
        assert.equal(fs.readFileSync(existingMarkdownPath, 'utf8'), 'new transcript');
        assert.equal(fs.readFileSync(archivePath, 'utf8'), 'old transcript');
        assert.match(path.basename(archivePath), /_旧結果\.md$/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('silence trimming restores millisecond start and end timestamps to the original timeline', () => {
    const [mapped] = mapTranscriptItemsToOriginalTime([{
        speaker: '話者1',
        speakerId: 'spk:0',
        time: '00:00:11.000',
        endTime: '00:00:12.500',
        startMs: 11000,
        endMs: 12500,
        text: '発言',
    }], {
        silenceTrimmed: true,
        keptSegments: [
            { originalStart: 0, originalEnd: 10, processedStart: 0, processedEnd: 10 },
            { originalStart: 20, originalEnd: 30, processedStart: 10, processedEnd: 20 },
        ],
    });
    assert.equal(mapped.time, '00:00:21.000');
    assert.equal(mapped.endTime, '00:00:22.500');
    assert.equal(mapped.startMs, 21000);
    assert.equal(mapped.endMs, 22500);

    const [atTrimBoundary] = mapTranscriptItemsToOriginalTime([{
        speaker: '話者1',
        speakerId: 'spk:0',
        time: '00:00:10.000',
        endTime: '00:00:10.500',
        startMs: 10000,
        endMs: 10500,
        text: '無音明けの発言',
    }], {
        silenceTrimmed: true,
        keptSegments: [
            { originalStart: 0, originalEnd: 10, processedStart: 0, processedEnd: 10 },
            { originalStart: 20, originalEnd: 30, processedStart: 10, processedEnd: 20 },
        ],
    });
    assert.equal(atTrimBoundary.time, '00:00:20.000');
    assert.equal(atTrimBoundary.endTime, '00:00:20.500');
});

test('configured Gemini 3.5 Transcribe model reaches the dedicated REST path without a real API call', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gemini-transcribe-integration-'));
    const audioPath = path.join(tempDir, 'sample.m4a');
    fs.writeFileSync(audioPath, 'synthetic-audio-bytes');
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(geminiInteractionResponse('確認。', [
                interactionWordInfo('確認。', '確認', 'spk_1', '1.000s', '1.300s'),
            ])),
        };
    };

    try {
        const options = {
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            geminiApiKey: 'synthetic-test-key',
            language: 'ja',
            target: 'general',
            contextText: '',
            postprocessAi: 'off',
            silenceTrim: {},
        };
        const result = await transcribeWithGemini(audioPath, options);
        assert.equal(requests.length, 1);
        const requestUrl = new URL(requests[0].url);
        assert.equal(requestUrl.pathname, '/v1beta/interactions');
        assert.equal(requestUrl.search, '');
        assert.equal(requests[0].init.headers['x-goog-api-key'], 'synthetic-test-key');
        const body = JSON.parse(requests[0].init.body);
        assert.equal(body.model, 'gemini-3.5-transcribe');
        assert.deepEqual(body.generation_config.transcription_config, {
            language_codes: ['ja-JP'],
            mode: {
                type: 'verbatim',
                diarization_mode: 'speaker',
                timestamp_granularities: ['word'],
            },
        });
        assert.equal(body.input[0].type, 'audio');
        assert.equal(body.input[0].mime_type, 'audio/m4a');
        assert.equal(typeof body.input[0].data, 'string');
        assert.deepEqual(result.items, [
            { speaker: '話者1', speakerId: 'spk_1', startMs: 1000, endMs: 1300, time: '00:00:01.000', endTime: '00:00:01.300', text: '確認。' },
        ]);
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini 3.5 Transcribe refuses text-only responses instead of emitting one unknown-speaker turn', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gemini-transcribe-missing-annotations-'));
    const audioPath = path.join(tempDir, 'sample.m4a');
    fs.writeFileSync(audioPath, 'synthetic-audio-bytes');
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            status: 'completed',
            output_text: '話者情報のない全文です。',
            steps: [{
                type: 'model_output',
                content: [{ type: 'text', text: '話者情報のない全文です。' }],
            }],
        }),
    });

    try {
        await assert.rejects(
            () => transcribeWithGemini(audioPath, {
                provider: 'gemini',
                model: 'gemini-3.5-transcribe',
                geminiApiKey: 'synthetic-test-key',
                language: 'ja',
                target: 'general',
                contextText: '',
                postprocessAi: 'off',
                silenceTrim: {},
            }),
            /word_info annotations required/,
        );

        const incompleteText = '時刻が不完全です。';
        global.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(geminiInteractionResponse(incompleteText, [
                interactionWordInfo(incompleteText, '時刻が不完全です', 'spk_1', '0.100s', undefined),
            ])),
        });
        await assert.rejects(
            () => transcribeWithGemini(audioPath, {
                provider: 'gemini',
                model: 'gemini-3.5-transcribe',
                geminiApiKey: 'synthetic-test-key',
                language: 'ja',
                target: 'general',
                contextText: '',
                postprocessAi: 'off',
                silenceTrim: {},
            }),
            /without the required speaker ID or start\/end word timestamps/,
        );

        const rollbackText = '最初です。後半です。巻き戻ります。';
        global.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(geminiInteractionResponse(rollbackText, [
                interactionWordInfo(rollbackText, '最初です', 'spk_1', '0.100s', '1.000s'),
                interactionWordInfo(rollbackText, '後半です', 'spk_1', '100.000s', '101.000s'),
                interactionWordInfo(rollbackText, '巻き戻ります', 'spk_1', '40.000s', '41.000s'),
            ])),
        });
        await assert.rejects(
            () => transcribeWithGemini(audioPath, {
                provider: 'gemini',
                model: 'gemini-3.5-transcribe',
                geminiApiKey: 'synthetic-test-key',
                language: 'ja',
                target: 'general',
                contextText: '',
                postprocessAi: 'off',
                silenceTrim: {},
            }),
            /non-monotonic timestamp regression of 60\.000 seconds/,
        );
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cloud transcription runs a full Chat API correction pass only when enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-audio-two-pass-'));
    const audioPath = path.join(tempDir, 'interview.mp3');
    fs.writeFileSync(audioPath, 'synthetic-audio-bytes');
    const originalFetch = global.fetch;

    const run = async postprocessAi => {
        const requests = [];
        global.fetch = async (url, init) => {
            requests.push({ url: String(url), init });
            if (String(url).includes('/audio/transcriptions')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        overview: { place: '会議室' },
                        items: [{ speaker: '話者1', time: '00:01', text: '田中です福し施設の夜きんを担当しています' }],
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                overview: { title: '勤務実態インタビュー' },
                                items: [{ id: 1, speaker: '田中', time: '00:01', text: '田中です。福祉施設の夜勤を担当しています。' }],
                            }),
                        },
                    }],
                }),
            };
        };

        const result = await transcribePreparedAudio({ audioPath }, {
            provider: 'openai',
            model: 'gpt-4o-transcribe-diarize',
            openaiApiKey: 'synthetic-test-key',
            openaiBaseUrl: 'https://example.test/v1/chat/completions',
            openaiChatModel: 'configured-chat-model',
            language: 'ja',
            target: 'general',
            contextText: '',
            postprocessAi,
            silenceTrim: {},
        });
        return { requests, result };
    };

    try {
        const enabled = await run('auto');
        assert.equal(enabled.requests.length, 2);
        assert.match(enabled.requests[0].url, /\/audio\/transcriptions$/);
        assert.equal(new URL(enabled.requests[1].url).hostname, 'example.test');
        const correctionRequest = JSON.parse(enabled.requests[1].init.body);
        assert.match(correctionRequest.messages[0].content, /誤字修正/);
        assert.equal(Object.hasOwn(correctionRequest, 'temperature'), false);
        assert.deepEqual(enabled.result, {
            overview: { place: '会議室', title: '勤務実態インタビュー' },
            items: [{ speaker: '田中', time: '00:01', text: '田中です。福祉施設の夜勤を担当しています。' }],
        });

        const disabled = await run('off');
        assert.equal(disabled.requests.length, 1);
        assert.deepEqual(disabled.result, {
            overview: { place: '会議室' },
            items: [{ speaker: '話者1', time: '00:01', text: '田中です福し施設の夜きんを担当しています' }],
        });
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini 3.5 Transcribe uses the configured chat model only as a grounded formatting pass', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gemini-transcribe-postprocess-'));
    const audioPath = path.join(tempDir, 'hearing.m4a');
    fs.writeFileSync(audioPath, 'synthetic-audio-bytes');
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        if (requests.length === 1) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(geminiInteractionResponse('開廷します。', [
                    interactionWordInfo('開廷します。', '開廷します', 'spk_1', '0.500s', '1.200s'),
                ])),
            };
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                overview: { title: '期日' },
                                items: [{ speaker: '裁判官', time: '00:00', text: '開廷します。' }],
                            }),
                        }],
                    },
                }],
            }),
        };
    };

    try {
        const options = {
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            geminiApiKey: 'synthetic-test-key',
            geminiChatModel: 'configured-chat-model',
            language: 'ja',
            target: 'houhi',
            contextText: '裁判官が開廷を告げる。',
            postprocessAi: 'auto',
            silenceTrim: {},
        };
        const rawResult = await transcribeWithGemini(audioPath, options);
        const result = await postprocessTranscriptWithAi(audioPath, rawResult.items, options);
        assert.equal(requests.length, 2);
        assert.equal(
            new URL(requests[1].url).pathname,
            '/v1beta/models/configured-chat-model:generateContent',
        );
        const formattingBody = JSON.parse(requests[1].init.body);
        const formattingPrompt = formattingBody.contents[0].parts[0].text;
        assert.match(formattingPrompt, /"speaker": "話者1"/);
        assert.match(formattingPrompt, /"speaker_id": "spk_1"/);
        assert.match(formattingPrompt, /"end_time": "00:00:01\.200"/);
        assert.match(formattingPrompt, /本人の名乗り、他者からの呼びかけと直後の応答/);
        assert.match(formattingPrompt, /同じ音響話者IDには全項目で同じ speaker/);
        assert.deepEqual(result, {
            overview: { title: '期日' },
            items: [{ speaker: '裁判官', speakerId: 'spk_1', startMs: 500, endMs: 1200, time: '00:00:00.500', endTime: '00:00:01.200', text: '開廷します。' }],
        });
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Gemini postprocess applies one concrete inferred name consistently to each acoustic speaker', () => {
    const rawItems = [
        { speaker: '話者1', time: '00:01', text: '田中です。よろしくお願いします。' },
        { speaker: '話者2', time: '00:04', text: '田中さん、資料を確認しました。' },
        { speaker: '話者1', time: '00:08', text: 'ありがとうございます。' },
    ];
    const formattedItems = [
        { speaker: '田中', time: '99:99', text: '田中です。よろしくお願いします。' },
        { speaker: '佐藤', time: '99:99', text: '田中さん、資料を確認しました。' },
        { speaker: '話者1', time: '99:99', text: 'ありがとうございます。' },
    ];

    assert.deepEqual(
        anchorGeminiTranscribePostprocessItems(rawItems, formattedItems),
        [
            { speaker: '田中', time: '00:01', text: '田中です。よろしくお願いします。' },
            { speaker: '佐藤', time: '00:04', text: '田中さん、資料を確認しました。' },
            { speaker: '田中', time: '00:08', text: 'ありがとうございます。' },
        ],
    );
});

test('Gemini postprocess preserves chunk-local speaker identity and raw timestamps', async () => {
    const rawItems = [
        { speaker: '話者1（区間1）', time: '00:10', text: '第一の発言' },
        { speaker: '話者1（区間2）', time: '30:10', text: '第二の発言' },
    ];
    const originalFetch = global.fetch;
    let requestBody;
    global.fetch = async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                overview: {},
                                items: [
                                    { speaker: '裁判官', time: '99:99', text: '第一の発言。' },
                                    { speaker: '裁判官', time: '99:99', text: '第二の発言。' },
                                ],
                            }),
                        }],
                    },
                }],
            }),
        };
    };

    try {
        const result = await postprocessTranscriptWithAi('long-hearing.m4a', rawItems, {
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            geminiApiKey: 'synthetic-test-key',
            geminiChatModel: 'configured-chat-model',
            target: 'houhi',
            contextText: '',
            postprocessAi: 'auto',
        });
        const prompt = requestBody.contents[0].parts[0].text;
        assert.match(prompt, /話者1（区間1）/);
        assert.match(prompt, /区間番号は必ず同じ項目に残して/);
        assert.deepEqual(result.items, [
            { speaker: '裁判官（区間1）', time: '00:10', text: '第一の発言。' },
            { speaker: '裁判官（区間2）', time: '30:10', text: '第二の発言。' },
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Gemini postprocess applies speaker_map by id even when the chat response omits an item', async () => {
    const rawItems = [
        { speaker: 'spk:0', time: '00:01', text: '勤務状況を教えてください' },
        { speaker: 'spk:1', time: '00:04', text: '夜勤が多いです' },
        { speaker: 'spk:0', time: '00:08', text: '課題はありますか' },
    ];
    const originalFetch = global.fetch;
    let requestBody;
    global.fetch = async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                overview: { title: '勤務実態に関するインタビュー' },
                                speaker_map: {
                                    '話者1': 'インタビュアー',
                                    '話者2': '回答者',
                                },
                                items: [
                                    { id: 1, speaker: 'インタビュアー', time: '99:99', text: '勤務状況を教えてください。' },
                                    { id: 3, speaker: 'インタビュアー', time: '99:99', text: '課題はありますか。' },
                                ],
                            }),
                        }],
                    },
                }],
            }),
        };
    };

    try {
        const result = await postprocessTranscriptWithAi('welfare-interview.mp3', rawItems, {
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            geminiApiKey: 'synthetic-test-key',
            geminiChatModel: 'configured-chat-model',
            target: 'general',
            contextText: '',
            postprocessAi: 'auto',
        });
        const prompt = requestBody.contents[0].parts[0].text;
        assert.match(prompt, /"speaker_map"/);
        assert.match(prompt, /"id": 1/);
        assert.match(prompt, /インタビュアー/);
        assert.deepEqual(result.items, [
            { speaker: 'インタビュアー', time: '00:01', text: '勤務状況を教えてください。' },
            { speaker: '回答者', time: '00:04', text: '夜勤が多いです' },
            { speaker: 'インタビュアー', time: '00:08', text: '課題はありますか。' },
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

function twoHourTranscriptItems() {
    return Array.from({ length: 240 }, (_unused, index) => {
        const totalSeconds = index * 30;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const section = Math.floor(index / 60) + 1;
        const interviewer = index % 2 === 0;
        return {
            speaker: `話者${interviewer ? 1 : 2}（区間${section}）`,
            speakerId: `spk:${interviewer ? 0 : 1}`,
            speakerSection: section,
            time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
            endTime: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds + 1).padStart(2, '0')}`,
            startMs: totalSeconds * 1000,
            endMs: totalSeconds * 1000 + 1000,
            text: interviewer
                ? `福し施設における勤務実態について、質問${index + 1}に回答してください`
                : `夜きんを含む勤務実態について、回答${index + 1}を説明します`,
        };
    });
}

function geminiChatJsonPayload(payload) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
        }),
    };
}

function targetItemsFromCorrectionPrompt(prompt) {
    const marker = '# TARGET RAW CHUNKS JSON\n';
    const target = prompt.split(marker)[1];
    assert.ok(target, 'target chunks marker is present');
    return JSON.parse(target.split('\n# CONTEXT AFTER (DO NOT OUTPUT)')[0].trim());
}

test('two-hour transcripts use global speaker analysis and bounded correction batches', async () => {
    const rawItems = twoHourTranscriptItems();
    const batches = createTranscriptPostprocessBatches(rawItems);
    assert.equal(shouldChunkTranscriptPostprocess(rawItems), true);
    assert.ok(batches.length >= 3);
    assert.equal(batches.flatMap(batch => batch.items).length, rawItems.length);
    assert.ok(batches.every(batch => batch.items.length <= 50));

    const speakerMap = {};
    for (let section = 1; section <= 4; section++) {
        speakerMap[`spk:0（区間${section}）`] = 'インタビュアー';
        speakerMap[`spk:1（区間${section}）`] = '回答者';
    }
    const options = {
        provider: 'gemini',
        model: 'gemini-3.5-transcribe',
        geminiApiKey: 'synthetic-test-key',
        geminiChatModel: 'configured-chat-model',
        target: 'general',
        contextText: '',
        postprocessAi: 'auto',
    };
    const contextPrompt = buildTranscriptContextPrompt('two-hour-interview.mp3', rawItems, options);
    assert.match(contextPrompt, /全体コンテキストと話者対応/);
    assert.match(contextPrompt, /"total_items":240/);
    assert.match(contextPrompt, /話者2（区間4）/);

    const originalFetch = global.fetch;
    const prompts = [];
    global.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        const prompt = request.contents[0].parts[0].text;
        prompts.push(prompt);
        if (prompt.includes('# TRANSCRIPT CONTEXT JSON')) {
            return geminiChatJsonPayload({
                overview: { title: '福祉施設における勤務実態インタビュー' },
                speaker_map: speakerMap,
                context_summary: 'インタビュアーが福祉施設の勤務実態を質問し、回答者が夜勤を含む実情を説明する。',
                terminology: ['福祉施設', '夜勤'],
            });
        }
        const targetItems = targetItemsFromCorrectionPrompt(prompt);
        return geminiChatJsonPayload({
            overview: {},
            items: targetItems.map(item => ({
                ...item,
                // A later correction batch must not be able to reverse the
                // globally fixed acoustic-ID mapping.
                speaker: item.speaker_id === 'spk:0' ? '回答者' : 'インタビュアー',
                text: item.text.replace(/福し施設/g, '福祉施設').replace(/夜きん/g, '夜勤') + '。',
            })),
        });
    };

    try {
        const result = await postprocessTranscriptWithAi('two-hour-interview.mp3', rawItems, options);
        assert.equal(prompts.length, batches.length + 1);
        assert.equal(prompts.filter(prompt => prompt.includes('# TRANSCRIPT CONTEXT JSON')).length, 1);
        assert.equal(prompts.filter(prompt => prompt.includes('# TARGET RAW CHUNKS JSON')).length, batches.length);
        assert.ok(prompts.slice(1).every(prompt => prompt.includes('# GLOBAL CONTEXT')));
        assert.equal(result.items.length, rawItems.length);
        assert.deepEqual(result.items.map(item => item.time), rawItems.map(item => item.time));
        assert.deepEqual(result.items.map(item => item.endTime), rawItems.map(item => item.endTime));
        assert.deepEqual(result.items.map(item => item.speakerId), rawItems.map(item => item.speakerId));
        assert.ok(result.items.every(item => item.speaker === 'インタビュアー' || item.speaker === '回答者'));
        assert.ok(result.items.every(item => item.speaker === (item.speakerId === 'spk:0' ? 'インタビュアー' : '回答者')));
        assert.ok(result.items.every(item => !/福し施設|夜きん/.test(item.text)));
        assert.equal(result.overview.title, '福祉施設における勤務実態インタビュー');
    } finally {
        global.fetch = originalFetch;
    }
});

test('a failed long-transcript correction batch preserves every utterance and still applies the global speaker map', async () => {
    const rawItems = twoHourTranscriptItems();
    const speakerMap = {};
    for (let section = 1; section <= 4; section++) {
        speakerMap[`話者1（区間${section}）`] = 'インタビュアー';
        speakerMap[`話者2（区間${section}）`] = '回答者';
    }
    const originalFetch = global.fetch;
    let correctionBatch = 0;
    global.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        const prompt = request.contents[0].parts[0].text;
        if (prompt.includes('# TRANSCRIPT CONTEXT JSON')) {
            return geminiChatJsonPayload({ speaker_map: speakerMap, overview: {}, terminology: [] });
        }
        correctionBatch++;
        if (correctionBatch === 2) return geminiChatJsonPayload({ invalid: true });
        const targetItems = targetItemsFromCorrectionPrompt(prompt);
        return geminiChatJsonPayload({
            items: targetItems.map(item => ({ ...item, speaker: speakerMap[item.speaker], text: `${item.text}。` })),
        });
    };

    try {
        const result = await postprocessTranscriptWithAi('two-hour-interview.mp3', rawItems, {
            provider: 'gemini',
            model: 'gemini-3.5-transcribe',
            geminiApiKey: 'synthetic-test-key',
            geminiChatModel: 'configured-chat-model',
            target: 'general',
            contextText: '',
            postprocessAi: 'auto',
        });
        assert.equal(result.items.length, rawItems.length);
        assert.deepEqual(result.items.map(item => item.time), rawItems.map(item => item.time));
        assert.ok(result.items.every(item => item.speaker === 'インタビュアー' || item.speaker === '回答者'));
        const failedBatch = createTranscriptPostprocessBatches(rawItems)[1];
        assert.equal(result.items[failedBatch.startIndex].text, rawItems[failedBatch.startIndex].text);
        assert.equal(result.items[failedBatch.startIndex - 1].text, `${rawItems[failedBatch.startIndex - 1].text}。`);
    } finally {
        global.fetch = originalFetch;
    }
});

test('an invalid OpenAI Chat API key aborts both short and long postprocessing instead of reporting success', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
            error: { message: 'Incorrect API key provided: sk-invalid-secret-value' },
        }),
    });
    const options = {
        provider: 'gemini',
        model: 'gemini-3.5-transcribe',
        geminiApiKey: 'synthetic-gemini-key',
        openaiApiKey: 'sk-invalid-secret-value',
        openaiBaseUrl: 'https://example.test/v1/chat/completions',
        openaiChatModel: 'gpt-5.6-sol',
        target: 'general',
        contextText: '',
        postprocessAi: 'openai',
    };
    const shortItems = [{
        speaker: '話者1',
        speakerId: 'spk:0',
        startMs: 100,
        endMs: 500,
        time: '00:00:00.100',
        endTime: '00:00:00.500',
        text: '確認します。',
    }];

    try {
        for (const items of [shortItems, twoHourTranscriptItems()]) {
            await assert.rejects(
                () => postprocessTranscriptWithAi('invalid-key-test.mp3', items, options),
                err => {
                    assert.equal(err.code, 'MIMI_TEXT_AI_REQUEST_FAILED');
                    assert.equal(err.status, 401);
                    assert.match(err.message, /OpenAI Chat API .*HTTP 401/);
                    assert.match(err.message, /sk-\*\*\*/);
                    assert.doesNotMatch(err.message, /invalid-secret-value/);
                    return true;
                },
            );
        }
    } finally {
        global.fetch = originalFetch;
    }
});
