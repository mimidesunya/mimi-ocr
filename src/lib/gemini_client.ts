const fs = require('fs');
const path = require('path');

const FALLBACK_APP_DEFAULTS = {
    providers: {
        gemini: { chatModel: 'gemini-2.5-flash-preview', transcriptionModel: 'gemini-3.5-flash' },
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
    const gemini = getProviderConfig('gemini');
    if (gemini?.chatModel) {
        return gemini.chatModel;
    }
    if (process.env.GEMINI_CHAT_MODEL) {
        return process.env.GEMINI_CHAT_MODEL;
    }
    throw new Error('Gemini chat model is not configured. Set providers.gemini.chatModel in config.json or GEMINI_CHAT_MODEL.');
}

module.exports = {
    findConfigPath,
    findAppDefaultsPath,
    getProjectRoot,
    loadAppDefaults,
    loadUserConfig,
    loadConfig,
    getProviderConfig,
    getToolConfig,
    getApiKey,
    getGeminiChatModel
};
