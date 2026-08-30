const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
    normalizeAudioModelSelection,
    migrateAudioGuiState,
    parseAudioModelSelection,
    resolveAudioExecutionOptions,
} = require('../dist/src/gui/audio_model_state.js');
const {
    getMimeType,
    isGeminiTranscribeModel,
    geminiTranscriptionLanguageCodes,
    buildGeminiTranscribeRequest,
    parseGeminiTranscribeResponse,
    shouldSplitGeminiAudio,
    requiresGeminiTranscribeConversion,
    namespaceGeminiChunkSpeakers,
    transcribeWithGemini,
    transcribePreparedAudio,
    postprocessTranscriptWithAi,
    anchorGeminiTranscribePostprocessItems,
    normalizeOptions,
} = require('../dist/src/transcribe_audio.js');

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
        batchSize: '7',
        contextText: '固有名詞',
    });
    assert.equal(migrateAudioGuiState({ currentAudioPostprocess: false }).currentAudioPostprocess, false);
    assert.deepEqual(parseAudioModelSelection('openai:auto'), {
        provider: 'openai',
        model: 'auto',
    });
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
});

test('built GUI no longer embeds cloud transcription model IDs in provider buttons', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'src', 'gui', 'index.html'), 'utf8');
    assert.match(html, /data-audio-model="gemini:auto">Gemini<\/button>/);
    assert.match(html, /data-audio-model="openai:auto">OpenAI<\/button>/);
    assert.doesNotMatch(html, /data-audio-model="gemini:gemini-3\.5-flash"/);
    assert.doesNotMatch(html, /data-audio-model="openai:gpt-4o-transcribe-diarize"/);
    assert.match(html, /id="audioPostprocessCheckbox" checked/);
    assert.match(html, />Chat APIで全体補正<\/span>/);
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
        { speaker: '話者1（区間2）', time: '00:01', text: '発言' },
        { speaker: '話者不明', time: '', text: '不明' },
    ]);
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
        { speaker: '話者1', time: '00:00', text: 'こんにちは。' },
        { speaker: '話者1', time: '00:01', text: '次の文です。' },
        { speaker: '話者2', time: '00:02', text: 'Hello world.' },
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
            { speaker: '話者1', time: '00:01', text: '確認。' },
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
                        items: [{ speaker: '話者1', time: '00:01', text: '田中ですよろしくお願いします' }],
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
                                items: [{ speaker: '田中', time: '00:01', text: '田中です。よろしくお願いします。' }],
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
        assert.deepEqual(enabled.result, {
            overview: { place: '会議室', title: '勤務実態インタビュー' },
            items: [{ speaker: '田中', time: '00:01', text: '田中です。よろしくお願いします。' }],
        });

        const disabled = await run('off');
        assert.equal(disabled.requests.length, 1);
        assert.deepEqual(disabled.result, {
            overview: { place: '会議室' },
            items: [{ speaker: '話者1', time: '00:01', text: '田中ですよろしくお願いします' }],
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
        assert.match(formattingPrompt, /本人の名乗り、他者からの呼びかけと直後の応答/);
        assert.match(formattingPrompt, /同じ音響話者IDには全項目で同じ speaker/);
        assert.deepEqual(result, {
            overview: { title: '期日' },
            items: [{ speaker: '裁判官', time: '00:00', text: '開廷します。' }],
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
