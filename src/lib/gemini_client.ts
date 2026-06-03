const fs = require('fs');
const path = require('path');

function findConfigPath() {
    const startDirs = [process.cwd(), __dirname, path.dirname(process.execPath)].filter(Boolean);
    const visited = new Set();

    for (const startDir of startDirs) {
        let currentDir = path.resolve(startDir);
        while (!visited.has(currentDir)) {
            visited.add(currentDir);
            const configPath = path.join(currentDir, 'config.json');
            if (fs.existsSync(configPath)) {
                return configPath;
            }
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                break;
            }
            currentDir = parentDir;
        }
    }

    return null;
}

function getProjectRoot() {
    const configPath = findConfigPath();
    if (configPath) {
        return path.dirname(configPath);
    }
    return process.cwd();
}

function loadConfig() {
    const configPath = findConfigPath();
    if (!configPath || !fs.existsSync(configPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`Config load error: ${err}`);
        return null;
    }
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
    getProjectRoot,
    loadConfig,
    getProviderConfig,
    getToolConfig,
    getApiKey,
    getGeminiChatModel
};
