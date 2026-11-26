/**
 * AI の利用量（トークン）と概算費用。
 *
 * 個人の利用者が「いくらかかるか」を実行前に目安で、実行後に実数で知れるようにする。
 * 単価は app.defaults.json の pricing（モデルごとの 100 万トークンあたりの米ドル、基準日つき）で、
 * config.json の pricing で上書きできる。単価の無いモデルはトークン数だけを出す。
 * 応答は provider を問わず Gemini 形式の usageMetadata に揃えて渡す
 * （promptTokenCount・candidatesTokenCount・thoughtsTokenCount）。
 */
const { loadAppDefaults, loadUserConfig } = require('./gemini_client');

type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

function getPricingTable() {
    const defaults = loadAppDefaults()?.pricing || {};
    const user = loadUserConfig()?.pricing || {};
    const models = { ...(defaults.models || {}), ...(user.models || {}) };
    return {
        asOf: user.asOf || defaults.asOf || null,
        currency: 'USD',
        models
    };
}

function findModelPrice(modelId, table = getPricingTable()): ModelPrice | null {
    const id = String(modelId || '').trim();
    if (!id) return null;
    const models = table.models || {};
    if (models[id]) return models[id];
    // 「models/gemini-…」や日付つきの版名も、いちばん長く一致する名前の単価を使う。
    const bare = id.replace(/^models\//, '');
    const candidates = Object.keys(models).filter(name => bare === name || bare.startsWith(`${name}-`));
    candidates.sort((a, b) => b.length - a.length);
    return candidates.length > 0 ? models[candidates[0]] : null;
}

function readUsageMetadata(response) {
    const usage = response?.usageMetadata;
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.promptTokenCount || 0);
    // 考える段のトークンも出力として課金される。
    const output = Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0);
    if (!Number.isFinite(input) || !Number.isFinite(output) || (input <= 0 && output <= 0)) return null;
    return { inputTokens: input, outputTokens: output };
}

class UsageMeter {
    byModel: Map<string, { requests: number; inputTokens: number; outputTokens: number }>;

    constructor() {
        this.byModel = new Map();
    }

    addResponse(modelId, response) {
        const usage = readUsageMetadata(response);
        if (!usage) return false;
        this.addTokens(modelId, usage.inputTokens, usage.outputTokens);
        return true;
    }

    addTokens(modelId, inputTokens, outputTokens) {
        const key = String(modelId || 'unknown');
        const entry = this.byModel.get(key) || { requests: 0, inputTokens: 0, outputTokens: 0 };
        entry.requests += 1;
        entry.inputTokens += Number(inputTokens) || 0;
        entry.outputTokens += Number(outputTokens) || 0;
        this.byModel.set(key, entry);
    }

    isEmpty() {
        return this.byModel.size === 0;
    }

    /** metadata に残す形。単価の無いモデルがあれば estimatedUsd は単価のある分だけで、unpricedModels に名前を出す。 */
    summary(table = getPricingTable()) {
        if (this.isEmpty()) return null;
        const models = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let estimatedUsd = 0;
        const unpricedModels = [];
        for (const [model, entry] of this.byModel) {
            const price = findModelPrice(model, table);
            const usd = price
                ? (entry.inputTokens * Number(price.inputPerMTok) + entry.outputTokens * Number(price.outputPerMTok)) / 1e6
                : null;
            if (usd === null) unpricedModels.push(model);
            else estimatedUsd += usd;
            inputTokens += entry.inputTokens;
            outputTokens += entry.outputTokens;
            models.push({ model, ...entry, estimatedUsd: usd === null ? null : roundUsd(usd) });
        }
        return {
            inputTokens,
            outputTokens,
            estimatedUsd: roundUsd(estimatedUsd),
            pricingAsOf: table.asOf,
            unpricedModels: unpricedModels.length > 0 ? unpricedModels : null,
            models
        };
    }
}

function roundUsd(value) {
    return Math.round(Number(value) * 10000) / 10000;
}

// 実行前の目安。画像1頁の入力と1頁あたりの出力は、2026-11 の裁判書面の実測に近い値に置く。
const ESTIMATE_INPUT_TOKENS_PER_PAGE = 1600;
const ESTIMATE_OUTPUT_TOKENS_PER_PAGE = 1100;
const ESTIMATE_PROMPT_TOKENS_PER_REQUEST = 900;

function estimateOcrCost(modelId, pageCount, batchSize = 4, table = getPricingTable()) {
    const pages = Math.max(0, Number(pageCount) || 0);
    const requests = Math.ceil(pages / Math.max(1, Number(batchSize) || 1));
    const inputTokens = pages * ESTIMATE_INPUT_TOKENS_PER_PAGE + requests * ESTIMATE_PROMPT_TOKENS_PER_REQUEST;
    const outputTokens = pages * ESTIMATE_OUTPUT_TOKENS_PER_PAGE;
    const price = findModelPrice(modelId, table);
    return {
        model: modelId,
        pages,
        inputTokens,
        outputTokens,
        estimatedUsd: price
            ? roundUsd((inputTokens * Number(price.inputPerMTok) + outputTokens * Number(price.outputPerMTok)) / 1e6)
            : null,
        pricingAsOf: table.asOf
    };
}

function formatUsd(value) {
    if (value === null || value === undefined) return '単価未設定';
    if (value < 0.01) return `$${Number(value).toFixed(4)}`;
    return `$${Number(value).toFixed(2)}`;
}

function formatUsageSummary(summary) {
    if (!summary) return '';
    const unpriced = summary.unpricedModels ? `（単価未設定: ${summary.unpricedModels.join(', ')}）` : '';
    return `入力 ${summary.inputTokens.toLocaleString()} / 出力 ${summary.outputTokens.toLocaleString()} トークン、` +
        `概算 ${formatUsd(summary.estimatedUsd)}${unpriced}（単価の基準日 ${summary.pricingAsOf || '不明'}）`;
}

module.exports = {
    UsageMeter,
    readUsageMetadata,
    findModelPrice,
    getPricingTable,
    estimateOcrCost,
    formatUsd,
    formatUsageSummary
};
