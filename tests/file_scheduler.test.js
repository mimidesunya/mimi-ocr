const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_MAX_CONCURRENT_FILES,
    getBatchFileLimits,
    runWithinBudget,
} = require('../dist/src/lib/file_scheduler.js');

const MB = 1024 * 1024;

function tracker() {
    const state = { running: 0, runningWeight: 0, maxRunning: 0, maxWeight: 0, started: [] };
    const run = weights => async (item, index) => {
        state.started.push(item);
        state.running++;
        state.runningWeight += weights[index];
        state.maxRunning = Math.max(state.maxRunning, state.running);
        state.maxWeight = Math.max(state.maxWeight, state.runningWeight);
        await new Promise(resolve => setTimeout(resolve, 5));
        state.running--;
        state.runningWeight -= weights[index];
    };
    return { state, run };
}

test('batch files run at most maxConcurrent at a time, in input order', async () => {
    const items = Array.from({ length: 10 }, (_, i) => `file-${i}`);
    const weights = items.map(() => 1);
    const { state, run } = tracker();

    await runWithinBudget(items, { maxConcurrent: 3, budgetBytes: 100 }, () => 1, run(weights));

    assert.equal(state.maxRunning, 3);
    assert.deepEqual(state.started, items);
    assert.equal(state.running, 0);
});

test('batch files in flight stay within the byte budget', async () => {
    const weights = [40, 40, 40, 10, 10, 30, 50];
    const items = weights.map((_, i) => i);
    const { state, run } = tracker();

    await runWithinBudget(items, { maxConcurrent: 10, budgetBytes: 100 }, i => weights[i], run(weights));

    assert.ok(state.maxWeight <= 100, `max in-flight weight ${state.maxWeight}`);
    assert.equal(state.started.length, items.length);
});

test('a batch file larger than the budget runs alone instead of blocking forever', async () => {
    const weights = [10, 500, 10];
    const items = weights.map((_, i) => i);
    const { state, run } = tracker();
    const overlaps = [];
    const worker = run(weights);

    await runWithinBudget(items, { maxConcurrent: 10, budgetBytes: 100 }, i => weights[i], async (item, index) => {
        if (item === 1) overlaps.push(state.running);
        await worker(item, index);
    });

    assert.deepEqual(overlaps, [0]);
    assert.deepEqual(state.started, items);
});

test('every batch file runs even when one worker throws, and the first error is reported', async () => {
    const seen = [];
    await assert.rejects(
        runWithinBudget([1, 2, 3], { maxConcurrent: 2, budgetBytes: 100 }, () => 1, async item => {
            seen.push(item);
            if (item === 2) throw new Error('boom');
        }),
        /boom/
    );
    assert.deepEqual(seen.sort(), [1, 2, 3]);
});

test('an empty batch file list finishes immediately', async () => {
    await runWithinBudget([], { maxConcurrent: 2, budgetBytes: 100 }, () => 1, async () => {
        throw new Error('should not run');
    });
});

test('batch file limits default to 32 files and an eighth of the heap, and follow the env overrides', () => {
    const defaults = getBatchFileLimits({});
    const heapLimitMb = Math.floor(require('v8').getHeapStatistics().heap_size_limit / MB);
    assert.equal(defaults.maxConcurrent, DEFAULT_MAX_CONCURRENT_FILES);
    assert.equal(defaults.budgetBytes, Math.max(64, Math.floor(heapLimitMb / 8)) * MB);

    const overridden = getBatchFileLimits({
        MIMI_OCR_BATCH_FILE_CONCURRENCY: '4',
        MIMI_OCR_BATCH_MEMORY_BUDGET_MB: '200',
    });
    assert.equal(overridden.maxConcurrent, 4);
    assert.equal(overridden.budgetBytes, 200 * MB);

    const invalid = getBatchFileLimits({ MIMI_OCR_BATCH_FILE_CONCURRENCY: '0', MIMI_OCR_BATCH_MEMORY_BUDGET_MB: 'x' });
    assert.equal(invalid.maxConcurrent, DEFAULT_MAX_CONCURRENT_FILES);
    assert.equal(invalid.budgetBytes, defaults.budgetBytes);
});
