const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
    buildVibeVoiceRawItems,
    createMarkerReader,
    normalizeVibeVoiceServerTranscript,
} = require('../dist/src/transcribe_audio.js');
const { resolveVibeVoiceAsr } = require('../dist/src/lib/tool_resolver.js');

test('VibeVoice CPU output strips protocol wrappers without inventing speakers', () => {
    const text = normalizeVibeVoiceServerTranscript(
        '  <|im_start|> assistant\nこれはCPU版の文字起こしです。<|im_end|>  ',
    );
    assert.equal(text, 'これはCPU版の文字起こしです。');

    const items = buildVibeVoiceRawItems(
        [
            { startSec: 0 },
            { startSec: 1200 },
        ],
        [
            { text: '最初のチャンク' },
            { text: '次のチャンク' },
        ],
    );
    assert.deepEqual(items, [
        { speaker: '話者不明', time: '00:00', text: '最初のチャンク' },
        { speaker: '話者不明', time: '20:00', text: '次のチャンク' },
    ]);
});

test('VibeVoice CPU marker reader handles split Windows line endings', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const readUntil = createMarkerReader(child);

    const ready = readUntil('---READY---\n');
    child.stdout.write('---READY---\r');
    child.stdout.write('\n');
    assert.equal(await ready, '');

    const transcript = readUntil('---END---\n');
    child.stdout.write('日本語の出力\r\n---EN');
    child.stdout.write('D---\r\n');
    assert.equal(await transcript, '日本語の出力\n');
});

test('VibeVoice CPU resolver accepts explicitly configured local artifacts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-vibeasr-test-'));
    const binaryPath = path.join(tempDir, process.platform === 'win32' ? 'asr_stream_server.exe' : 'asr_stream_server');
    const vaeModelPath = path.join(tempDir, 'vae.gguf');
    const lmModelPath = path.join(tempDir, 'lm.gguf');
    try {
        fs.writeFileSync(binaryPath, 'test');
        fs.writeFileSync(vaeModelPath, 'test');
        fs.writeFileSync(lmModelPath, 'test');
        const resolved = await resolveVibeVoiceAsr({
            binaryPath,
            vaeModelPath,
            lmModelPath,
            threads: 6,
            autoInstall: false,
        });
        assert.equal(resolved.binaryPath, binaryPath);
        assert.equal(resolved.vaeModelPath, vaeModelPath);
        assert.equal(resolved.lmModelPath, lmModelPath);
        assert.equal(resolved.threads, 6);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('VibeVoice CPU resolver reports every missing artifact when auto install is off', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-vibeasr-missing-'));
    try {
        await assert.rejects(
            resolveVibeVoiceAsr({
                binaryPath: path.join(tempDir, 'missing-server'),
                vaeModelPath: path.join(tempDir, 'missing-vae'),
                lmModelPath: path.join(tempDir, 'missing-lm'),
                autoInstall: false,
            }),
            err => {
                assert.match(err.message, /CPUランタイム/);
                assert.match(err.message, /VAEモデル/);
                assert.match(err.message, /LMモデル/);
                return true;
            },
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
