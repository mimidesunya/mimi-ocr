const fs = require('fs');
const v8 = require('v8');
const { parsePositiveInt } = require('./shared_options');

const DEFAULT_MAX_CONCURRENT_FILES = 32;
const MB = 1024 * 1024;

/**
 * バッチモードで同時に処理するファイルの上限。
 *
 * バッチモードでは1ファイルが1つのバッチジョブになり、送信した要求（画像やPDFの base64）を
 * ジョブの完了まで保持する。さらに送信時には大きさの見積もりと SDK の本文作成で同じ大きさの
 * 文字列が一時的にできるため、ヒープの消費は処理中のファイルの合計サイズの約3倍になる。
 * 合計サイズの目安をヒープ上限の 1/8 に抑え、上限 4GB でも約半分で収まるようにする。
 */
function getBatchFileLimits(env = process.env) {
    const heapLimitMb = Math.floor(v8.getHeapStatistics().heap_size_limit / MB);
    const maxConcurrent = parsePositiveInt(env.MIMI_OCR_BATCH_FILE_CONCURRENCY, DEFAULT_MAX_CONCURRENT_FILES);
    const budgetMb = parsePositiveInt(env.MIMI_OCR_BATCH_MEMORY_BUDGET_MB, Math.max(64, Math.floor(heapLimitMb / 8)));
    return { maxConcurrent, budgetBytes: budgetMb * MB };
}

function getFileSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    } catch (_e) {
        return 0;
    }
}

/**
 * items を先頭から順に worker へ渡す。同時実行は maxConcurrent 件まで、
 * 実行中の weight の合計は budgetBytes まで。budgetBytes を超える1件は単独で実行する。
 * worker の例外は全件の終了後に最初のものを投げる。
 */
async function runWithinBudget(items, limits, weightOf, worker) {
    const maxConcurrent = Math.max(1, limits.maxConcurrent);
    const budgetBytes = Math.max(0, limits.budgetBytes);
    const weights = items.map(item => Math.max(0, Number(weightOf(item)) || 0));
    let next = 0;
    let running = 0;
    let runningBytes = 0;
    let firstError = null;

    await new Promise<void>(resolve => {
        const pump = () => {
            while (
                next < items.length &&
                running < maxConcurrent &&
                (running === 0 || runningBytes + weights[next] <= budgetBytes)
            ) {
                const index = next++;
                running++;
                runningBytes += weights[index];
                Promise.resolve()
                    .then(() => worker(items[index], index))
                    .catch(err => {
                        if (!firstError) firstError = err;
                    })
                    .then(() => {
                        running--;
                        runningBytes -= weights[index];
                        if (next >= items.length && running === 0) resolve();
                        else pump();
                    });
            }
        };
        if (items.length === 0) resolve();
        else pump();
    });

    if (firstError) throw firstError;
}

module.exports = {
    DEFAULT_MAX_CONCURRENT_FILES,
    getBatchFileLimits,
    getFileSize,
    runWithinBudget,
};
