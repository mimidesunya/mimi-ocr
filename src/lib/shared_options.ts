const fs = require('fs');
const path = require('path');

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function normalizeTarget(value) {
    return String(value || '').toLowerCase() === 'houhi' ? 'houhi' : 'general';
}

function normalizeMode(value) {
    return String(value || '').toLowerCase() === 'batch' ? 'batch' : 'sync';
}

function readOptionalTextFile(filePath, label = 'コンテキストファイル') {
    const textPath = String(filePath || '').trim();
    if (!textPath) return '';
    const resolved = path.resolve(textPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`${label}が見つかりません: ${resolved}`);
    }
    return fs.readFileSync(resolved, 'utf-8').trim();
}

function compactTextParts(...parts) {
    return parts
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join('\n\n');
}

function buildAdditionalContextInstruction(contextText) {
    const trimmed = String(contextText || '').trim();
    if (!trimmed) return '';
    return `
# ADDITIONAL CONTEXT
Use the following context as hints for names, roles, dates, case names, terminology, and expected labels. Apply it only when it matches the visible or audible content. Do not invent content that is not present.

${trimmed}
`;
}

function getPathKey(filePath) {
    return path.resolve(filePath).toLowerCase();
}

module.exports = {
    parsePositiveInt,
    normalizeTarget,
    normalizeMode,
    readOptionalTextFile,
    compactTextParts,
    buildAdditionalContextInstruction,
    getPathKey,
};
