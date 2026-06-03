const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runProcess(command, args): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${path.basename(command)} failed (${code}): ${stderr || stdout}`));
            }
        });
    });
}

function removeFileQuietly(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_err) {
    }
}

function resolveFfmpegPath(settings: any = {}) {
    return settings.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
}

function resolveFfprobePath(settings: any = {}) {
    if (settings.ffprobePath) return settings.ffprobePath;
    if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
    const ffmpegPath = resolveFfmpegPath(settings);
    if (/ffmpeg(?:\.exe)?$/i.test(ffmpegPath)) {
        const probe = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        if (fs.existsSync(probe)) return probe;
    }
    return 'ffprobe';
}

async function getAudioDurationSeconds(filePath, settings: any = {}) {
    const ffprobe = resolveFfprobePath(settings);
    try {
        const result = await runProcess(ffprobe, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ]);
        const duration = Number.parseFloat(String(result.stdout || '').trim());
        if (Number.isFinite(duration) && duration > 0) return duration;
    } catch (_err) {
    }

    const ffmpeg = resolveFfmpegPath(settings);
    const result = await runProcess(ffmpeg, ['-hide_banner', '-i', filePath, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'])
        .catch(err => ({ stdout: '', stderr: String(err.message || err) }));
    const match = String(result.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseSilences(stderr, duration) {
    const silences = [];
    let openStart = null;
    for (const line of String(stderr || '').split(/\r?\n/)) {
        const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
        if (startMatch) {
            openStart = Number.parseFloat(startMatch[1]);
            continue;
        }
        const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
        if (endMatch && openStart !== null) {
            const end = Number.parseFloat(endMatch[1]);
            if (Number.isFinite(openStart) && Number.isFinite(end) && end > openStart) {
                silences.push({ start: openStart, end });
            }
            openStart = null;
        }
    }
    if (openStart !== null && duration > openStart) {
        silences.push({ start: openStart, end: duration });
    }
    return silences;
}

function buildRemovedRanges(silences, duration, paddingSec) {
    const padding = Math.max(0, Number(paddingSec) || 0);
    return silences
        .map(range => ({
            start: Math.max(0, range.start + padding),
            end: Math.min(duration, range.end - padding),
        }))
        .filter(range => range.end - range.start > 0.05);
}

function buildKeptSegments(duration, removedRanges) {
    const kept = [];
    let cursor = 0;
    for (const range of removedRanges) {
        if (range.start > cursor + 0.05) {
            kept.push({ originalStart: cursor, originalEnd: range.start });
        }
        cursor = Math.max(cursor, range.end);
    }
    if (duration > cursor + 0.05) {
        kept.push({ originalStart: cursor, originalEnd: duration });
    }

    let processedCursor = 0;
    for (const segment of kept) {
        const segmentDuration = segment.originalEnd - segment.originalStart;
        segment.processedStart = processedCursor;
        segment.processedEnd = processedCursor + segmentDuration;
        processedCursor += segmentDuration;
    }
    return kept;
}

function mapProcessedTimeToOriginal(seconds, keptSegments) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0 || !Array.isArray(keptSegments) || keptSegments.length === 0) {
        return value;
    }
    const segment = keptSegments.find(item => value >= item.processedStart && value <= item.processedEnd)
        || keptSegments[keptSegments.length - 1];
    return segment.originalStart + Math.max(0, Math.min(value, segment.processedEnd) - segment.processedStart);
}

function formatTimestamp(seconds, preferHours = false) {
    const value = Math.max(0, Number(seconds) || 0);
    const total = Math.floor(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (preferHours || h > 0) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseTimestamp(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    if (match[3] !== undefined) {
        return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

function mapTranscriptItemsToOriginalTime(items, preprocess) {
    if (!preprocess?.silenceTrimmed || !Array.isArray(preprocess.keptSegments)) return items;
    return items.map(item => {
        const parsed = parseTimestamp(item.time);
        if (parsed === null) return item;
        const preferHours = String(item.time || '').split(':').length >= 3;
        return {
            ...item,
            time: formatTimestamp(mapProcessedTimeToOriginal(parsed, preprocess.keptSegments), preferHours),
        };
    });
}

function summarizeSilenceTrim(preprocess) {
    if (!preprocess?.silenceTrimmed) {
        return {
            enabled: preprocess?.enabled === true,
            applied: false,
        };
    }
    const removedRanges = preprocess.removedRanges || [];
    return {
        enabled: true,
        applied: true,
        thresholdDb: preprocess.thresholdDb,
        minSilenceSec: preprocess.minSilenceSec,
        paddingSec: preprocess.paddingSec,
        outputFormat: preprocess.outputFormat,
        outputBitrate: preprocess.outputBitrate,
        outputBytes: preprocess.outputBytes,
        originalDurationSec: Number(preprocess.originalDurationSec.toFixed(3)),
        processedDurationSec: Number(preprocess.processedDurationSec.toFixed(3)),
        removedDurationSec: Number(preprocess.removedDurationSec.toFixed(3)),
        removedCount: removedRanges.length,
        removedRanges: removedRanges.slice(0, 20).map(range => [
            Number(range.start.toFixed(3)),
            Number(range.end.toFixed(3)),
        ]),
    };
}

function normalizeOutputFormat(value) {
    const format = String(value || 'm4a').toLowerCase().replace(/^\./, '');
    return format === 'wav' ? 'wav' : 'm4a';
}

async function prepareAudioForTranscription(filePath, settings: any = {}) {
    if (!settings?.enabled) {
        return { audioPath: filePath, enabled: false, silenceTrimmed: false, cleanup: () => {} };
    }

    const ffmpeg = resolveFfmpegPath(settings);
    const thresholdDb = Number(settings.thresholdDb ?? -35);
    const minSilenceSec = Number(settings.minSilenceSec ?? 1);
    const paddingSec = Number(settings.paddingSec ?? 0.2);
    const outputFormat = normalizeOutputFormat(settings.outputFormat);
    const outputBitrate = String(settings.outputBitrate || '96k');
    const originalDurationSec = await getAudioDurationSeconds(filePath, settings);
    if (!originalDurationSec || originalDurationSec <= 0) {
        return { audioPath: filePath, enabled: true, silenceTrimmed: false, cleanup: () => {} };
    }

    const detect = await runProcess(ffmpeg, [
        '-hide_banner',
        '-nostdin',
        '-i', filePath,
        '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
        '-f', 'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
    ]).catch(err => ({ stdout: '', stderr: String(err.message || err) }));

    const silences = parseSilences(detect.stderr, originalDurationSec);
    const removedRanges = buildRemovedRanges(silences, originalDurationSec, paddingSec);
    const keptSegments = buildKeptSegments(originalDurationSec, removedRanges);
    const processedDurationSec = keptSegments.length > 0
        ? keptSegments[keptSegments.length - 1].processedEnd
        : originalDurationSec;
    const removedDurationSec = Math.max(0, originalDurationSec - processedDurationSec);

    if (removedRanges.length === 0 || removedDurationSec < 0.05 || keptSegments.length === 0) {
        return {
            audioPath: filePath,
            enabled: true,
            silenceTrimmed: false,
            originalDurationSec,
            processedDurationSec: originalDurationSec,
            removedDurationSec: 0,
            removedRanges: [],
            keptSegments: [],
            thresholdDb,
            minSilenceSec,
            paddingSec,
            outputFormat,
            outputBitrate: outputFormat === 'wav' ? undefined : outputBitrate,
            cleanup: () => {},
        };
    }

    const tempPath = path.join(os.tmpdir(), `mimi-ocr-audio-trim-${Date.now()}-${Math.random().toString(36).slice(2)}.${outputFormat}`);
    const filterParts = [];
    const labels = [];
    keptSegments.forEach((segment, index) => {
        filterParts.push(`[0:a]atrim=start=${segment.originalStart.toFixed(6)}:end=${segment.originalEnd.toFixed(6)},asetpts=PTS-STARTPTS[a${index}]`);
        labels.push(`[a${index}]`);
    });
    filterParts.push(`${labels.join('')}concat=n=${keptSegments.length}:v=0:a=1[outa]`);
    const filterScriptPath = path.join(os.tmpdir(), `mimi-ocr-audio-filter-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf-8');
    const outputArgs = outputFormat === 'wav'
        ? [tempPath]
        : ['-c:a', 'aac', '-b:a', outputBitrate, '-movflags', '+faststart', tempPath];
    try {
        await runProcess(ffmpeg, [
            '-y',
            '-hide_banner',
            '-nostdin',
            '-i', filePath,
            '-filter_complex_script', filterScriptPath,
            '-map', '[outa]',
            '-vn',
            ...outputArgs,
        ]);
    } finally {
        removeFileQuietly(filterScriptPath);
    }
    const outputBytes = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : undefined;

    return {
        audioPath: tempPath,
        enabled: true,
        silenceTrimmed: true,
        originalDurationSec,
        processedDurationSec,
        removedDurationSec,
        removedRanges,
        keptSegments,
        thresholdDb,
        minSilenceSec,
        paddingSec,
        outputFormat,
        outputBitrate: outputFormat === 'wav' ? undefined : outputBitrate,
        outputBytes,
        cleanup: () => {
            removeFileQuietly(tempPath);
        },
    };
}

module.exports = {
    prepareAudioForTranscription,
    mapTranscriptItemsToOriginalTime,
    summarizeSilenceTrim,
    getAudioDurationSeconds,
    parseTimestamp,
    formatTimestamp,
    mapProcessedTimeToOriginal,
};
