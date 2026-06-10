/**
 * 分割スキャンされたPDFページを復元するツール。
 *
 * 位相相関で重なりを自動検出し、パッチマッチングによる剛体変換で
 * 位置合わせしてフェザーブレンドで合成します。外部ツールは不要です。
 *
 * 例:
 *   node stitch_pages.js input.pdf --group-size auto --dpi auto
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { PDFDocument } = require('pdf-lib');
const { extractPdfToImages } = require('./lib/pdf_to_image');
const { getToolConfig } = require('./lib/gemini_client');
const { planGroups, stitchGroupImage } = require('./lib/stitch_core');

type StitchOptions = {
    groupSize: number | 'auto';
    dpi: number | 'auto';
    deskew: 'auto' | 'off';
    pdfImageFormat: 'jpeg' | 'png';
    jpegQuality: number;
    outputPath: string | null;
    keepTemp: boolean;
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

function printUsage() {
    console.log("-------------------------------------------------------");
    console.log(" PDFページ復元ツール");
    console.log("");
    console.log(" 分割スキャンしたページを位置合わせして1ページへ復元し、PDFにします。");
    console.log(" 位相相関の重なり検出でページ組と配置を自動判定します。外部ツールは不要です。");
    console.log("");
    console.log(" 使い方:");
    console.log("   node stitch_pages.js <PDF> [オプション]");
    console.log("");
    console.log(" オプション:");
    console.log("   --group-size auto|<n>  何ページを1ページへ復元するか（既定: auto = 自動グループ判定）");
    console.log("   --dpi auto|<n>         PDF画像化DPI（既定: auto = 300）");
    console.log("   --deskew auto|off      合成前後に水平/垂直特徴で小角度の傾きを補正（既定: auto）");
    console.log("   --pdf-image-format jpeg|png  PDF内の画像形式（既定: jpeg）");
    console.log("   --jpeg-quality <0.1-1.0>     JPEG品質（既定: 0.86）");
    console.log("   --output <path>        出力PDFパス");
    console.log("   --keep-temp            中間PNGを残す");
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
        outputPath: null,
        keepTemp: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--group-size') {
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

// ---------------------------------------------------------------------------
// 傾き補正
// ---------------------------------------------------------------------------

function normalizeRotationDegrees(angle: number) {
    let value = Number(angle) || 0;
    value %= 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return value;
}

async function writeRotatedImageFile(inputPath: string, outputPath: string, angle: number) {
    const normalized = normalizeRotationDegrees(angle);
    const img = await loadImage(inputPath);
    const radians = normalized * Math.PI / 180;
    const sin = Math.abs(Math.sin(radians));
    const cos = Math.abs(Math.cos(radians));
    const rotatedWidth = img.width * cos + img.height * sin;
    const rotatedHeight = img.width * sin + img.height * cos;
    const canvas = createCanvas(Math.max(1, Math.ceil(rotatedWidth)), Math.max(1, Math.ceil(rotatedHeight)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(radians);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
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

    // 文字や罫線の直交特徴は枠線フィットより外れにくいので優先する。
    if (orthogonalDeskew && orthogonalDeskew.confidence >= 0.12) {
        return orthogonalDeskew;
    }
    if (borderDeskew) {
        return borderDeskew;
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

// ---------------------------------------------------------------------------
// PDF出力
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function stitchPdf(inputPath: string, options: StitchOptions) {
    const pdfPath = path.resolve(inputPath);
    if (!fs.existsSync(pdfPath)) throw new Error(`PDFが見つかりません: ${pdfPath}`);
    if (path.extname(pdfPath).toLowerCase() !== '.pdf') throw new Error(`PDFファイルを指定してください: ${pdfPath}`);

    const outputPath = path.resolve(options.outputPath || uniqueOutputPath(pdfPath));
    const renderDpi = resolveDpi(options.dpi);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-stitch-'));
    const imageDir = path.join(workDir, 'pages');
    const stitchedDir = path.join(workDir, 'stitched');

    try {
        console.log(`[情報] PDFを画像化しています: ${path.basename(pdfPath)} / ${options.dpi === 'auto' ? `auto (${renderDpi}dpi)` : `${renderDpi}dpi`}`);
        const imagePaths = await extractPdfToImages(pdfPath, imageDir, renderDpi);
        if (imagePaths.length === 0) throw new Error('PDFから画像を取り出せませんでした');

        const inputDeskewed = await deskewImages(imagePaths, workDir, options.deskew === 'auto', 'input');

        const plan = await planGroups(inputDeskewed.images, options.groupSize, console.log);
        console.log(`[情報] ${imagePaths.length}ページを ${plan.groups.length}ページへ復元します (group-size=${plan.resolvedGroupSize})`);
        for (const warning of plan.warnings) {
            console.warn(`[auto-group] ${warning}`);
        }

        const stitchedImages: string[] = [];
        const pages: any[] = [];
        fs.mkdirSync(stitchedDir, { recursive: true });
        for (let i = 0; i < plan.groups.length; i++) {
            const group = plan.groups[i];
            if (group.indexes.length === 1) {
                const imagePath = plan.pages[group.indexes[0]].path;
                stitchedImages.push(imagePath);
                pages.push({
                    index: i + 1,
                    output: imagePath,
                    inputs: [imagePath],
                    inputPages: [group.indexes[0] + 1],
                    passthrough: true,
                    stitch: null,
                });
                console.log(`[stitch] group ${i + 1}: single page passthrough`);
                continue;
            }
            const groupPages = group.indexes.map(index => plan.pages[index]);
            const groupOutput = path.join(stitchedDir, `group_${String(i + 1).padStart(4, '0')}.png`);
            const result = await stitchGroupImage(groupPages, group.links, groupOutput, console.log);
            stitchedImages.push(result.outputPath);
            pages.push({
                index: i + 1,
                output: result.outputPath,
                inputs: groupPages.map(page => page.path),
                inputPages: group.indexes.map(index => index + 1),
                stitch: {
                    width: result.width,
                    height: result.height,
                    pairs: result.pairs,
                },
            });
            console.log(`[stitch] group ${i + 1}: ok (${result.width}x${result.height})`);
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
            backend: 'phase-correlation',
            groupSize: plan.resolvedGroupSize,
            grouping: {
                mode: plan.mode,
                groupSize: plan.resolvedGroupSize,
                warnings: plan.warnings,
                pairs: plan.pairs.map(pair => ({
                    pages: [pair.a + 1, pair.b + 1],
                    accepted: pair.accepted,
                    peak: pair.peak,
                    ratio: pair.ratio,
                    kind: pair.kind,
                    edge: pair.edge,
                    rotationB: pair.rotationB,
                    previewSize: pair.previewSize,
                })),
            },
            dpi: renderDpi,
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
