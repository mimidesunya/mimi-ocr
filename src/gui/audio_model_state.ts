type AudioModelSelection = {
    provider: 'gemini' | 'openai' | 'reazon-k2' | 'vibevoice-asr';
    model: string;
    postprocessAi?: string;
    postprocessModel?: string;
};

type AudioExecutionOptions = AudioModelSelection;

const DEFAULT_AUDIO_MODEL_SELECTION = 'gemini:auto';
const DEFAULT_AUDIO_CHAT_MODEL_SELECTION = 'auto:auto';
const DEFAULT_OCR_MODEL_SELECTION = 'gemini:auto';
const LEGACY_AUDIO_MODEL_SELECTIONS: Record<string, string> = {
    'gemini:gemini-3.5-flash': 'gemini:auto',
    'openai:gpt-4o-transcribe-diarize': 'openai:auto',
};

function normalizeReazonLanguage(value: any) {
    const text = String(value || '').trim().toLowerCase();
    return text === 'ja-en' || text === 'ja-en-mls-5k' ? text : 'ja';
}

function normalizePostprocessAi(value: any, fallback: string) {
    const text = String(value || '').trim().toLowerCase();
    return ['auto', 'gemini', 'openai', 'off'].includes(text) ? text : fallback;
}

function splitProviderModelSelection(value: any) {
    const raw = String(value || '').trim();
    const separatorIndex = raw.indexOf(':');
    if (separatorIndex < 0) return [raw, ''];
    return [raw.slice(0, separatorIndex), raw.slice(separatorIndex + 1)];
}

function normalizeAudioChatModelSelection(value: any) {
    const [rawProvider, rawModel] = splitProviderModelSelection(value);
    const provider = String(rawProvider || '').trim().toLowerCase();
    const model = String(rawModel || '').trim() || 'auto';
    if (provider === 'gemini' || provider === 'openai') {
        return `${provider}:${model}`;
    }
    return DEFAULT_AUDIO_CHAT_MODEL_SELECTION;
}

function normalizeOcrModelSelection(value: any) {
    const [rawProvider, rawModel] = splitProviderModelSelection(value);
    const provider = String(rawProvider || '').trim().toLowerCase();
    const model = String(rawModel || '').trim() || 'auto';
    if (provider === 'gemini' || provider === 'claude' || provider === 'openai') {
        return `${provider}:${model}`;
    }
    return DEFAULT_OCR_MODEL_SELECTION;
}

function parseOcrModelSelection(value: any) {
    const [provider, model] = splitProviderModelSelection(normalizeOcrModelSelection(value));
    return {
        provider,
        model: String(model || 'auto').trim() || 'auto',
    };
}

function parseAudioChatModelSelection(value: any) {
    const [provider, model] = splitProviderModelSelection(normalizeAudioChatModelSelection(value));
    if (provider === 'gemini' || provider === 'openai') {
        return {
            postprocessAi: provider,
            ...(model && model !== 'auto' ? { postprocessModel: model } : {}),
        };
    }
    return { postprocessAi: 'auto' };
}

function normalizeAudioModelSelection(value: any) {
    const raw = String(value || '').trim();
    const migrated = LEGACY_AUDIO_MODEL_SELECTIONS[raw] || raw;
    const [provider, model, postprocessAi] = migrated.split(':');

    if (provider === 'gemini' || provider === 'openai') {
        return `${provider}:${String(model || 'auto').trim() || 'auto'}`;
    }
    if (provider === 'reazon-k2') {
        return `reazon-k2:${normalizeReazonLanguage(model)}:${normalizePostprocessAi(postprocessAi, 'auto')}`;
    }
    if (provider === 'vibevoice-asr') {
        return `vibevoice-asr:auto:${normalizePostprocessAi(postprocessAi, 'off')}`;
    }
    return DEFAULT_AUDIO_MODEL_SELECTION;
}

