const fs = require('fs');
const path = require('path');

const DEFAULT_GEMINI_CHAT_MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash'
];
const RECOMMENDED_GEMINI_FALLBACK_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite'
];

const FALLBACK_APP_DEFAULTS = {
    providers: {
        gemini: {
            chatModel: DEFAULT_GEMINI_CHAT_MODELS[0],
            chatModels: DEFAULT_GEMINI_CHAT_MODELS,
            transcriptionModel: 'gemini-3.5-transcribe'
        },
        openai: { chatModel: 'gpt-4o', transcriptionModel: 'gpt-4o-transcribe-diarize' },
        claude: { chatModel: 'claude-opus-4-8' }
    },
    ocr: {
        provider: 'gemini',
        target: 'general',
        mode: 'sync',
        batchSize: 4,
        ndlocr: 'pre',
        preferPdfText: false,
        autoRename: false,
        skipFormattedRename: false
    },
    transcription: {
        provider: 'gemini',
        language: 'ja',
        target: 'general',
        mode: 'sync',
        batchSize: 4,
        autoRename: false,
        skipFormattedRename: false,
        postprocessAi: 'auto',
        reazonLanguage: 'ja',
        reazonDevice: 'cpu',
        reazonPrecision: 'fp32',
        reazonChunkSec: 25,
        vibeVoiceThreads: 4,
        vibeVoiceChunkSec: 1200,
        silenceTrim: {
            enabled: false,
            thresholdDb: -35,
            minSilenceSec: 1,
            paddingSec: 0.2,
            outputFormat: 'm4a',
            outputBitrate: '96k'
        }
    },
    tools: {
        rootDir: '',
        ndlocrLite: {
            parallelJobs: 'auto',
            pageChunkSize: 8,
            imageDpi: 300
        },
        stitchEngine: {
            imageDpi: 'auto',
            deskew: 'auto',
            pdfImageFormat: 'jpeg',
            jpegQuality: 0.86
        },
        reazonK2: {
            pythonPath: '',
            basePythonPath: '',
            language: 'ja',
            device: 'cpu',
            precision: 'fp32',
            chunkSeconds: 25,
            autoInstall: true,
            cacheDir: ''
        },
        vibeVoiceAsr: {
            binaryPath: '',
            vaeModelPath: '',
            lmModelPath: '',
            sourceDir: '',
            modelDir: '',
            modelId: 'microsoft/VibeVoice-ASR-BitNet',
            threads: 4,
            chunkSeconds: 1200,
            autoInstall: true,
            cCompiler: '',
            cxxCompiler: '',
            makePath: ''
        }
    }
};

function findUpFile(fileName) {
    const envConfigDir = process.env.MIMI_OCR_CONFIG_DIR;
    if (envConfigDir) {
        const candidate = path.join(path.resolve(envConfigDir), fileName);
        if (fs.existsSync(candidate)) return candidate;
    }

    const envProjectRoot = process.env.MIMI_OCR_PROJECT_ROOT;
    const startDirs = [envProjectRoot, process.cwd(), __dirname, path.dirname(process.execPath)].filter(Boolean);
    const visited = new Set();

    for (const startDir of startDirs) {
        let currentDir = path.resolve(startDir);
        while (!visited.has(currentDir)) {
            visited.add(currentDir);
            const candidate = path.join(currentDir, fileName);
            if (fs.existsSync(candidate)) return candidate;
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                break;
            }
            currentDir = parentDir;
        }
    }

    return null;
}

function findConfigPath() {
    const envConfigPath = process.env.MIMI_OCR_CONFIG;
    if (envConfigPath && fs.existsSync(envConfigPath)) {
        return path.resolve(envConfigPath);
    }
    return findUpFile('config.json');
}

function findAppDefaultsPath() {
    return findUpFile('app.defaults.json');
}

function readJsonFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`Config load error: ${err}`);
        return null;
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
    const result = cloneJson(base || {});
    if (!isPlainObject(override)) return result;

    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = mergeConfig(result[key], value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

function getProjectRoot() {
    const envProjectRoot = process.env.MIMI_OCR_PROJECT_ROOT;
    if (envProjectRoot) {
        const resolved = path.resolve(envProjectRoot);
        if (fs.existsSync(path.join(resolved, 'package.json')) || fs.existsSync(path.join(resolved, 'app.defaults.json'))) {
            return resolved;
        }
    }

    const configPath = findConfigPath();
    if (configPath) {
        return path.dirname(configPath);
    }
    const defaultsPath = findAppDefaultsPath();
    if (defaultsPath) {
        return path.dirname(defaultsPath);
    }
    return process.cwd();
}

function loadAppDefaults() {
    const defaultsPath = findAppDefaultsPath();
    if (!defaultsPath || !fs.existsSync(defaultsPath)) {
        return cloneJson(FALLBACK_APP_DEFAULTS);
    }
    return mergeConfig(FALLBACK_APP_DEFAULTS, readJsonFile(defaultsPath) || {});
}

function loadUserConfig() {
    const configPath = findConfigPath();
    if (!configPath || !fs.existsSync(configPath)) {
        return null;
    }
    return readJsonFile(configPath);
}

function loadConfig() {
    return mergeConfig(loadAppDefaults(), loadUserConfig() || {});
}

function getProviderConfig(providerName) {
    const config = loadConfig();
    if (!config || !config.providers) {
        return null;
    }
    return config.providers[providerName] || null;
}

function normalizeModelPriority(value, limit = 3) {
    const rawValues = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(',') : []);
    const models = [];
    const seen = new Set();
    for (const rawValue of rawValues) {
        const model = String(rawValue || '').trim();
        if (!model || seen.has(model)) continue;
        seen.add(model);
        models.push(model);
        if (models.length >= limit) break;
    }
    return models;
}

function fillModelPriority(primaryModels, fallbackModels, limit = 3) {
    return normalizeModelPriority([
        ...normalizeModelPriority(primaryModels, limit),
        ...normalizeModelPriority(fallbackModels, limit)
    ], limit);
}

function getGeminiChatModels() {
    const userGemini = loadUserConfig()?.providers?.gemini || {};
    const defaultsGemini = loadAppDefaults()?.providers?.gemini || {};
    const defaultModels = fillModelPriority(
        defaultsGemini.chatModels,
        [defaultsGemini.chatModel, ...DEFAULT_GEMINI_CHAT_MODELS]
    );

    const configuredModels = normalizeModelPriority(userGemini.chatModels);
    if (configuredModels.length > 0) return configuredModels;

    const configuredLegacyModel = String(userGemini.chatModel || '').trim();
    if (configuredLegacyModel) {
        return fillModelPriority(
            [configuredLegacyModel],
            [...RECOMMENDED_GEMINI_FALLBACK_MODELS, ...defaultModels]
        );
    }

    const envModels = normalizeModelPriority(process.env.GEMINI_CHAT_MODELS);
    if (envModels.length > 0) return envModels;

    const envLegacyModel = String(process.env.GEMINI_CHAT_MODEL || '').trim();
    if (envLegacyModel) {
        return fillModelPriority(
            [envLegacyModel],
            [...RECOMMENDED_GEMINI_FALLBACK_MODELS, ...defaultModels]
        );
    }

    return defaultModels;
}

function getProviderModel(providerName, modelType = 'chat') {
    const normalizedProvider = String(providerName || '').trim().toLowerCase();
    const modelKey = modelType === 'transcription' ? 'transcriptionModel' : 'chatModel';
    if (normalizedProvider === 'gemini' && modelKey === 'chatModel') {
        return getGeminiChatModels()[0] || '';
    }
    const provider = getProviderConfig(normalizedProvider) || {};
    const configuredModel = String(provider[modelKey] || '').trim();
    if (configuredModel) {
        return configuredModel;
    }

    const fallbackProvider = FALLBACK_APP_DEFAULTS.providers[normalizedProvider] || {};
    return String(fallbackProvider[modelKey] || '').trim();
}

function getToolConfig(toolName) {
    const config = loadConfig();
    if (!config || !config.tools) {
        return null;
    }
    return config.tools[toolName] || null;
}

function getApiKey() {
    const gemini = getProviderConfig('gemini');
    if (gemini?.apiKey) {
        return gemini.apiKey;
    }
    return process.env.GEMINI_API_KEY;
}

function getGeminiChatModel() {
    const model = getGeminiChatModels()[0];
    if (model) return model;
    throw new Error('Gemini chat model is not configured. Set providers.gemini.chatModels in config.json or GEMINI_CHAT_MODELS.');
}

module.exports = {
    findConfigPath,
    findAppDefaultsPath,
    getProjectRoot,
    loadAppDefaults,
    loadUserConfig,
    loadConfig,
    getProviderConfig,
    getProviderModel,
    normalizeModelPriority,
    getGeminiChatModels,
    getToolConfig,
    getApiKey,
    getGeminiChatModel
};
