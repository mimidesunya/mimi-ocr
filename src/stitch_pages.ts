/**
 * 分割スキャンされたPDFページをHuginで復元するツール。
 *
 * 例:
 *   node stitch_pages.js input.pdf --group-size auto --dpi auto
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createCanvas, loadImage } = require('canvas');
const { PDFDocument } = require('pdf-lib');
const { extractPdfToImages } = require('./lib/pdf_to_image');
const { getToolConfig } = require('./lib/gemini_client');
const { resolveStitchEngine } = require('./lib/tool_resolver');

type StitchOptions = {
    groupSize: number | 'auto';
    dpi: number | 'auto';
    deskew: 'auto' | 'off';
    pdfImageFormat: 'jpeg' | 'png';
    jpegQuality: number;
    maxFallbackCandidates: number;
    outputPath: string | null;
    keepTemp: boolean;
};

type StitchGroup = {
    images: string[];
    imageIndexes?: number[];
    autoScore?: number;
    passthrough?: boolean;
};

type HuginTools = {
    ptoGen: string;
    ptoLensstack: string;
    cpfind: string;
    cpclean: string;
    linefind: string;
    ptoVar: string;
    autooptimiser: string;
    panoModify: string;
    huginExecutor: string;
    nona: string;
};

type EdgeMatchMode = 'left-right' | 'right-left' | 'top-bottom' | 'bottom-top';

type HuginCandidate = {
    name: string;
    rotations: number[];
    edgeMatch: EdgeMatchMode | null;
    allPairs?: boolean;
};

type HuginGroupResult = {
    imagePath: string;
    candidate: string;
    cpCount: number;
    rms: number | null;
    activeImages: number | null;
};

type HuginPreparedResult = Omit<HuginGroupResult, 'imagePath'> & {
    imagePath: string | null;
    candidateDir: string;
    prefix: string;
    renderPath: string;
    imageCount: number;
};

type DeskewInfo = {
    input: string;
    output: string;
    angle: number;
    confidence: number;
    score: number;
    applied: boolean;
    method?: string;
};

type PdfImageInfo = {
    input: string;
    format: 'jpeg' | 'png';
    bytes: number;
};

type AutoPairScore = {
    a: number;
    b: number;
    accepted: boolean;
    candidate: string | null;
    controlPoints: number;
    rotations: number[];
    edgeMatch: EdgeMatchMode | null;
    error?: string;
};

type GroupingResult = {
    groups: StitchGroup[];
    resolvedGroupSize: number | 'auto';
    mode: 'fixed' | 'auto';
    pairs: AutoPairScore[];
    warnings: string[];
};

const MIN_HUGIN_CONTROL_POINTS = 3;
const MIN_PROMISING_HUGIN_CONTROL_POINTS = 8;
const HUGIN_COMMAND_TIMEOUT_MS = 180000;
const DEFAULT_MAX_FALLBACK_CANDIDATES = 8;
const AUTO_GROUP_PREVIEW_MAX_SIDE = 1200;
const AUTO_GROUP_ALL_PAIRS_LIMIT = 12;
const AUTO_GROUP_PAIR_WINDOW = 4;
const AUTO_GROUP_MAX_SIZE = 4;
const AUTO_GROUP_PROBE_TIMEOUT_MS = 45000;
const AUTO_GROUP_MIN_CONTROL_POINTS = 8;
const AUTO_GROUP_STRONG_CONTROL_POINTS = 16;

function printUsage() {
    console.log("-------------------------------------------------------");
    console.log(" PDFページ復元ツール");
    console.log("");
    console.log(" A4スキャナで分割スキャンしたページを、Huginで結合してPDFにします。");
    console.log(" 既定では低解像度の重なり検出でページ組を自動判定します。");
    console.log("");
    console.log(" 使い方:");
    console.log("   node stitch_pages.js <PDF> [オプション]");
    console.log("");
    console.log(" オプション:");
    console.log("   --group-size auto|<n>  何ページを1ページへ復元するか（既定: auto = 自動グループ判定）");
    console.log("   --dpi auto|<n>         PDF画像化DPI（既定: auto = 300）");
    console.log("   --deskew auto|off      Hugin前後に水平/垂直特徴で小角度の傾きを補正（既定: auto）");
    console.log("   --pdf-image-format jpeg|png  PDF内の画像形式（既定: jpeg）");
    console.log("   --jpeg-quality <0.1-1.0>     JPEG品質（既定: 0.86）");
    console.log("   --max-fallback-candidates <n> 弱いマッチング時に試す追加候補数（既定: 8、最大: 32）");
    console.log("   --output <path>        出力PDFパス");
    console.log("   --keep-temp            中間PNG、PTO、Hugin出力を残す");
    console.log("");
    console.log(" Hugin CLI (pto_gen, cpfind, autooptimiser, hugin_executor, nona など) が PATH にない場合は config.json の tools.stitchEngine.huginPath に");
    console.log(" Hugin の bin フォルダ、または hugin_executor.exe のパスを指定してください。");
    console.log("-------------------------------------------------------");
}

function parseArgs(argv: string[]) {
    const inputPaths: string[] = [];
    const toolConfig = getToolConfig('stitchEngine') || {};
    const options: StitchOptions = {
        groupSize: 'auto',
        dpi: toolConfig.imageDpi === 'auto' ? 'auto' : (Number(toolConfig.imageDpi) || 'auto'),
        deskew: toolConfig.deskew === 'off' ? 'off' : 'auto',
        pdfImageFormat: resolvePdfImageFormat(toolConfig.pdfImageFormat),
        jpegQuality: resolveJpegQuality(toolConfig.jpegQuality),
        maxFallbackCandidates: resolveMaxFallbackCandidates(toolConfig.maxFallbackCandidates),
        outputPath: null,
        keepTemp: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--backend') {
            const value = String(argv[++i] || '').trim().toLowerCase();
            if (value && value !== 'hugin') {
                throw new Error('--backend は廃止されました。ページ復元は Hugin のみ対応しています。');
            }
        } else if (arg === '--group-size') {
            const value = argv[++i];
            options.groupSize = value === 'auto' ? 'auto' : parseInt(value, 10);
        } else if (arg === '--dpi') {
            const value = argv[++i];
            options.dpi = value === 'auto' ? 'auto' : parseInt(value, 10);
        } else if (arg === '--deskew') {
            const value = String(argv[++i] || '').toLowerCase();
            if (!['auto', 'off'].includes(value)) {
                throw new Error('--deskew は auto または off を指定してください');
            }
            options.deskew = value as 'auto' | 'off';
        } else if (arg === '--pdf-image-format') {
            const value = String(argv[++i] || '').toLowerCase();
            if (!['jpeg', 'jpg', 'png'].includes(value)) {
                throw new Error('--pdf-image-format は jpeg または png を指定してください');
            }
            options.pdfImageFormat = value === 'png' ? 'png' : 'jpeg';
        } else if (arg === '--jpeg-quality') {
            options.jpegQuality = resolveJpegQuality(argv[++i]);
        } else if (arg === '--max-fallback-candidates') {
            options.maxFallbackCandidates = resolveMaxFallbackCandidates(argv[++i]);
        } else if (arg === '--orientation') {
            const value = String(argv[++i] || '').toLowerCase();
            if (value !== 'off') {
                throw new Error('--orientation は廃止されました。完成ページの向き補正は行いません。小角度補正には --deskew auto|off を指定してください');
            }
        } else if (arg === '--output') {
            options.outputPath = argv[++i];
        } else if (arg === '--keep-temp') {
            options.keepTemp = true;
        } else if (arg === '--help' || arg === '-h') {
            return { inputPaths, options, help: true };
        } else if (arg.startsWith('--')) {
            throw new Error(`不明なオプションです: ${arg}`);
        } else {
            inputPaths.push(arg);
        }
    }

    if (options.groupSize !== 'auto' && (!Number.isFinite(options.groupSize) || options.groupSize < 2)) {
        throw new Error('--group-size は auto または2以上の整数を指定してください');
    }
    if (options.dpi !== 'auto' && (!Number.isFinite(options.dpi) || options.dpi < 72 || options.dpi > 600)) {
        throw new Error('--dpi は auto または72から600の整数を指定してください');
    }

    return { inputPaths, options, help: false };
}

function uniqueOutputPath(basePdfPath: string): string {
    const dir = path.dirname(basePdfPath);
    const stem = path.basename(basePdfPath, path.extname(basePdfPath));
    const first = path.join(dir, `${stem}_stitched.pdf`);
    if (!fs.existsSync(first)) return first;
    for (let i = 2; i < 1000; i++) {
        const candidate = path.join(dir, `${stem}_stitched (${i}).pdf`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`出力先の連番を作成できません: ${first}`);
}

function resolveDpi(dpi: number | 'auto') {
    return dpi === 'auto' ? 300 : dpi;
}

function resolvePdfImageFormat(value: any): 'jpeg' | 'png' {
    return String(value || '').trim().toLowerCase() === 'png' ? 'png' : 'jpeg';
}

function resolveJpegQuality(value: any) {
    let quality = Number(value);
    if (!Number.isFinite(quality)) quality = 0.86;
    if (quality > 1) quality /= 100;
    return Math.min(0.98, Math.max(0.1, quality));
}

function resolveMaxFallbackCandidates(value: any) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_FALLBACK_CANDIDATES;
    return Math.min(32, Math.max(0, parsed));
}

function makeFixedGroups(images: string[], groupSize: number): GroupingResult {
    const resolvedGroupSize = groupSize;
    if (images.length % resolvedGroupSize !== 0) {
        throw new Error(`ページ数が分割枚数で割り切れません: pages=${images.length} groupSize=${resolvedGroupSize}`);
    }

    const groups: StitchGroup[] = [];
    for (let i = 0; i < images.length; i += resolvedGroupSize) {
        groups.push({
            images: images.slice(i, i + resolvedGroupSize),
            imageIndexes: Array.from({ length: resolvedGroupSize }, (_, offset) => i + offset),
        });
    }
    return {
        groups,
        resolvedGroupSize,
        mode: 'fixed',
        pairs: [],
        warnings: [],
    };
}

type CommandResult = {
    stdout: string;
    stderr: string;
    output: string;
};

function runCommand(command: string, args: string[], cwd: string, timeoutMs = HUGIN_COMMAND_TIMEOUT_MS, quiet = false): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        if (!quiet) console.log(`[hugin] 実行: ${command} ${args.join(' ')}`);
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout.on('data', data => {
            const text = String(data);
            stdout += text;
            if (!quiet) {
                text.split(/\r?\n/).forEach(line => {
                    if (line.trim()) console.log(line.trim());
                });
            }
        });
        child.stderr.on('data', data => {
            const text = String(data);
            stderr += text;
            if (!quiet) {
                text.split(/\r?\n/).forEach(line => {
                    if (line.trim()) console.warn(line.trim());
                });
            }
        });
        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Huginを起動できません: ${err.message}`));
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`Huginコマンドが${Math.round(timeoutMs / 1000)}秒以内に終わりませんでした: ${path.basename(command)}`));
            } else if (code === 0) {
                resolve({ stdout, stderr, output: `${stdout}\n${stderr}` });
            } else {
                reject(new Error(`Huginが失敗しました (exit code ${code})`));
            }
        });
    });
}

function runExternalCommand(command: string, args: string[], cwd: string, timeoutMs: number, label: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        console.log(`[${label}] 実行: ${command} ${args.join(' ')}`);
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout.on('data', data => {
            const text = String(data);
            stdout += text;
            text.split(/\r?\n/).forEach(line => {
                if (line.trim()) console.log(line.trim());
            });
        });
        child.stderr.on('data', data => {
            const text = String(data);
            stderr += text;
            text.split(/\r?\n/).forEach(line => {
                if (line.trim()) console.warn(line.trim());
            });
        });
        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`${label}を起動できません: ${err.message}`));
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`${label}コマンドが${Math.round(timeoutMs / 1000)}秒以内に終わりませんでした: ${path.basename(command)}`));
            } else if (code === 0) {
                resolve({ stdout, stderr, output: `${stdout}\n${stderr}` });
            } else {
                reject(new Error(`${label}が失敗しました (exit code ${code})`));
            }
        });
    });
}

function normalizeAngle(angle: number) {
    return ((Math.round(angle) % 360) + 360) % 360;
}

function safeNamePart(value: string) {
    return value.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function countControlPoints(ptoPath: string) {
    if (!fs.existsSync(ptoPath)) return 0;
    return fs.readFileSync(ptoPath, 'utf-8')
        .split(/\r?\n/)
        .filter(line => line.startsWith('c '))
        .length;
}

function parseLastRms(output: string): number | null {
    let last: number | null = null;
    const regex = /after\s+\d+\s+iteration\(s\):\s*([0-9.]+)\s+units/gi;
    for (const match of output.matchAll(regex)) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) last = value;
    }
    return last;
}

function parseActiveImages(output: string): number | null {
    const match = output.match(/Number of active images:\s*(\d+)/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

function formatMetric(value: number | null, digits = 3) {
    return value === null ? 'n/a' : value.toFixed(digits);
}

function normalizeRotationDegrees(angle: number) {
    let value = Number(angle) || 0;
    value %= 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return value;
}

async function writeRotatedImageFile(inputPath: string, outputPath: string, angle: number, maxSide = 0) {
    const normalized = normalizeRotationDegrees(angle);
    const img = await loadImage(inputPath);
    const radians = normalized * Math.PI / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));
    const rotatedWidth = img.width * cos + img.height * sin;
    const rotatedHeight = img.width * sin + img.height * cos;
    const scale = maxSide > 0 && Math.max(rotatedWidth, rotatedHeight) > maxSide
        ? maxSide / Math.max(rotatedWidth, rotatedHeight)
        : 1;
    const canvas = createCanvas(Math.max(1, Math.ceil(rotatedWidth * scale)), Math.max(1, Math.ceil(rotatedHeight * scale)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.rotate(radians);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

async function imageDimensions(imagePath: string) {
    const img = await loadImage(imagePath);
    return { width: img.width, height: img.height };
}

function fullCropValue(width: number, height: number) {
    return `0,${Math.round(width)},0,${Math.round(height)}`;
}

function edgeCropValue(width: number, height: number, edge: 'left' | 'right' | 'top' | 'bottom') {
    const fraction = 0.30;
    const w = Math.round(width);
    const h = Math.round(height);
    const stripW = Math.max(64, Math.round(w * fraction));
    const stripH = Math.max(64, Math.round(h * fraction));
    if (edge === 'left') return `0,${stripW},0,${h}`;
    if (edge === 'right') return `${Math.max(0, w - stripW)},${w},0,${h}`;
    if (edge === 'top') return `0,${w},0,${stripH}`;
    return `0,${w},${Math.max(0, h - stripH)},${h}`;
}

function edgePair(mode: EdgeMatchMode): ['left' | 'right' | 'top' | 'bottom', 'left' | 'right' | 'top' | 'bottom'] {
    if (mode === 'left-right') return ['left', 'right'];
    if (mode === 'right-left') return ['right', 'left'];
    if (mode === 'top-bottom') return ['top', 'bottom'];
    return ['bottom', 'top'];
}

function huginCandidateScore(result: Pick<HuginGroupResult, 'cpCount' | 'rms' | 'activeImages'>, imageCount: number) {
    const activeBonus = result.activeImages !== null && result.activeImages >= imageCount ? 5000 : 0;
    const rms = result.rms === null ? 9999 : result.rms;
    return activeBonus + result.cpCount * 1000 - rms * 500;
}

function isStrongHuginCandidate(result: Pick<HuginGroupResult, 'cpCount' | 'rms' | 'activeImages'>, imageCount: number) {
    return result.activeImages !== null
        && result.activeImages >= imageCount
        && result.cpCount >= 8
        && result.rms !== null
        && result.rms <= 2;
}

function isPromisingHuginCandidate(result: Pick<HuginGroupResult, 'cpCount' | 'rms'>) {
    return result.cpCount >= 8
        && result.rms !== null
        && result.rms <= 2;
}

function patchPtoForPng(ptoPath: string) {
    let text = fs.readFileSync(ptoPath, 'utf-8');
    const lines = text.split(/\r?\n/).map(line => {
        if (!line.startsWith('p ')) return line;
        if (/\sn"[^"]*"/.test(line)) {
            return line.replace(/\sn"[^"]*"/, ' n"PNG"');
        }
        return `${line} n"PNG"`;
    });
    text = lines.join(os.EOL);
    fs.writeFileSync(ptoPath, text, 'utf-8');
}

function findNewestOutputImage(dir: string, prefixBase: string) {
    const allowed = new Set(['.png', '.jpg', '.jpeg']);
    const candidates = fs.readdirSync(dir)
        .filter(name => name.startsWith(prefixBase) && allowed.has(path.extname(name).toLowerCase()))
        .map(name => path.join(dir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] || null;
}

function buildAngleRange(from: number, to: number, step: number) {
    const angles: number[] = [];
    for (let value = from; value <= to + step / 2; value += step) {
        angles.push(Number(value.toFixed(4)));
    }
    return angles;
}

function fitLine(points: Array<[number, number]>) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const n = points.length;
    if (n < 2) return null;
    for (const [x, y] of points) {
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const m = (n * sxy - sx * sy) / denom;
    const b = (sy - m * sx) / n;
    let err = 0;
    for (const [x, y] of points) {
        const delta = y - (m * x + b);
        err += delta * delta;
    }
    return {
        m,
        b,
        angle: Math.atan(m) * 180 / Math.PI,
        rmse: Math.sqrt(err / n),
        count: n,
    };
}

function fitHorizontalBorder(lum: Uint8Array, width: number, height: number, region: 'top' | 'bottom') {
    const y0 = region === 'top' ? 0 : Math.floor(height * 0.85);
    const y1 = region === 'top' ? Math.floor(height * 0.15) : height;
    const points: Array<[number, number]> = [];
    for (let x = 0; x < width; x++) {
        let bestY = -1;
        let bestLum = 255;
        for (let y = y0; y < y1; y++) {
            const value = lum[y * width + x];
            if (value < bestLum) {
                bestLum = value;
                bestY = y;
            }
        }
        if (bestY >= 0 && bestLum < 135) points.push([x, bestY]);
    }
    if (points.length < width * 0.35) return null;

    const first = fitLine(points);
    if (!first) return null;
    const filtered = points.filter(([x, y]) => Math.abs(y - (first.m * x + first.b)) <= 18);
    const fit = filtered.length >= width * 0.28 ? fitLine(filtered) : first;
    if (!fit || Math.abs(fit.angle) > 5) return null;
    return {
        ...fit,
        region,
        cover: fit.count / width,
    };
}

function estimateBorderDeskew(lum: Uint8Array, width: number, height: number) {
    const candidates = [
        fitHorizontalBorder(lum, width, height, 'top'),
        fitHorizontalBorder(lum, width, height, 'bottom'),
    ].filter(Boolean);
    if (candidates.length === 0) return null;

    const strong = candidates.filter(item => item.cover >= 0.45);
    const usable = strong.length > 0 ? strong : candidates;
    if (usable.length === 0) return null;

    const weighted = usable.reduce((acc, item) => {
        acc.angle += item.angle * item.cover;
        acc.cover += item.cover;
        acc.score += item.count;
        return acc;
    }, { angle: 0, cover: 0, score: 0 });
    if (weighted.cover <= 0) return null;

    const lineAngle = weighted.angle / weighted.cover;
    const correction = -lineAngle;
    if (Math.abs(correction) < 0.12 || Math.abs(correction) > 5) return null;
    return {
        angle: correction,
        confidence: Math.min(1, weighted.cover / Math.max(1, usable.length)),
        score: weighted.score,
        method: 'border',
    };
}

function axisDeviation(angle: number) {
    let value = ((angle + 45) % 90 + 90) % 90 - 45;
    if (value <= -45) value += 90;
    return value;
}

function estimateOrthogonalFeatureDeskew(lum: Uint8Array, width: number, height: number) {
    const maxDeviation = 8;
    let weightSum = 0;
    let deviationSum = 0;
    let deviationSqSum = 0;
    let used = 0;
    const minUsed = Math.max(700, Math.floor(width * height * 0.001));

    for (let y = 2; y < height - 2; y += 2) {
        for (let x = 2; x < width - 2; x += 2) {
            const idx = y * width + x;
            const gx = lum[idx + 1] - lum[idx - 1];
            const gy = lum[idx + width] - lum[idx - width];
            const mag = Math.abs(gx) + Math.abs(gy);
            if (mag < 42) continue;

            const gradientAngle = Math.atan2(gy, gx) * 180 / Math.PI;
            const lineAngle = gradientAngle + 90;
            const deviation = axisDeviation(lineAngle);
            const absDeviation = Math.abs(deviation);
            if (absDeviation > maxDeviation) continue;

            const axisWeight = 1 - absDeviation / maxDeviation;
            const weight = mag * mag * Math.max(0.15, axisWeight);
            weightSum += weight;
            deviationSum += deviation * weight;
            deviationSqSum += deviation * deviation * weight;
            used++;
        }
    }

    if (used < minUsed || weightSum <= 0) return null;

    const meanDeviation = deviationSum / weightSum;
    const variance = Math.max(0, deviationSqSum / weightSum - meanDeviation * meanDeviation);
    const stddev = Math.sqrt(variance);
    const correction = -meanDeviation;
    if (Math.abs(correction) < 0.10 || Math.abs(correction) > maxDeviation || stddev > 4.5) return null;

    const density = Math.min(1, used / Math.max(1, minUsed * 8));
    const coherence = Math.max(0, 1 - stddev / 4.5);
    return {
        angle: correction,
        confidence: Number((density * 0.55 + coherence * 0.45).toFixed(5)),
        score: Math.round(weightSum),
        method: 'orthogonal-features',
    };
}

async function estimateDeskewAngle(imagePath: string, phase = 'input') {
    const img = await loadImage(imagePath);
    const maxSide = 1100;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const data = ctx.getImageData(0, 0, width, height).data;
    const lum = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        lum[p] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    const borderDeskew = estimateBorderDeskew(lum, width, height);
    const orthogonalDeskew = estimateOrthogonalFeatureDeskew(lum, width, height);

    if (phase === 'output' && orthogonalDeskew && orthogonalDeskew.confidence >= 0.12) {
        return orthogonalDeskew;
    }
    if (borderDeskew) {
        return borderDeskew;
    }
    if (orthogonalDeskew && orthogonalDeskew.confidence >= 0.12) {
        return orthogonalDeskew;
    }

    const xs: number[] = [];
    const ys: number[] = [];
    const weights: number[] = [];
    const cx = width / 2;
    const cy = height / 2;
    for (let y = 2; y < height - 2; y += 2) {
        for (let x = 2; x < width - 2; x += 2) {
            const idx = y * width + x;
            const gx = lum[idx + 1] - lum[idx - 1];
            const gy = lum[idx + width] - lum[idx - width];
            const mag = Math.abs(gx) + Math.abs(gy);
            if (mag < 34) continue;
            xs.push(x - cx);
            ys.push(y - cy);
            weights.push(Math.min(255, mag));
        }
    }

    if (xs.length < 1500) {
        return { angle: 0, confidence: 0, score: 0, method: 'projection' };
    }

    const limit = 70000;
    const pointStep = Math.max(1, Math.ceil(xs.length / limit));
    const projectionSize = Math.ceil(Math.sqrt(width * width + height * height)) + 8;
    const offset = Math.floor(projectionSize / 2);
    const scoreCache = new Map<number, number>();

    const projectionScore = (angle: number) => {
        const key = Number(angle.toFixed(4));
        if (scoreCache.has(key)) return scoreCache.get(key)!;
        const radians = key * Math.PI / 180;
        const sin = Math.sin(radians);
        const cos = Math.cos(radians);
        const rowBins = new Float64Array(projectionSize);
        const colBins = new Float64Array(projectionSize);
        for (let i = 0; i < xs.length; i += pointStep) {
            const x = xs[i];
            const y = ys[i];
            const weight = weights[i];
            const xr = x * cos - y * sin;
            const yr = x * sin + y * cos;
            const row = Math.round(yr) + offset;
            const col = Math.round(xr) + offset;
            if (row >= 0 && row < projectionSize) rowBins[row] += weight;
            if (col >= 0 && col < projectionSize) colBins[col] += weight;
        }
        let score = 0;
        for (let i = 0; i < projectionSize; i++) {
            score += rowBins[i] * rowBins[i] + colBins[i] * colBins[i];
        }
        scoreCache.set(key, score);
        return score;
    };

    let best = { angle: 0, score: projectionScore(0) };
    for (const angle of buildAngleRange(-5, 5, 0.25)) {
        const score = projectionScore(angle);
        if (score > best.score) best = { angle, score };
    }
    for (const angle of buildAngleRange(best.angle - 0.3, best.angle + 0.3, 0.05)) {
        const bounded = Math.max(-5, Math.min(5, angle));
        const score = projectionScore(bounded);
        if (score > best.score) best = { angle: bounded, score };
    }

    const zeroScore = projectionScore(0);
    const confidence = zeroScore > 0 ? (best.score - zeroScore) / zeroScore : 0;
    if (Math.abs(best.angle) < 0.12 || confidence < 0.0025) {
        return { angle: 0, confidence, score: best.score, method: 'projection' };
    }
    return { angle: best.angle, confidence, score: best.score, method: 'projection' };
}

async function deskewImages(imagePaths: string[], workDir: string, enabled: boolean, phase = 'input'): Promise<{ images: string[]; pages: DeskewInfo[] }> {
    const pages: DeskewInfo[] = [];
    if (!enabled || imagePaths.length === 0) {
        return {
            images: imagePaths,
            pages: imagePaths.map(imagePath => ({
                input: imagePath,
                output: imagePath,
                angle: 0,
                confidence: 0,
                score: 0,
                applied: false,
                method: 'disabled',
            })),
        };
    }

    const label = phase === 'output' ? '復元ページ' : '入力ページ';
    console.log(`[情報] 水平/垂直特徴で${label}の傾きを補正します (${imagePaths.length}ページ)`);
    const deskewDir = path.join(workDir, phase === 'output' ? 'deskew-output' : 'deskew-input');
    fs.mkdirSync(deskewDir, { recursive: true });

    const outputImages: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
        const input = imagePaths[i];
        const estimated = await estimateDeskewAngle(input, phase);
        let output = input;
        let applied = false;
        if (estimated.angle !== 0) {
            output = path.join(deskewDir, `page_${String(i + 1).padStart(4, '0')}_deskew.png`);
            await writeRotatedImageFile(input, output, estimated.angle);
            applied = true;
        }
        outputImages.push(output);
        pages.push({
            input,
            output,
            angle: Number(estimated.angle.toFixed(3)),
            confidence: Number(estimated.confidence.toFixed(5)),
            score: Math.round(estimated.score),
            applied,
            method: estimated.method || 'unknown',
        });
        console.log(`[deskew:${phase}] page ${i + 1}: 補正=${applied ? `${estimated.angle.toFixed(2)}度` : 'なし'} method=${estimated.method || 'unknown'} confidence=${estimated.confidence.toFixed(4)}`);
    }
    return { images: outputImages, pages };
}

function imageVariableList(prefix: string, imageCount: number) {
    const vars = [];
    for (let i = 0; i < imageCount; i++) {
        vars.push(`${prefix}${i}`);
    }
    return vars;
}

function mosaicOptimizerVariables(imageCount: number) {
    const vars = [
        ...imageVariableList('TrX', imageCount),
        ...imageVariableList('TrY', imageCount),
        ...imageVariableList('r', imageCount),
    ];
    for (const anchor of ['TrX0', 'TrY0', 'r0']) {
        vars.push(`!${anchor}`);
    }
    return vars.join(',');
}

async function rotatedImageForCandidate(imagePath: string, angle: number, cacheDir: string, cache: Map<string, string>) {
    const normalized = normalizeAngle(angle);
    if (normalized === 0) return imagePath;
    const key = `${imagePath}::${normalized}`;
    if (cache.has(key)) return cache.get(key)!;
    const stem = safeNamePart(path.basename(imagePath, path.extname(imagePath)));
    const outPath = path.join(cacheDir, `${stem}_rot${normalized}.png`);
    if (!fs.existsSync(outPath)) {
        await writeRotatedImageFile(imagePath, outPath, normalized);
    }
    cache.set(key, outPath);
    return outPath;
}

async function candidateImages(group: StitchGroup, candidate: HuginCandidate, cacheDir: string, cache: Map<string, string>) {
    const images: string[] = [];
    for (let i = 0; i < group.images.length; i++) {
        images.push(await rotatedImageForCandidate(group.images[i], candidate.rotations[i] || 0, cacheDir, cache));
    }
    return images;
}

function edgeCpfindArgs() {
    return [
        '--allpairs',
        '--minmatches=3',
        '--sieve1width=3',
        '--sieve1height=10',
        '--sieve1size=200',
        '--sieve2width=2',
        '--sieve2height=8',
        '--sieve2size=5',
    ];
}

function buildFallbackCandidates(imageCount: number): HuginCandidate[] {
    if (imageCount > 2) {
        const candidates: HuginCandidate[] = [];
        const seen = new Set<string>();
        const add = (rotations: number[]) => {
            const normalized = rotations.slice(0, imageCount);
            while (normalized.length < imageCount) normalized.push(0);
            const key = normalized.join('_');
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push({
                name: `allpairs_r${key}`,
                rotations: normalized,
                edgeMatch: null,
                allPairs: true,
            });
        };

        add(new Array(imageCount).fill(0));
        add(new Array(imageCount).fill(180));
        for (let i = 0; i < imageCount; i++) {
            const single = new Array(imageCount).fill(0);
            single[i] = 180;
            add(single);
        }
        for (let i = 0; i < imageCount; i++) {
            const except = new Array(imageCount).fill(180);
            except[i] = 0;
            add(except);
        }
        return candidates;
    }
    if (imageCount !== 2) return [];
    const edgeModes: EdgeMatchMode[] = ['left-right', 'right-left', 'top-bottom', 'bottom-top'];
    const rotationSets = [
        [0, 0],
        [180, 0],
        [0, 180],
        [180, 180],
        [90, 0],
        [270, 0],
        [0, 90],
        [0, 270],
    ];
    const candidates: HuginCandidate[] = [];
    for (const rotations of rotationSets) {
        for (const edgeMatch of edgeModes) {
            candidates.push({
                name: `edge_${edgeMatch}_r${rotations.join('_')}`,
                rotations,
                edgeMatch,
            });
        }
    }
    return candidates;
}

async function applyEdgeCrop(tools: HuginTools, projectPath: string, outputPath: string, images: string[], mode: EdgeMatchMode, cwd: string, timeoutMs = HUGIN_COMMAND_TIMEOUT_MS, quiet = false) {
    const dims = await Promise.all(images.map(imageDimensions));
    const [edge0, edge1] = edgePair(mode);
    await runCommand(tools.ptoVar, [
        `--crop=i0=${edgeCropValue(dims[0].width, dims[0].height, edge0)}`,
        `--crop=i1=${edgeCropValue(dims[1].width, dims[1].height, edge1)}`,
        '-o',
        outputPath,
        projectPath,
    ], cwd, timeoutMs, quiet);
}

async function clearImageCrops(tools: HuginTools, projectPath: string, outputPath: string, images: string[], cwd: string, timeoutMs = HUGIN_COMMAND_TIMEOUT_MS, quiet = false) {
    const dims = await Promise.all(images.map(imageDimensions));
    const args = dims.flatMap((dim, i) => [`--crop=i${i}=${fullCropValue(dim.width, dim.height)}`]);
    await runCommand(tools.ptoVar, [...args, '-o', outputPath, projectPath], cwd, timeoutMs, quiet);
}

function buildAutoProbeCandidates(limit: number) {
    const edgeModes: EdgeMatchMode[] = ['left-right', 'right-left', 'top-bottom', 'bottom-top'];
    const rotationSets = [
        [0, 0],
        [180, 0],
        [0, 180],
        [180, 180],
        [90, 0],
        [270, 0],
        [0, 90],
        [0, 270],
    ];
    const candidates: HuginCandidate[] = [];
    for (const rotations of rotationSets) {
        for (const edgeMatch of edgeModes) {
            candidates.push({
                name: `probe_${edgeMatch}_r${rotations.join('_')}`,
                rotations,
                edgeMatch,
            });
        }
    }
    return candidates.slice(0, Math.max(1, limit));
}

async function createAutoGroupPreviews(imagePaths: string[], workDir: string) {
    const previewDir = path.join(workDir, 'auto-group-preview');
    fs.mkdirSync(previewDir, { recursive: true });
    const previews: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
        const outPath = path.join(previewDir, `page_${String(i + 1).padStart(4, '0')}_preview.png`);
        await writeRotatedImageFile(imagePaths[i], outPath, 0, AUTO_GROUP_PREVIEW_MAX_SIDE);
        previews.push(outPath);
    }
    return previews;
}

function autoPairIndexes(imageCount: number) {
    const pairs: Array<[number, number]> = [];
    const allPairs = imageCount <= AUTO_GROUP_ALL_PAIRS_LIMIT;
    for (let i = 0; i < imageCount; i++) {
        const last = allPairs ? imageCount - 1 : Math.min(imageCount - 1, i + AUTO_GROUP_PAIR_WINDOW);
        for (let j = i + 1; j <= last; j++) {
            pairs.push([i, j]);
        }
    }
    return pairs;
}

async function runAutoPairProbeCandidate(
    group: StitchGroup,
    tools: HuginTools,
    pairDir: string,
    pairLabel: string,
    candidate: HuginCandidate,
    rotationCache: Map<string, string>,
): Promise<number> {
    if (!candidate.edgeMatch) return 0;
    const candidateDir = path.join(pairDir, safeNamePart(candidate.name));
    const cacheDir = path.join(pairDir, '_rotated');
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const images = await candidateImages(group, candidate, cacheDir, rotationCache);
    let projectPath = path.join(candidateDir, `${pairLabel}_01_gen.pto`);
    await runCommand(tools.ptoGen, ['--projection=0', '--fov=10', '-o', projectPath, ...images], candidateDir, AUTO_GROUP_PROBE_TIMEOUT_MS, true);

    for (let i = 1; i < images.length; i++) {
        const nextPath = path.join(candidateDir, `${pairLabel}_02_lens_${i}.pto`);
        await runCommand(tools.ptoLensstack, ['--new-lens', `i${i}`, '-o', nextPath, projectPath], candidateDir, AUTO_GROUP_PROBE_TIMEOUT_MS, true);
        projectPath = nextPath;
    }

    const cropPath = path.join(candidateDir, `${pairLabel}_03_edge_crop.pto`);
    await applyEdgeCrop(tools, projectPath, cropPath, images, candidate.edgeMatch, candidateDir, AUTO_GROUP_PROBE_TIMEOUT_MS, true);

    const cpPath = path.join(candidateDir, `${pairLabel}_04_cp.pto`);
    await runCommand(tools.cpfind, [...edgeCpfindArgs(), '-o', cpPath, cropPath], candidateDir, AUTO_GROUP_PROBE_TIMEOUT_MS, true);
    const cpCount = countControlPoints(cpPath);
    if (cpCount < MIN_HUGIN_CONTROL_POINTS) return cpCount;

    const cleanPath = path.join(candidateDir, `${pairLabel}_05_clean.pto`);
    await runCommand(tools.cpclean, ['-o', cleanPath, cpPath], candidateDir, AUTO_GROUP_PROBE_TIMEOUT_MS, true);
    return countControlPoints(cleanPath);
}

async function probeAutoPair(
    previewImages: string[],
    a: number,
    b: number,
    tools: HuginTools,
    autoDir: string,
    candidateLimit: number,
): Promise<AutoPairScore> {
    const pairLabel = `pair_${a + 1}_${b + 1}`;
    const pairDir = path.join(autoDir, pairLabel);
    fs.mkdirSync(pairDir, { recursive: true });
    const group: StitchGroup = {
        images: [previewImages[a], previewImages[b]],
        imageIndexes: [a, b],
    };
    const rotationCache = new Map<string, string>();
    const candidates = buildAutoProbeCandidates(candidateLimit);
    let best: AutoPairScore = {
        a,
        b,
        accepted: false,
        candidate: null,
        controlPoints: 0,
        rotations: [0, 0],
        edgeMatch: null,
    };
    let lastError = '';

    for (const candidate of candidates) {
        try {
            const controlPoints = await runAutoPairProbeCandidate(group, tools, pairDir, pairLabel, candidate, rotationCache);
            if (controlPoints > best.controlPoints) {
                best = {
                    a,
                    b,
                    accepted: controlPoints >= AUTO_GROUP_MIN_CONTROL_POINTS,
                    candidate: candidate.name,
                    controlPoints,
                    rotations: candidate.rotations,
                    edgeMatch: candidate.edgeMatch,
                };
            }
            if (controlPoints >= AUTO_GROUP_STRONG_CONTROL_POINTS) break;
        } catch (err) {
            lastError = err.message || String(err);
        }
    }

    if (!best.candidate && lastError) best.error = lastError;
    best.accepted = best.controlPoints >= AUTO_GROUP_MIN_CONTROL_POINTS;
    return best;
}

function autoGroupsFromPairs(images: string[], pairs: AutoPairScore[]): StitchGroup[] {
    const parent = images.map((_, i) => i);
    const size = images.map(() => 1);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        let ra = find(a);
        let rb = find(b);
        if (ra === rb) return;
        if (size[ra] < size[rb]) {
            const tmp = ra;
            ra = rb;
            rb = tmp;
        }
        parent[rb] = ra;
        size[ra] += size[rb];
    };

    const accepted = pairs
        .filter(pair => pair.accepted)
        .sort((a, b) => (b.controlPoints - a.controlPoints) || (Math.abs(a.a - a.b) - Math.abs(b.a - b.b)));

    for (const pair of accepted) {
        const ra = find(pair.a);
        const rb = find(pair.b);
        if (ra === rb) continue;
        if (size[ra] + size[rb] > AUTO_GROUP_MAX_SIZE) continue;
        union(ra, rb);
    }

    const components = new Map<number, number[]>();
    for (let i = 0; i < images.length; i++) {
        const root = find(i);
        const items = components.get(root) || [];
        items.push(i);
        components.set(root, items);
    }

    return Array.from(components.values())
        .map(indexes => indexes.sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0])
        .map(indexes => {
            const score = pairs
                .filter(pair => indexes.includes(pair.a) && indexes.includes(pair.b) && pair.accepted)
                .reduce((sum, pair) => sum + pair.controlPoints, 0);
            return {
                images: indexes.map(index => images[index]),
                imageIndexes: indexes,
                autoScore: score,
                passthrough: indexes.length === 1,
            };
        });
}

function acceptedPairMap(pairs: AutoPairScore[]) {
    const map = new Map<string, AutoPairScore>();
    for (const pair of pairs) {
        if (!pair.accepted) continue;
        map.set(`${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`, pair);
    }
    return map;
}

function connectedSequentialGroups(images: string[], pairs: AutoPairScore[], groupSizes = [2, 3, 4]) {
    const pairMap = acceptedPairMap(pairs);
    for (const groupSize of groupSizes) {
        if (images.length % groupSize !== 0) continue;
        const groups: StitchGroup[] = [];
        let ok = true;

        for (let start = 0; start < images.length; start += groupSize) {
            const indexes = Array.from({ length: groupSize }, (_, offset) => start + offset);
            const parent = indexes.map((_, i) => i);
            const find = (x: number): number => {
                while (parent[x] !== x) {
                    parent[x] = parent[parent[x]];
                    x = parent[x];
                }
                return x;
            };
            const union = (ia: number, ib: number) => {
                const ra = find(ia);
                const rb = find(ib);
                if (ra !== rb) parent[rb] = ra;
            };
            let score = 0;
            for (let i = 0; i < indexes.length; i++) {
                for (let j = i + 1; j < indexes.length; j++) {
                    const key = `${indexes[i]}:${indexes[j]}`;
                    const pair = pairMap.get(key);
                    if (!pair) continue;
                    union(i, j);
                    score += pair.controlPoints;
                }
            }
            if (new Set(indexes.map((_, i) => find(i))).size !== 1) {
                ok = false;
                break;
            }
            groups.push({
                images: indexes.map(index => images[index]),
                imageIndexes: indexes,
                autoScore: score,
            });
        }

        if (ok && groups.length > 0) {
            return { groups, groupSize };
        }
    }
    return null;
}

function sequentialRequiredPairs(imageCount: number, groupSize: number) {
    const pairs: Array<[number, number]> = [];
    if (imageCount % groupSize !== 0) return pairs;
    for (let start = 0; start < imageCount; start += groupSize) {
        for (let i = start; i < start + groupSize; i++) {
            for (let j = i + 1; j < start + groupSize; j++) {
                pairs.push([i, j]);
            }
        }
    }
    return pairs;
}

async function makeAutoGroups(images: string[], tools: HuginTools, workDir: string, maxFallbackCandidates: number): Promise<GroupingResult> {
    if (images.length < 2) {
        return {
            groups: [{ images, imageIndexes: images.map((_, i) => i), passthrough: true }],
            resolvedGroupSize: 'auto',
            mode: 'auto',
            pairs: [],
            warnings: [],
        };
    }

    console.log(`[情報] 低解像度の重なり検出でページ組を自動判定します (${images.length}ページ)`);
    const autoDir = path.join(workDir, 'auto-group');
    fs.mkdirSync(autoDir, { recursive: true });
    const previewImages = await createAutoGroupPreviews(images, workDir);
    const candidateLimit = Math.min(16, Math.max(8, maxFallbackCandidates * 2));
    const pairs: AutoPairScore[] = [];
    const pairCache = new Map<string, AutoPairScore>();

    const probeAndStore = async (a: number, b: number) => {
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        if (pairCache.has(key)) return pairCache.get(key)!;
        const pair = await probeAutoPair(previewImages, a, b, tools, autoDir, candidateLimit);
        pairCache.set(key, pair);
        pairs.push(pair);
        const label = pair.accepted ? '採用' : '弱い';
        const candidate = pair.candidate || 'なし';
        console.log(`[auto-group] ${a + 1}-${b + 1}: ${label} cp=${pair.controlPoints} candidate=${candidate}`);
        return pair;
    };

    for (const groupSize of [2, 3, 4]) {
        for (const [a, b] of sequentialRequiredPairs(images.length, groupSize)) {
            await probeAndStore(a, b);
        }
        const sequential = connectedSequentialGroups(images, pairs, [groupSize]);
        if (sequential) {
            console.log(`[auto-group] 連続${sequential.groupSize}枚のグループとして判定しました`);
            console.log(`[auto-group] ${sequential.groups.map(group => `{${group.imageIndexes!.map(index => index + 1).join(',')}}`).join(' ')}`);
            return {
                groups: sequential.groups,
                resolvedGroupSize: sequential.groupSize,
                mode: 'auto',
                pairs,
                warnings: [],
            };
        }
    }

    for (const [a, b] of autoPairIndexes(images.length)) {
        await probeAndStore(a, b);
    }

    const warnings: string[] = [];
    const acceptedCount = pairs.filter(pair => pair.accepted).length;

    if (acceptedCount === 0) {
        throw new Error('自動グループ判定で信頼できる重なりを検出できませんでした。重なりのない隣接画像は、Huginでは自動判別できません。');
    }

    const sequential = connectedSequentialGroups(images, pairs);
    if (sequential) {
        console.log(`[auto-group] 連続${sequential.groupSize}枚のグループとして判定しました`);
        console.log(`[auto-group] ${sequential.groups.map(group => `{${group.imageIndexes!.map(index => index + 1).join(',')}}`).join(' ')}`);
        return {
            groups: sequential.groups,
            resolvedGroupSize: sequential.groupSize,
            mode: 'auto',
            pairs,
            warnings,
        };
    }

    const groups = autoGroupsFromPairs(images, pairs);
    const multiGroups = groups.filter(group => group.images.length > 1);
    const singleGroups = groups.filter(group => group.images.length === 1);
    if (multiGroups.length === 0) {
        throw new Error('自動グループ判定で2枚以上のページ組を作れませんでした。');
    }
    if (singleGroups.length > 0) {
        warnings.push(`結合相手を検出できなかったページがあります: ${singleGroups.map(group => (group.imageIndexes![0] + 1)).join(', ')}`);
    }

    console.log(`[auto-group] ${groups.map(group => `{${group.imageIndexes!.map(index => index + 1).join(',')}}`).join(' ')}`);
    return {
        groups,
        resolvedGroupSize: 'auto',
        mode: 'auto',
        pairs,
        warnings,
    };
}

async function makeGroups(images: string[], groupSize: number | 'auto', tools: HuginTools, workDir: string, maxFallbackCandidates: number): Promise<GroupingResult> {
    if (groupSize !== 'auto') {
        return makeFixedGroups(images, groupSize);
    }
    return makeAutoGroups(images, tools, workDir, maxFallbackCandidates);
}

async function runHuginCandidate(
    group: StitchGroup,
    tools: HuginTools,
    groupDir: string,
    index: number,
    candidate: HuginCandidate,
    rotationCache: Map<string, string>,
    stitchNow = true,
): Promise<HuginPreparedResult> {
    const candidateDir = path.join(groupDir, safeNamePart(candidate.name));
    const cacheDir = path.join(groupDir, '_rotated');
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const images = await candidateImages(group, candidate, cacheDir, rotationCache);
    let projectPath = path.join(candidateDir, `group_${index + 1}_01_gen.pto`);
    const prefix = path.join(candidateDir, `stitched_${String(index + 1).padStart(4, '0')}`);

    await runCommand(tools.ptoGen, ['--projection=0', '--fov=10', '-o', projectPath, ...images], candidateDir);

    for (let i = 1; i < images.length; i++) {
        const nextPath = path.join(candidateDir, `group_${index + 1}_02_lens_${i}.pto`);
        await runCommand(tools.ptoLensstack, ['--new-lens', `i${i}`, '-o', nextPath, projectPath], candidateDir);
        projectPath = nextPath;
    }

    let cpInputPath = projectPath;
    if (candidate.edgeMatch && images.length === 2) {
        const cropPath = path.join(candidateDir, `group_${index + 1}_025_edge_crop.pto`);
        await applyEdgeCrop(tools, projectPath, cropPath, images, candidate.edgeMatch, candidateDir);
        cpInputPath = cropPath;
    }

    const cpPath = path.join(candidateDir, `group_${index + 1}_03_cp.pto`);
    const cpfindArgs = candidate.edgeMatch || candidate.allPairs ? edgeCpfindArgs() : ['--multirow'];
    await runCommand(tools.cpfind, [...cpfindArgs, '-o', cpPath, cpInputPath], candidateDir);
    let cpCount = countControlPoints(cpPath);
    if (cpCount < MIN_HUGIN_CONTROL_POINTS) {
        throw new Error(`制御点が少なすぎます: ${cpCount}`);
    } else if (cpCount < MIN_PROMISING_HUGIN_CONTROL_POINTS) {
        throw new Error(`制御点が弱すぎます: ${cpCount}`);
    }

    let cleanInputPath = cpPath;
    if (candidate.edgeMatch && images.length === 2) {
        const uncropPath = path.join(candidateDir, `group_${index + 1}_035_uncrop.pto`);
        await clearImageCrops(tools, cpPath, uncropPath, images, candidateDir);
        cleanInputPath = uncropPath;
    }

    const cleanPath = path.join(candidateDir, `group_${index + 1}_04_clean.pto`);
    await runCommand(tools.cpclean, ['-o', cleanPath, cleanInputPath], candidateDir);
    cpCount = countControlPoints(cleanPath);
    if (cpCount < MIN_HUGIN_CONTROL_POINTS) {
        throw new Error(`cpclean後の制御点が少なすぎます: ${cpCount}`);
    } else if (cpCount < MIN_PROMISING_HUGIN_CONTROL_POINTS) {
        throw new Error(`cpclean後の制御点が弱すぎます: ${cpCount}`);
    }

    const linePath = path.join(candidateDir, `group_${index + 1}_05_lines.pto`);
    await runCommand(tools.linefind, ['-o', linePath, cleanPath], candidateDir);

    const varPath = path.join(candidateDir, `group_${index + 1}_06_var.pto`);
    await runCommand(tools.ptoVar, [
        '--set',
        'TrZ=0',
        '--opt',
        mosaicOptimizerVariables(images.length),
        '-o',
        varPath,
        linePath,
    ], candidateDir);

    const optPath = path.join(candidateDir, `group_${index + 1}_07_opt.pto`);
    const optResult = await runCommand(tools.autooptimiser, ['-n', '-o', optPath, varPath], candidateDir);
    const rms = parseLastRms(optResult.output);
    if (rms === null || rms > 2) {
        throw new Error(`RMSが大きすぎます: ${formatMetric(rms)}`);
    }

    const renderPath = path.join(candidateDir, `group_${index + 1}_08_render.pto`);
    await runCommand(tools.panoModify, [
        '--projection=0',
        '--fov=AUTO',
        '--center',
        '--canvas=AUTO',
        '--crop=AUTO',
        '--output-type=NORMAL',
        '--ldr-file=PNG',
        '--blender=INTERNAL',
        '-o',
        renderPath,
        optPath,
    ], candidateDir);

    patchPtoForPng(renderPath);
    const prepared: HuginPreparedResult = {
        imagePath: null,
        candidate: candidate.name,
        cpCount,
        rms,
        activeImages: null,
        candidateDir,
        prefix,
        renderPath,
        imageCount: images.length,
    };
    if (!stitchNow) return prepared;

    const finalized = await stitchPreparedCandidate(prepared, tools);
    return {
        ...prepared,
        imagePath: finalized.imagePath,
        activeImages: finalized.activeImages,
    };
}

async function stitchPreparedCandidate(prepared: HuginPreparedResult, tools: HuginTools): Promise<HuginGroupResult> {
    if (prepared.imagePath) {
        return {
            imagePath: prepared.imagePath,
            candidate: prepared.candidate,
            cpCount: prepared.cpCount,
            rms: prepared.rms,
            activeImages: prepared.activeImages,
        };
    }

    const stitchResult = await runCommand(tools.huginExecutor, ['--stitching', `--prefix=${prepared.prefix}`, prepared.renderPath], prepared.candidateDir);
    let activeImages = parseActiveImages(stitchResult.output);

    let stitched = findNewestOutputImage(prepared.candidateDir, path.basename(prepared.prefix));
    if (!stitched) {
        const nonaPrefix = `${prepared.prefix}_nona`;
        await runCommand(tools.nona, ['-m', 'PNG', '-o', nonaPrefix, prepared.renderPath], prepared.candidateDir);
        stitched = findNewestOutputImage(prepared.candidateDir, path.basename(nonaPrefix));
        if (activeImages === null) activeImages = prepared.imageCount;
    }
    if (!stitched) {
        throw new Error(`Huginの出力PNG/JPEGが見つかりません: ${prepared.candidateDir}`);
    }
    return {
        imagePath: stitched,
        candidate: prepared.candidate,
        cpCount: prepared.cpCount,
        rms: prepared.rms,
        activeImages,
    };
}

async function runHuginGroup(group: StitchGroup, tools: HuginTools, groupDir: string, index: number, maxFallbackCandidates: number): Promise<HuginGroupResult> {
    fs.mkdirSync(groupDir, { recursive: true });
    const rotationCache = new Map<string, string>();
    const imageCount = group.images.length;
    const normal: HuginCandidate = {
        name: 'normal',
        rotations: group.images.map(() => 0),
        edgeMatch: null,
    };

    let best: HuginPreparedResult | null = null;
    const tryCandidate = async (candidate: HuginCandidate, stitchNow = true) => {
        try {
            const result = await runHuginCandidate(group, tools, groupDir, index, candidate, rotationCache, stitchNow);
            console.log(`[hugin] group ${index + 1}: candidate=${result.candidate} cp=${result.cpCount} rms=${formatMetric(result.rms)} active=${result.activeImages ?? 'n/a'}`);
            if (!best || huginCandidateScore(result, imageCount) > huginCandidateScore(best, imageCount)) {
                best = result;
            }
            return result;
        } catch (err) {
            console.warn(`[hugin] group ${index + 1}: candidate=${candidate.name} をスキップ: ${err.message}`);
            return null;
        }
    };

    const normalResult = await tryCandidate(normal, true);
    if (!normalResult || !isStrongHuginCandidate(normalResult, imageCount)) {
        console.warn(`[hugin] group ${index + 1}: 通常マッチングが弱いため、端領域と回転候補を試します。`);
        const allFallbackCandidates = buildFallbackCandidates(imageCount);
        const fallbackCandidates = allFallbackCandidates.slice(0, maxFallbackCandidates);
        if (fallbackCandidates.length < allFallbackCandidates.length) {
            console.warn(`[hugin] group ${index + 1}: 追加候補を${fallbackCandidates.length}件に制限します`);
        }
        for (const candidate of fallbackCandidates) {
            const result = await tryCandidate(candidate, false);
            if (result && isPromisingHuginCandidate(result)) break;
        }
    }

    if (!best) {
        throw new Error(`Huginでページ ${index + 1} を復元できませんでした`);
    }
    if (!isPromisingHuginCandidate(best)) {
        throw new Error(`ページ ${index + 1} の信頼できる重なりを検出できませんでした (best=${best.candidate}, cp=${best.cpCount}, rms=${formatMetric(best.rms)})`);
    }
    if (!best.imagePath) {
        console.log(`[hugin] group ${index + 1}: selected=${best.candidate} をステッチします`);
    }
    const finalized = await stitchPreparedCandidate(best, tools);
    if (finalized.activeImages !== null && finalized.activeImages < imageCount) {
        throw new Error(`ページ ${index + 1} の一部画像しか有効化されませんでした (active=${finalized.activeImages}/${imageCount}, best=${finalized.candidate})`);
    }
    console.log(`[hugin] group ${index + 1}: selected=${finalized.candidate} cp=${finalized.cpCount} rms=${formatMetric(finalized.rms)} active=${finalized.activeImages ?? 'n/a'}`);
    return finalized;
}

async function encodeImageForPdf(outDoc: any, imagePath: string, format: 'jpeg' | 'png', jpegQuality: number) {
    if (format === 'png') {
        const bytes = fs.readFileSync(imagePath);
        if (/\.jpe?g$/i.test(imagePath)) {
            return {
                image: await outDoc.embedJpg(bytes),
                info: { input: imagePath, format: 'jpeg', bytes: bytes.length } as PdfImageInfo,
            };
        }
        return {
            image: await outDoc.embedPng(bytes),
            info: { input: imagePath, format: 'png', bytes: bytes.length } as PdfImageInfo,
        };
    }

    const img = await loadImage(imagePath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const bytes = canvas.toBuffer('image/jpeg', {
        quality: jpegQuality,
        progressive: true,
        chromaSubsampling: true,
    });
    return {
        image: await outDoc.embedJpg(bytes),
        info: { input: imagePath, format: 'jpeg', bytes: bytes.length } as PdfImageInfo,
    };
}

async function imagesToPdf(imagePaths: string[], dpi: number, format: 'jpeg' | 'png', jpegQuality: number): Promise<{ bytes: Buffer; images: PdfImageInfo[] }> {
    const outDoc = await PDFDocument.create();
    const encodedImages: PdfImageInfo[] = [];
    console.log(`[情報] PDF内画像を ${format}${format === 'jpeg' ? ` (quality=${jpegQuality.toFixed(2)})` : ''} で保存します`);
    for (const imagePath of imagePaths) {
        const { image, info } = await encodeImageForPdf(outDoc, imagePath, format, jpegQuality);
        encodedImages.push(info);
        const widthPt = image.width / dpi * 72;
        const heightPt = image.height / dpi * 72;
        const page = outDoc.addPage([widthPt, heightPt]);
        page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
    }
    return {
        bytes: Buffer.from(await outDoc.save()),
        images: encodedImages,
    };
}

async function stitchPdf(inputPath: string, options: StitchOptions) {
    const pdfPath = path.resolve(inputPath);
    if (!fs.existsSync(pdfPath)) throw new Error(`PDFが見つかりません: ${pdfPath}`);
    if (path.extname(pdfPath).toLowerCase() !== '.pdf') throw new Error(`PDFファイルを指定してください: ${pdfPath}`);

    const tools = resolveStitchEngine(getToolConfig('stitchEngine') || {});
    const outputPath = path.resolve(options.outputPath || uniqueOutputPath(pdfPath));
    const renderDpi = resolveDpi(options.dpi);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-stitch-hugin-'));
    const imageDir = path.join(workDir, 'pages');
    const groupDir = path.join(workDir, 'hugin');

    try {
        console.log(`[情報] PDFを画像化しています: ${path.basename(pdfPath)} / ${options.dpi === 'auto' ? `auto (${renderDpi}dpi)` : `${renderDpi}dpi`}`);
        const imagePaths = await extractPdfToImages(pdfPath, imageDir, renderDpi);
        if (imagePaths.length === 0) throw new Error('PDFから画像を取り出せませんでした');

        const inputDeskewed = await deskewImages(imagePaths, workDir, options.deskew === 'auto', 'input');
        const deskewed = inputDeskewed;
        let stitchedImages: string[] = [];
        let pages: any[] = [];
        let resolvedGroupSize: number | 'auto' = options.groupSize;
        let groupingReport: any = null;

        const grouping = await makeGroups(deskewed.images, options.groupSize, tools, workDir, options.maxFallbackCandidates);
        const { groups } = grouping;
        resolvedGroupSize = grouping.resolvedGroupSize;
        groupingReport = {
            mode: grouping.mode,
            groupSize: resolvedGroupSize,
            warnings: grouping.warnings,
            pairs: grouping.pairs.map(pair => ({
                pages: [pair.a + 1, pair.b + 1],
                accepted: pair.accepted,
                controlPoints: pair.controlPoints,
                candidate: pair.candidate,
                rotations: pair.rotations,
                edgeMatch: pair.edgeMatch,
                error: pair.error,
            })),
        };
        console.log(`[情報] Huginで ${imagePaths.length}ページを ${groups.length}ページへ復元します (group-size=${resolvedGroupSize})`);
        for (const warning of grouping.warnings) {
            console.warn(`[auto-group] ${warning}`);
        }

        for (let i = 0; i < groups.length; i++) {
            if (groups[i].images.length === 1) {
                stitchedImages.push(groups[i].images[0]);
                pages.push({
                    index: i + 1,
                    output: groups[i].images[0],
                    inputs: groups[i].images,
                    inputPages: groups[i].imageIndexes?.map(index => index + 1) || [i + 1],
                    passthrough: true,
                    hugin: null,
                });
                console.log(`[hugin] group ${i + 1}: single page passthrough`);
                continue;
            }
            const result = await runHuginGroup(groups[i], tools, path.join(groupDir, `group_${String(i + 1).padStart(4, '0')}`), i, options.maxFallbackCandidates);
            stitchedImages.push(result.imagePath);
            pages.push({
                index: i + 1,
                output: result.imagePath,
                inputs: groups[i].images,
                inputPages: groups[i].imageIndexes?.map(index => index + 1) || groups[i].images.map((_, offset) => i + offset + 1),
                autoScore: groups[i].autoScore,
                hugin: {
                    candidate: result.candidate,
                    controlPoints: result.cpCount,
                    rms: result.rms,
                    activeImages: result.activeImages,
                },
            });
            console.log(`[hugin] group ${i + 1}: ok`);
        }

        const outputDeskewed = await deskewImages(stitchedImages, workDir, options.deskew === 'auto', 'output');
        for (let i = 0; i < pages.length; i++) {
            pages[i].output = outputDeskewed.images[i];
            pages[i].deskew = outputDeskewed.pages[i];
        }

        const pdfResult = await imagesToPdf(outputDeskewed.images, renderDpi, options.pdfImageFormat, options.jpegQuality);
        fs.writeFileSync(outputPath, pdfResult.bytes);

        const reportPath = outputPath.replace(/\.pdf$/i, '_stitch_report.json');
        fs.writeFileSync(reportPath, JSON.stringify({
            ok: true,
            backend: 'hugin',
            groupSize: resolvedGroupSize,
            grouping: groupingReport,
            dpi: renderDpi,
            maxFallbackCandidates: options.maxFallbackCandidates,
            pdfImage: {
                format: options.pdfImageFormat,
                jpegQuality: options.jpegQuality,
                images: pdfResult.images,
            },
            deskew: {
                input: inputDeskewed.pages,
                output: outputDeskewed.pages,
            },
            pages,
        }, null, 2), 'utf-8');

        console.log(`[成功] ${outputPath} に保存しました (${stitchedImages.length} ページ)`);
        console.log(`[成功] ${reportPath} にレポートを保存しました`);
        if (options.keepTemp) {
            console.log(`[情報] 中間ファイル: ${workDir}`);
        }
    } finally {
        if (!options.keepTemp) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help || parsed.inputPaths.length === 0) {
        printUsage();
        return;
    }

    if (parsed.inputPaths.length > 1 && parsed.options.outputPath) {
        throw new Error('複数PDFを処理するときは --output を指定できません');
    }

    for (const inputPath of parsed.inputPaths) {
        await stitchPdf(inputPath, parsed.options);
    }
}

main().catch(err => {
    console.error(`[エラー] ${err.message}`);
    process.exitCode = 1;
});