function migrateAudioGuiState(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return {
        ...value,
        currentAudioModel: normalizeAudioModelSelection(value.currentAudioModel),
        currentAudioPostprocess: value.currentAudioPostprocess !== false,
        currentAudioChatModel: normalizeAudioChatModelSelection(value.currentAudioChatModel),
        currentOcrModel: normalizeOcrModelSelection(
            value.currentOcrModel || `${String(value.currentAiProvider || 'gemini').trim()}:auto`,
        ),
    };
}

function parseAudioModelSelection(value: any): AudioModelSelection {
    const [provider, model, postprocessAi] = normalizeAudioModelSelection(value).split(':');
    if (provider === 'reazon-k2') {
        return {
            provider: 'reazon-k2',
            model: normalizeReazonLanguage(model),
            postprocessAi: normalizePostprocessAi(postprocessAi, 'auto'),
        };
    }
    if (provider === 'vibevoice-asr') {
        return {
            provider: 'vibevoice-asr',
            model: 'auto',
            postprocessAi: normalizePostprocessAi(postprocessAi, 'off'),
        };
    }
    return {
        provider: provider === 'gemini' ? 'gemini' : 'openai',
        model: String(model || 'auto').trim() || 'auto',
    };
}

function resolveAudioExecutionOptions(
    audioOptions: any,
    getProviderModel: (provider: string, modelType: string) => string,
): AudioExecutionOptions {
    const provider = String(audioOptions?.provider || 'gemini').trim().toLowerCase();
    const postprocessAi = String(audioOptions?.postprocessAi || '').trim();
    const supportsPostprocessSelection = provider === 'reazon-k2' || provider === 'vibevoice-asr';
    const serializedSelection = [
        provider,
        String(audioOptions?.model || 'auto'),
        ...(supportsPostprocessSelection && postprocessAi ? [postprocessAi] : []),
    ].join(':');
    const selection = parseAudioModelSelection(serializedSelection);
    const resolvedPostprocessAi = normalizePostprocessAi(
        postprocessAi || selection.postprocessAi,
        selection.provider === 'vibevoice-asr' ? 'off' : 'auto',
    );
    const requestedPostprocessModel = String(audioOptions?.postprocessModel || '').trim();
    const resolvedPostprocessModel = (resolvedPostprocessAi === 'gemini' || resolvedPostprocessAi === 'openai')
        ? requestedPostprocessModel || getProviderModel(resolvedPostprocessAi, 'chat')
        : '';
    const requestedModel = String(selection.model || '').trim();
    const useConfiguredModel = !requestedModel || requestedModel.toLowerCase() === 'auto';

    if (selection.provider === 'gemini') {
        return {
            ...selection,
            postprocessAi: resolvedPostprocessAi,
            ...(resolvedPostprocessModel ? { postprocessModel: resolvedPostprocessModel } : {}),
            model: useConfiguredModel
                ? getProviderModel('gemini', 'transcription') || 'gemini-3.5-transcribe'
                : requestedModel,
        };
    }
    if (selection.provider === 'openai') {
        return {
            ...selection,
            postprocessAi: resolvedPostprocessAi,
            ...(resolvedPostprocessModel ? { postprocessModel: resolvedPostprocessModel } : {}),
            model: useConfiguredModel
                ? getProviderModel('openai', 'transcription') || 'gpt-4o-transcribe-diarize'
                : requestedModel,
        };
    }
    return {
        ...selection,
        postprocessAi: resolvedPostprocessAi,
        ...(resolvedPostprocessModel ? { postprocessModel: resolvedPostprocessModel } : {}),
    };
}

const audioModelStateApi = {
    DEFAULT_AUDIO_MODEL_SELECTION,
    DEFAULT_AUDIO_CHAT_MODEL_SELECTION,
    DEFAULT_OCR_MODEL_SELECTION,
    normalizeAudioModelSelection,
    normalizeAudioChatModelSelection,
    normalizeOcrModelSelection,
    migrateAudioGuiState,
    parseAudioModelSelection,
    parseAudioChatModelSelection,
    parseOcrModelSelection,
    resolveAudioExecutionOptions,
};

if (typeof window !== 'undefined') {
    (window as any).mimiAudioModelState = audioModelStateApi;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = audioModelStateApi;
}
