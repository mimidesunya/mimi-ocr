/**
 * 分割スキャン画像の自動ペア判定・位置合わせ・合成を行うコア。
 *
 * 外部ツールに依存せず、次の3段階で処理します。
 *   1. ペア判定: 縮小プレビューの勾配画像をFFT位相相関にかけ、
 *      回転仮説(0/180、寸法が転置していれば90/270)ごとに相対配置を推定する。
 *   2. 精密位置合わせ: 重なり領域に小パッチを敷き、ピラミッドNCC探索と
 *      サブピクセル補間で対応点を集め、剛体変換(平行移動+微小回転)をフィットする。
 *   3. 合成: 重なり帯の中で両画像の差が最小になる縫い目を動的計画法で求め、
 *      縫い目の両側で片方の画像だけを採用する(ブレンドによるゴーストを避ける)。
 *      明度ゲインも補正する。
 */
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

export type Rotation = 0 | 90 | 180 | 270;

export type Affine = {
    a: number; b: number; e: number;
    c: number; d: number; f: number;
};

type GrayImage = {
    width: number;
    height: number;
    data: Float32Array;
};

export type PageInfo = {
    index: number;
    path: string;
    width: number;
    height: number;
};

export type ProbeAlternate = {
    rot: Rotation;
    kind: 'full' | 'strip';
    peak: number;
    ratio: number;
    edge: 'left' | 'right' | 'top' | 'bottom';
    offsetFull: { dx: number; dy: number };
    verify: { patches: number; inliers: number; meanNcc: number };
};

type PairProbe = {
    a: number;
    b: number;
    accepted: boolean;
    rotationB: Rotation;
    peak: number;
    ratio: number;
    kind: 'full' | 'strip' | null;
    edge: 'left' | 'right' | 'top' | 'bottom' | null;
    offsetFull: { dx: number; dy: number } | null;
    previewSize: number;
    verify: { patches: number; inliers: number; meanNcc: number } | null;
    alternates?: ProbeAlternate[];
    error?: string;
};

export type PairRefinement = {
    matrix: Affine;
    thetaDeg: number;
    patches: number;
    inliers: number;
    rmse: number | null;
    gain: number;
    method: 'rigid' | 'translation';
};

export type GroupPlan = {
    indexes: number[];
    links: PairProbe[];
    passthrough: boolean;
};

export type GroupingPlan = {
    pages: PageInfo[];
    groups: GroupPlan[];
    mode: 'fixed' | 'auto';
    resolvedGroupSize: number | 'auto';
    pairs: PairProbe[];
    warnings: string[];
};

export type GroupStitchReport = {
    outputPath: string;
    width: number;
    height: number;
    pairs: Array<{
        pages: [number, number];
        rotationB: Rotation;
        peak: number;
        method: string;
        thetaDeg: number;
        patches: number;
        inliers: number;
        rmse: number | null;
        gain: number;
    }>;
};

type Logger = (message: string) => void;

const PREVIEW_SIZE = 480;
const PREVIEW_SIZE_FINE = 960;
const EDGE_TAPER_PX = 4;
const NOMINATE_FULL_PEAK = 0.006;
const NOMINATE_STRIP_PEAK = 0.015;
const NOMINATE_LIMIT = 4;
const STRIP_FRACTION = 0.35;
const VERIFY_PATCH_HALF = 12;
const VERIFY_SEARCH_RADIUS = 10;
const VERIFY_PATCH_TARGET = 16;
const VERIFY_MIN_TEXTURE_STDDEV = 3;
const VERIFY_NCC_ACCEPT = 0.45;
const VERIFY_CONSENSUS_TOL = 3.5;
const VERIFY_MIN_INLIERS = 4;
const VERIFY_MIN_MEAN_NCC = 0.55;
const VERIFY_MIN_INLIER_RATIO = 0.65;
const VERIFY_STRONG_INLIERS = 8;
const VERIFY_STRONG_MEAN_NCC = 0.65;
const VERIFY_STRONG_INLIER_RATIO = 0.75;
const MIN_OVERLAP_FRAC = 0.008;
const MAX_OVERLAP_FRAC = 0.95;
const NEAR_IDENTITY_OVERLAP_FRAC = 0.9;
const NEAR_IDENTITY_MIN_SHIFT_FRAC = 0.02;
const MIN_LATERAL_COVER = 0.6;
const MAX_LATERAL_SHIFT_FRAC = 0.3;
const AUTO_PAIR_WINDOW = 4;
const MAX_GROUP_SIZE = 4;
const FFT_CACHE_LIMIT = 20;
const REFINE_PATCH_TARGET = 24;
const REFINE_PATCH_HALF = 32;
const REFINE_MIN_TEXTURE_STDDEV = 4;
const REFINE_QUARTER_RADIUS = 14;
const REFINE_NCC_ACCEPT = 0.45;
const REFINE_MIN_INLIERS = 5;
const REFINE_MAX_THETA_DEG = 3;
const BLEND_EDGE_INSET_PX = 4;
const SEAM_BLEND_PX = 3;

// ---------------------------------------------------------------------------
// アフィン変換 (x' = a*x + b*y + e, y' = c*x + d*y + f)
// ---------------------------------------------------------------------------

function affineIdentity(): Affine {
    return { a: 1, b: 0, e: 0, c: 0, d: 1, f: 0 };
}

function affineTranslation(tx: number, ty: number): Affine {
    return { a: 1, b: 0, e: tx, c: 0, d: 1, f: ty };
}

function affineRigid(theta: number, tx: number, ty: number): Affine {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return { a: cos, b: -sin, e: tx, c: sin, d: cos, f: ty };
}

/** m∘n: nを先に適用してからmを適用する合成変換。 */
function affineCompose(m: Affine, n: Affine): Affine {
    return {
        a: m.a * n.a + m.b * n.c,
        b: m.a * n.b + m.b * n.d,
        e: m.a * n.e + m.b * n.f + m.e,
        c: m.c * n.a + m.d * n.c,
        d: m.c * n.b + m.d * n.d,
        f: m.c * n.e + m.d * n.f + m.f,
    };
}

function affineInvert(m: Affine): Affine {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) throw new Error('変換行列を逆変換できません');
    const ia = m.d / det;
    const ib = -m.b / det;
    const ic = -m.c / det;
    const id = m.a / det;
    return {
        a: ia, b: ib, e: -(ia * m.e + ib * m.f),
        c: ic, d: id, f: -(ic * m.e + id * m.f),
    };
}

function affineApply(m: Affine, x: number, y: number): [number, number] {
    return [m.a * x + m.b * y + m.e, m.c * x + m.d * y + m.f];
}

/** 元画像座標 → rot度回転後の画像座標。 */
function rotationAffine(rot: Rotation, width: number, height: number): Affine {
    if (rot === 90) return { a: 0, b: -1, e: height, c: 1, d: 0, f: 0 };
    if (rot === 180) return { a: -1, b: 0, e: width, c: 0, d: -1, f: height };
    if (rot === 270) return { a: 0, b: 1, e: 0, c: -1, d: 0, f: width };
    return affineIdentity();
}

function rotatedSize(rot: Rotation, width: number, height: number): [number, number] {
    return rot === 90 || rot === 270 ? [height, width] : [width, height];
}

// ---------------------------------------------------------------------------
// グレースケール画像
// ---------------------------------------------------------------------------

function rgbaToGray(data: Uint8ClampedArray, width: number, height: number): GrayImage {
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
        gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return { width, height, data: gray };
}

function imageToGray(img: any, maxSide: number): { gray: GrayImage; scale: number } {
    // 一度に大縮小するとバイリニア補間がエイリアシングを起こし、
    // 印刷物の網点がモアレnoiseになって位相相関を損なうため、半分ずつ縮小する。
    let src: any = img;
    let srcW = img.width;
    let srcH = img.height;
    while (Math.max(srcW, srcH) > maxSide * 2) {
        const w = Math.max(1, Math.ceil(srcW / 2));
        const h = Math.max(1, Math.ceil(srcH / 2));
        const c = createCanvas(w, h);
        const cctx = c.getContext('2d');
        cctx.fillStyle = '#ffffff';
        cctx.fillRect(0, 0, w, h);
        cctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, w, h);
        src = c;
        srcW = w;
        srcH = h;
    }
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { gray: rgbaToGray(data, width, height), scale: img.width / width };
}

/** 3x3二項フィルタで軽く平滑化し、スキャンノイズと残留モアレを抑える。 */
function blur3x3(src: GrayImage): GrayImage {
    const { width, height, data } = src;
    const out = new Float32Array(width * height);
    out.set(data);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            out[idx] = (
                data[idx - width - 1] + 2 * data[idx - width] + data[idx - width + 1]
                + 2 * data[idx - 1] + 4 * data[idx] + 2 * data[idx + 1]
                + data[idx + width - 1] + 2 * data[idx + width] + data[idx + width + 1]
            ) / 16;
        }
    }
    return { width, height, data: out };
}

function rotateGray(src: GrayImage, rot: Rotation): GrayImage {
    if (rot === 0) return src;
    const [width, height] = rotatedSize(rot, src.width, src.height);
    const out = new Float32Array(width * height);
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const value = src.data[y * src.width + x];
            let nx: number;
            let ny: number;
            if (rot === 90) {
                nx = src.height - 1 - y;
                ny = x;
            } else if (rot === 180) {
                nx = src.width - 1 - x;
                ny = src.height - 1 - y;
            } else {
                nx = y;
                ny = src.width - 1 - x;
            }
            out[ny * width + nx] = value;
        }
    }
    return { width, height, data: out };
}

/** 中央差分の勾配強度画像。照明差を消し、文字や罫線の構造だけを残す。 */
function gradientMagnitude(src: GrayImage): GrayImage {
    const { width, height, data } = src;
    const out = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const gx = data[idx + 1] - data[idx - 1];
            const gy = data[idx + width] - data[idx - width];
            out[idx] = Math.abs(gx) + Math.abs(gy);
        }
    }
    return { width, height, data: out };
}

function taperEdges(src: GrayImage, taper: number) {
    const { width, height, data } = src;
    const ramp = (i: number, n: number) => {
        const d = Math.min(i, n - 1 - i);
        if (d >= taper) return 1;
        return 0.5 - 0.5 * Math.cos(Math.PI * (d + 0.5) / taper);
    };
    for (let y = 0; y < height; y++) {
        const wy = ramp(y, height);
        for (let x = 0; x < width; x++) {
            data[y * width + x] *= wy * ramp(x, width);
        }
    }
}

function downsampleGray(src: GrayImage, factor: number): GrayImage {
    const width = Math.max(1, Math.floor(src.width / factor));
    const height = Math.max(1, Math.floor(src.height / factor));
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = 0; dy < factor; dy++) {
                const sy = y * factor + dy;
                const off = sy * src.width + x * factor;
                for (let dx = 0; dx < factor; dx++) {
                    sum += src.data[off + dx];
                }
            }
            out[y * width + x] = sum / (factor * factor);
        }
    }
    return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// FFTと位相相関
// ---------------------------------------------------------------------------

function fft1d(re: Float64Array, im: Float64Array, n: number, inverse: boolean) {
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = (inverse ? 2 : -2) * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curRe = 1;
            let curIm = 0;
            for (let k = 0; k < half; k++) {
                const i0 = i + k;
                const i1 = i0 + half;
                const bRe = re[i1] * curRe - im[i1] * curIm;
                const bIm = re[i1] * curIm + im[i1] * curRe;
                re[i1] = re[i0] - bRe;
                im[i1] = im[i0] - bIm;
                re[i0] += bRe;
                im[i0] += bIm;
                const nextRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nextRe;
            }
        }
    }
    if (inverse) {
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}

function fft2d(re: Float32Array, im: Float32Array, width: number, height: number, inverse: boolean) {
    const tRe = new Float64Array(Math.max(width, height));
    const tIm = new Float64Array(Math.max(width, height));
    for (let y = 0; y < height; y++) {
        const off = y * width;
        for (let x = 0; x < width; x++) {
            tRe[x] = re[off + x];
            tIm[x] = im[off + x];
        }
        fft1d(tRe, tIm, width, inverse);
        for (let x = 0; x < width; x++) {
            re[off + x] = tRe[x];
            im[off + x] = tIm[x];
        }
    }
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            tRe[y] = re[y * width + x];
            tIm[y] = im[y * width + x];
        }
        fft1d(tRe, tIm, height, inverse);
        for (let y = 0; y < height; y++) {
            re[y * width + x] = tRe[y];
            im[y * width + x] = tIm[y];
        }
    }
}

type Spectrum = { re: Float32Array; im: Float32Array; width: number; height: number };

function spectrumOfGray(gray: GrayImage, padW: number, padH: number): Spectrum {
    const grad = gradientMagnitude(blur3x3(gray));
    let mean = 0;
    for (let i = 0; i < grad.data.length; i++) mean += grad.data[i];
    mean /= grad.data.length;
    for (let i = 0; i < grad.data.length; i++) grad.data[i] -= mean;
    taperEdges(grad, EDGE_TAPER_PX);

    const re = new Float32Array(padW * padH);
    const im = new Float32Array(padW * padH);
    for (let y = 0; y < grad.height; y++) {
        re.set(grad.data.subarray(y * grad.width, (y + 1) * grad.width), y * padW);
    }
    fft2d(re, im, padW, padH, false);
    return { re, im, width: padW, height: padH };
}

type CorrPeak = { x: number; y: number; value: number };

type CorrSurface = { data: Float32Array; width: number; height: number };

function phaseCorrelationSurface(fa: Spectrum, fb: Spectrum): CorrSurface {
    const re = new Float32Array(fa.width * fa.height);
    const im = new Float32Array(fa.width * fa.height);
    for (let i = 0; i < re.length; i++) {
        const cr = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i];
        const ci = fa.im[i] * fb.re[i] - fa.re[i] * fb.im[i];
        const mag = Math.sqrt(cr * cr + ci * ci);
        if (mag > 1e-9) {
            re[i] = cr / mag;
            im[i] = ci / mag;
        }
    }
    fft2d(re, im, fa.width, fa.height, true);
    return { data: re, width: fa.width, height: fa.height };
}

function findTopPeaks(surface: CorrSurface, count: number, suppressRadius: number): CorrPeak[] {
    const { width, height } = surface;
    const peaks: CorrPeak[] = [];
    const work = Float32Array.from(surface.data);
    for (let n = 0; n < count; n++) {
        let bestIdx = -1;
        let bestValue = -Infinity;
        for (let i = 0; i < work.length; i++) {
            if (work[i] > bestValue) {
                bestValue = work[i];
                bestIdx = i;
            }
        }
        if (bestIdx < 0 || bestValue <= 0) break;
        const px = bestIdx % width;
        const py = Math.floor(bestIdx / width);
        peaks.push({ x: px, y: py, value: bestValue });
        for (let dy = -suppressRadius; dy <= suppressRadius; dy++) {
            const y = (py + dy + height) % height;
            for (let dx = -suppressRadius; dx <= suppressRadius; dx++) {
                const x = (px + dx + width) % width;
                work[y * width + x] = -Infinity;
            }
        }
    }
    return peaks;
}

function wrapOffset(value: number, size: number) {
    return value > size / 2 ? value - size : value;
}

// ---------------------------------------------------------------------------
// ペア判定 (位相相関)
// ---------------------------------------------------------------------------

type LayoutCheck = {
    edge: 'left' | 'right' | 'top' | 'bottom';
    overlapFrac: number;
};

/**
 * Bの原点がA座標で(dx,dy)に来る配置が、辺に沿った分割スキャンとして妥当か検査する。
 */
function validateLayout(
    dx: number, dy: number,
    wA: number, hA: number,
    wB: number, hB: number,
): LayoutCheck | null {
    const ox = Math.min(wA, dx + wB) - Math.max(0, dx);
    const oy = Math.min(hA, dy + hB) - Math.max(0, dy);
    if (ox <= 1 || oy <= 1) return null;
    const fracX = ox / Math.min(wA, wB);
    const fracY = oy / Math.min(hA, hB);

    // ほぼ同一位置の一致は、同じ版面の別ページや重複スキャンの誤検出になりやすいので弾く。
    if (fracX > NEAR_IDENTITY_OVERLAP_FRAC && fracY > NEAR_IDENTITY_OVERLAP_FRAC) {
        const shift = Math.max(Math.abs(dx) / Math.min(wA, wB), Math.abs(dy) / Math.min(hA, hB));
        if (shift < NEAR_IDENTITY_MIN_SHIFT_FRAC) return null;
    }

    const horizontal = fracX >= MIN_OVERLAP_FRAC && fracX <= MAX_OVERLAP_FRAC
        && fracY >= MIN_LATERAL_COVER
        && Math.abs(dy) <= MAX_LATERAL_SHIFT_FRAC * Math.min(hA, hB);
    const vertical = fracY >= MIN_OVERLAP_FRAC && fracY <= MAX_OVERLAP_FRAC
        && fracX >= MIN_LATERAL_COVER
        && Math.abs(dx) <= MAX_LATERAL_SHIFT_FRAC * Math.min(wA, wB);

    if (horizontal && (!vertical || fracX <= fracY)) {
        return { edge: dx > 0 ? 'right' : 'left', overlapFrac: fracX };
    }
    if (vertical) {
        return { edge: dy > 0 ? 'bottom' : 'top', overlapFrac: fracY };
    }
    return null;
}

type PreviewSet = {
    pages: PageInfo[];
    grays: GrayImage[];
    scales: number[];
    previewSize: number;
    padSize: number;
    stripPadAlong: number;
    stripPadAcross: number;
};

type StripSide = 'left' | 'right' | 'top' | 'bottom';

function cutStrip(gray: GrayImage, side: StripSide): { strip: GrayImage; offsetX: number; offsetY: number } {
    if (side === 'left' || side === 'right') {
        const sw = Math.max(16, Math.round(gray.width * STRIP_FRACTION));
        const offsetX = side === 'left' ? 0 : gray.width - sw;
        const strip = { width: sw, height: gray.height, data: new Float32Array(sw * gray.height) };
        for (let y = 0; y < gray.height; y++) {
            strip.data.set(gray.data.subarray(y * gray.width + offsetX, y * gray.width + offsetX + sw), y * sw);
        }
        return { strip, offsetX, offsetY: 0 };
    }
    const sh = Math.max(16, Math.round(gray.height * STRIP_FRACTION));
    const offsetY = side === 'top' ? 0 : gray.height - sh;
    const strip = {
        width: gray.width,
        height: sh,
        data: gray.data.slice(offsetY * gray.width, (offsetY + sh) * gray.width),
    };
    return { strip, offsetX: 0, offsetY };
}

class SpectrumCache {
    private map = new Map<string, { spectrum: Spectrum; offsetX: number; offsetY: number }>();
    constructor(private previews: PreviewSet) {}

    private remember(key: string, value: { spectrum: Spectrum; offsetX: number; offsetY: number }) {
        this.map.set(key, value);
        if (this.map.size > FFT_CACHE_LIMIT) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }

    private lookup(key: string) {
        const cached = this.map.get(key);
        if (cached) {
            this.map.delete(key);
            this.map.set(key, cached);
        }
        return cached;
    }

    getFull(index: number, rot: Rotation): Spectrum {
        const key = `${index}:${rot}:full`;
        const cached = this.lookup(key);
        if (cached) return cached.spectrum;
        const gray = rotateGray(this.previews.grays[index], rot);
        const spectrum = spectrumOfGray(gray, this.previews.padSize, this.previews.padSize);
        this.remember(key, { spectrum, offsetX: 0, offsetY: 0 });
        return spectrum;
    }

    getStrip(index: number, rot: Rotation, side: StripSide): { spectrum: Spectrum; offsetX: number; offsetY: number } {
        const key = `${index}:${rot}:${side}`;
        const cached = this.lookup(key);
        if (cached) return cached;
        const gray = rotateGray(this.previews.grays[index], rot);
        const { strip, offsetX, offsetY } = cutStrip(gray, side);
        const padW = side === 'left' || side === 'right' ? this.previews.stripPadAcross : this.previews.stripPadAlong;
        const padH = side === 'left' || side === 'right' ? this.previews.stripPadAlong : this.previews.stripPadAcross;
        const value = { spectrum: spectrumOfGray(strip, padW, padH), offsetX, offsetY };
        this.remember(key, value);
        return value;
    }
}

function nextPow2(value: number) {
    let result = 1;
    while (result < value) result <<= 1;
    return result;
}

function makePreviewSet(pages: PageInfo[], grays: GrayImage[], scales: number[], previewSize: number): PreviewSet {
    const maxSide = Math.max(...grays.map(g => Math.max(g.width, g.height)));
    const maxStrip = Math.max(16, Math.round(maxSide * STRIP_FRACTION));
    return {
        pages,
        grays,
        scales,
        previewSize,
        padSize: nextPow2(maxSide * 2 + 8),
        stripPadAlong: nextPow2(maxSide * 2 + 8),
        stripPadAcross: nextPow2(maxStrip * 2 + 8),
    };
}

async function buildPreviewSets(pages: PageInfo[]): Promise<{ coarse: PreviewSet; fine: PreviewSet }> {
    const fineGrays: GrayImage[] = [];
    const fineScales: number[] = [];
    for (const page of pages) {
        const img = await loadImage(page.path);
        const { gray, scale } = imageToGray(img, PREVIEW_SIZE_FINE);
        fineGrays.push(gray);
        fineScales.push(scale);
    }
    const coarseGrays = fineGrays.map(gray => downsampleGray(gray, 2));
    const coarseScales = fineScales.map(scale => scale * 2);
    return {
        coarse: makePreviewSet(pages, coarseGrays, coarseScales, PREVIEW_SIZE),
        fine: makePreviewSet(pages, fineGrays, fineScales, PREVIEW_SIZE_FINE),
    };
}

function rotationHypotheses(a: GrayImage, b: GrayImage): Rotation[] {
    const hyps: Rotation[] = [0, 180];
    const maxDim = Math.max(a.width, a.height, b.width, b.height);
    const transposed = Math.abs(a.width - b.height) / maxDim < 0.06
        && Math.abs(a.height - b.width) / maxDim < 0.06
        && Math.abs(a.width - a.height) / maxDim > 0.04;
    if (transposed) hyps.push(90, 270);
    return hyps;
}

type ProbeCandidate = {
    rot: Rotation;
    kind: 'full' | 'strip';
    peak: number;
    ratio: number;
    dx: number;
    dy: number;
    edge: LayoutCheck['edge'];
    accepted: boolean;
    score: number;
};

/** ストリップの組み合わせと、その組み合わせが成立した場合の辺の向き。 */
const STRIP_MODES: Array<{ sideA: StripSide; sideB: StripSide; edges: Array<LayoutCheck['edge']> }> = [
    { sideA: 'right', sideB: 'left', edges: ['right'] },
    { sideA: 'left', sideB: 'right', edges: ['left'] },
    { sideA: 'bottom', sideB: 'top', edges: ['bottom'] },
    { sideA: 'top', sideB: 'bottom', edges: ['top'] },
];

function pickValidPeak(
    surface: CorrSurface,
    toPageOffset: (dx: number, dy: number) => [number, number],
    wA: number, hA: number, wB: number, hB: number,
    allowedEdges: Array<LayoutCheck['edge']> | null,
): { peak: number; ratio: number; dx: number; dy: number; edge: LayoutCheck['edge'] } | null {
    const peaks = findTopPeaks(surface, 8, 8);
    for (const peak of peaks) {
        const [dx, dy] = toPageOffset(wrapOffset(peak.x, surface.width), wrapOffset(peak.y, surface.height));
        const layout = validateLayout(dx, dy, wA, hA, wB, hB);
        if (!layout) continue;
        if (allowedEdges && !allowedEdges.includes(layout.edge)) continue;
        const rival = peaks.find(p => p !== peak
            && (Math.abs(p.x - peak.x) > 16 || Math.abs(p.y - peak.y) > 16));
        const ratio = peak.value / Math.max(rival ? rival.value : 1e-6, 1e-6);
        return { peak: peak.value, ratio, dx, dy, edge: layout.edge };
    }
    return null;
}

type VerifyResult = {
    patches: number;
    matched: number;
    inliers: number;
    meanNcc: number;
    dx: number;
    dy: number;
};

/**
 * 候補配置(Bの原点がA座標で(dx,dy))を、実画素のNCCパッチ照合で検証する。
 * 対応点の補正量の合意(メディアン)も返すため、オフセットの精度も上がる。
 */
function verifyCandidate(grayA: GrayImage, grayB: GrayImage, dx: number, dy: number): VerifyResult {
    const result: VerifyResult = { patches: 0, matched: 0, inliers: 0, meanNcc: 0, dx, dy };
    const overlap = intersectRect(
        { x: 0, y: 0, w: grayA.width, h: grayA.height },
        { x: dx, y: dy, w: grayB.width, h: grayB.height },
    );
    if (!overlap) return result;
    const half = Math.min(VERIFY_PATCH_HALF, Math.floor((Math.min(overlap.w, overlap.h) - 6) / 2));
    if (half < 5) return result;

    const inset = half + 3;
    const spanX = Math.max(0, overlap.w - 2 * inset);
    const spanY = Math.max(0, overlap.h - 2 * inset);
    const nx = Math.max(1, Math.round(Math.sqrt(VERIFY_PATCH_TARGET * (spanX + 1) / (spanY + 1))));
    const ny = Math.max(1, Math.ceil(VERIFY_PATCH_TARGET / nx));

    const matches: Array<{ ax: number; ay: number; bx: number; by: number; ncc: number }> = [];
    for (let gy = 0; gy < ny; gy++) {
        for (let gx = 0; gx < nx; gx++) {
            const ax = Math.round(overlap.x + inset + spanX * (gx + 0.5) / nx);
            const ay = Math.round(overlap.y + inset + spanY * (gy + 0.5) / ny);
            if (localStddev(grayA, ax, ay, half) < VERIFY_MIN_TEXTURE_STDDEV) continue;
            result.patches++;
            const bx = ax - dx;
            const by = ay - dy;
            const match = matchPatch(grayA, ax, ay, half, grayB, Math.round(bx), Math.round(by), VERIFY_SEARCH_RADIUS);
            if (!match || match.score < VERIFY_NCC_ACCEPT) continue;
            result.matched++;
            matches.push({
                ax,
                ay,
                bx: Math.round(bx) + match.dx,
                by: Math.round(by) + match.dy,
                ncc: match.score,
            });
        }
    }
    if (matches.length < 2) {
        if (matches.length === 1) {
            result.inliers = 1;
            result.meanNcc = matches[0].ncc;
        }
        return result;
    }

    // スキャン間の微小回転で補正量が帯に沿って流れるため、剛体フィットで合意を取る。
    let active = matches;
    let fit = fitRigidTransform(active);
    for (let round = 0; round < 3; round++) {
        const kept = active.filter((_, i) => fit.residuals[i] <= VERIFY_CONSENSUS_TOL);
        if (kept.length === active.length || kept.length < 2) break;
        active = kept;
        fit = fitRigidTransform(active);
    }
    const thetaDeg = fit.theta * 180 / Math.PI;
    if (Math.abs(thetaDeg) > REFINE_MAX_THETA_DEG) return result;
    const inliers = active.filter((_, i) => fit.residuals[i] <= VERIFY_CONSENSUS_TOL);
    if (inliers.length === 0) return result;
    result.inliers = inliers.length;
    result.meanNcc = inliers.reduce((sum, c) => sum + c.ncc, 0) / inliers.length;
    const meanDx = inliers.reduce((sum, c) => sum + (c.ax - c.bx), 0) / inliers.length;
    const meanDy = inliers.reduce((sum, c) => sum + (c.ay - c.by), 0) / inliers.length;
    result.dx = meanDx;
    result.dy = meanDy;
    return result;
}

function verificationPassed(verify: VerifyResult) {
    // 同じ版面のページ同士は飾り罫だけが部分的に一致するため、
    // インライアの数だけでなく試行パッチに対する割合も要求する。
    return verify.inliers >= VERIFY_MIN_INLIERS
        && verify.meanNcc >= VERIFY_MIN_MEAN_NCC
        && verify.inliers >= verify.patches * VERIFY_MIN_INLIER_RATIO;
}

function verificationStrength(verify: VerifyResult | null) {
    return verify ? verify.inliers * verify.meanNcc : 0;
}

/**
 * 位相相関で配置候補をノミネートし、精細プレビューのNCCパッチ照合で採否を決める。
 */
function probePairOnPreviews(previews: PreviewSet, cache: SpectrumCache, fine: PreviewSet, a: number, b: number): PairProbe {
    const grayA = previews.grays[a];
    const candidates: ProbeCandidate[] = [];
    const add = (candidate: ProbeCandidate) => {
        const dup = candidates.find(c => c.rot === candidate.rot
            && Math.abs(c.dx - candidate.dx) <= 10 && Math.abs(c.dy - candidate.dy) <= 10);
        if (dup) {
            if (candidate.score > dup.score) candidates[candidates.indexOf(dup)] = candidate;
            return;
        }
        candidates.push(candidate);
    };

    for (const rot of rotationHypotheses(grayA, previews.grays[b])) {
        const grayB = rotateGray(previews.grays[b], rot);

        // 全面同士の位相相関: 大きな重なりに強い。
        const full = pickValidPeak(
            phaseCorrelationSurface(cache.getFull(a, 0), cache.getFull(b, rot)),
            (dx, dy) => [dx, dy],
            grayA.width, grayA.height, grayB.width, grayB.height,
            null,
        );
        if (full && full.peak >= NOMINATE_FULL_PEAK) {
            add({ rot, kind: 'full', ...full, accepted: false, score: full.peak / NOMINATE_FULL_PEAK });
        }

        // 端ストリップ同士の位相相関: 小さな重なりでもピークが薄まらない。
        for (const mode of STRIP_MODES) {
            const stripA = cache.getStrip(a, 0, mode.sideA);
            const stripB = cache.getStrip(b, rot, mode.sideB);
            const result = pickValidPeak(
                phaseCorrelationSurface(stripA.spectrum, stripB.spectrum),
                (dx, dy) => [dx + stripA.offsetX - stripB.offsetX, dy + stripA.offsetY - stripB.offsetY],
                grayA.width, grayA.height, grayB.width, grayB.height,
                mode.edges,
            );
            if (result && result.peak >= NOMINATE_STRIP_PEAK) {
                add({ rot, kind: 'strip', ...result, accepted: false, score: result.peak / NOMINATE_STRIP_PEAK });
            }
        }
    }

    candidates.sort((c1, c2) => c2.score - c1.score);
    const fineGrayA = fine.grays[a];
    const fineRotCache = new Map<Rotation, GrayImage>();
    const verified: Array<{ candidate: ProbeCandidate; verify: VerifyResult }> = [];
    for (const candidate of candidates.slice(0, NOMINATE_LIMIT)) {
        let fineGrayB = fineRotCache.get(candidate.rot);
        if (!fineGrayB) {
            fineGrayB = rotateGray(fine.grays[b], candidate.rot);
            fineRotCache.set(candidate.rot, fineGrayB);
        }
        const factor = previews.scales[a] / fine.scales[a];
        const verify = verifyCandidate(fineGrayA, fineGrayB, candidate.dx * factor, candidate.dy * factor);
        verified.push({ candidate, verify });
    }
    verified.sort((v1, v2) => verificationStrength(v2.verify) - verificationStrength(v1.verify));

    if (verified.length === 0) {
        return {
            a, b, accepted: false, rotationB: 0, peak: 0, ratio: 0,
            kind: null, edge: null, offsetFull: null, previewSize: previews.previewSize,
            verify: null,
        };
    }
    const { candidate, verify } = verified[0];
    const toAlternate = (item: { candidate: ProbeCandidate; verify: VerifyResult }): ProbeAlternate => ({
        rot: item.candidate.rot,
        kind: item.candidate.kind,
        peak: Number(item.candidate.peak.toFixed(5)),
        ratio: Number(item.candidate.ratio.toFixed(3)),
        edge: item.candidate.edge,
        offsetFull: { dx: item.verify.dx * fine.scales[a], dy: item.verify.dy * fine.scales[a] },
        verify: {
            patches: item.verify.patches,
            inliers: item.verify.inliers,
            meanNcc: Number(item.verify.meanNcc.toFixed(3)),
        },
    });
    return {
        a,
        b,
        accepted: verificationPassed(verify),
        rotationB: candidate.rot,
        peak: Number(candidate.peak.toFixed(5)),
        ratio: Number(candidate.ratio.toFixed(3)),
        kind: candidate.kind,
        edge: candidate.edge,
        offsetFull: { dx: verify.dx * fine.scales[a], dy: verify.dy * fine.scales[a] },
        previewSize: previews.previewSize,
        verify: {
            patches: verify.patches,
            inliers: verify.inliers,
            meanNcc: Number(verify.meanNcc.toFixed(3)),
        },
        alternates: verified.map(toAlternate),
    };
}

// ---------------------------------------------------------------------------
// グループ判定
// ---------------------------------------------------------------------------

type ProbeFn = (a: number, b: number) => Promise<PairProbe>;

function probeStrength(probe: PairProbe) {
    return probe.verify ? probe.verify.inliers * probe.verify.meanNcc : 0;
}

function isStrongProbe(probe: PairProbe) {
    return probe.verify !== null
        && probe.verify.inliers >= VERIFY_STRONG_INLIERS
        && probe.verify.meanNcc >= VERIFY_STRONG_MEAN_NCC
        && probe.verify.inliers >= probe.verify.patches * VERIFY_STRONG_INLIER_RATIO;
}

const RESCUE_MIN_INLIERS = 1;
const RESCUE_MIN_MEAN_NCC = 0.45;
const RESCUE_ACCEPT_INLIERS = 8;
const RESCUE_ACCEPT_RMSE = 2.5;

function makeProbeFn(
    coarse: PreviewSet,
    coarseCache: SpectrumCache,
    fine: PreviewSet,
    fineCache: SpectrumCache,
    loadPageImage: (index: number) => Promise<any>,
    log: Logger,
): ProbeFn {
    const memo = new Map<string, PairProbe>();
    return async (a: number, b: number) => {
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        const cached = memo.get(key);
        if (cached) return cached;

        let probe = probePairOnPreviews(coarse, coarseCache, fine, a, b);
        if (!probe.accepted) {
            // 重なりが小さいと低解像度ではノミネートできないことがあるため、高解像度で再試行する。
            const retry = probePairOnPreviews(fine, fineCache, fine, a, b);
            const merged = [...(retry.alternates || []), ...(probe.alternates || [])];
            if (retry.accepted || probeStrength(retry) > probeStrength(probe)) probe = retry;
            probe = { ...probe, alternates: merged };
        }
        if (!probe.accepted) {
            // 写真や余白が多い重なりはプレビューでは確証が取れないことがあるため、
            // 有望な候補に限り全解像度のパッチ照合で最終確認する。
            const seen = new Set<string>();
            const rescueTargets = (probe.alternates || [])
                .filter(alt => alt.verify.inliers >= RESCUE_MIN_INLIERS && alt.verify.meanNcc >= RESCUE_MIN_MEAN_NCC)
                .filter(alt => {
                    const key = `${alt.rot}:${Math.round(alt.offsetFull.dx / 50)}:${Math.round(alt.offsetFull.dy / 50)}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(0, 3);
            for (const alt of rescueTargets) {
                const imgA = await loadPageImage(a);
                const imgB = await loadPageImage(b);
                const linkLike: PairProbe = { ...probe, rotationB: alt.rot, edge: alt.edge, offsetFull: alt.offsetFull };
                const refined = refinePairAlignment(imgA, imgB, linkLike, log);
                if (refined.method === 'rigid'
                    && refined.inliers >= RESCUE_ACCEPT_INLIERS
                    && refined.inliers >= refined.patches * 0.6
                    && refined.rmse !== null && refined.rmse <= RESCUE_ACCEPT_RMSE) {
                    probe = {
                        ...probe,
                        accepted: true,
                        rotationB: alt.rot,
                        kind: alt.kind,
                        peak: alt.peak,
                        ratio: alt.ratio,
                        edge: alt.edge,
                        offsetFull: alt.offsetFull,
                        verify: {
                            patches: refined.patches,
                            inliers: refined.inliers,
                            meanNcc: alt.verify.meanNcc,
                        },
                    };
                    log(`[auto-group] ${a + 1}-${b + 1}: 全解像度で確認 rot=${alt.rot} edge=${alt.edge} inliers=${refined.inliers}/${refined.patches} rmse=${refined.rmse}px`);
                    break;
                }
                log(`[auto-group] ${a + 1}-${b + 1}: 全解像度の確認は不成立 rot=${alt.rot} edge=${alt.edge} method=${refined.method} inliers=${refined.inliers}/${refined.patches} rmse=${refined.rmse ?? 'n/a'}px`);
            }
        }
        memo.set(key, probe);
        const label = probe.accepted ? '採用' : '弱い';
        const verifyText = probe.verify ? `inliers=${probe.verify.inliers}/${probe.verify.patches} ncc=${probe.verify.meanNcc.toFixed(2)}` : 'inliers=なし';
        log(`[auto-group] ${a + 1}-${b + 1}: ${label} ${verifyText} peak=${probe.peak.toFixed(4)} kind=${probe.kind || 'なし'} edge=${probe.edge || 'なし'} rot=${probe.rotationB}`);
        return probe;
    };
}

async function sequentialGroups(pageCount: number, groupSize: number, probe: ProbeFn): Promise<GroupPlan[] | null> {
    if (pageCount % groupSize !== 0) return null;
    const groups: GroupPlan[] = [];
    for (let start = 0; start < pageCount; start += groupSize) {
        const indexes = Array.from({ length: groupSize }, (_, offset) => start + offset);
        const links: PairProbe[] = [];
        for (let i = 0; i < groupSize - 1; i++) {
            const pair = await probe(indexes[i], indexes[i + 1]);
            if (!pair.accepted) return null;
            links.push(pair);
        }
        groups.push({ indexes, links, passthrough: groupSize === 1 });
    }
    return groups;
}

async function windowedAutoGroups(pageCount: number, probe: ProbeFn): Promise<{ groups: GroupPlan[]; warnings: string[] }> {
    const probes: PairProbe[] = [];
    for (let i = 0; i < pageCount; i++) {
        for (let j = i + 1; j <= Math.min(pageCount - 1, i + AUTO_PAIR_WINDOW); j++) {
            probes.push(await probe(i, j));
        }
    }

    const parent = Array.from({ length: pageCount }, (_, i) => i);
    const size = new Array(pageCount).fill(1);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };

    const usedLinks: PairProbe[] = [];
    const accepted = probes
        .filter(p => p.accepted)
        .sort((p, q) => (probeStrength(q) - probeStrength(p)) || (Math.abs(p.a - p.b) - Math.abs(q.a - q.b)));
    for (const pair of accepted) {
        const ra = find(pair.a);
        const rb = find(pair.b);
        if (ra === rb) continue;
        if (size[ra] + size[rb] > MAX_GROUP_SIZE) continue;
        // 複数ページ同士の結合は、同じ版面のページを誤って繋ぐ事故になりやすいので、特に強い検証結果に限る。
        if (size[ra] > 1 && size[rb] > 1 && !isStrongProbe(pair)) continue;
        parent[rb] = ra;
        size[ra] += size[rb];
        usedLinks.push(pair);
    }

    const components = new Map<number, number[]>();
    for (let i = 0; i < pageCount; i++) {
        const root = find(i);
        const items = components.get(root) || [];
        items.push(i);
        components.set(root, items);
    }

    const warnings: string[] = [];
    const groups = Array.from(components.values())
        .map(indexes => indexes.sort((x, y) => x - y))
        .sort((g1, g2) => g1[0] - g2[0])
        .map(indexes => ({
            indexes,
            links: usedLinks.filter(link => indexes.includes(link.a) && indexes.includes(link.b)),
            passthrough: indexes.length === 1,
        }));

    const singles = groups.filter(group => group.passthrough);
    if (singles.length > 0) {
        warnings.push(`結合相手を検出できなかったページがあります: ${singles.map(group => group.indexes[0] + 1).join(', ')}`);
    }
    if (groups.every(group => group.passthrough)) {
        throw new Error('信頼できる重なりを検出できませんでした。重なりのない分割スキャンは自動復元できません。');
    }
    return { groups, warnings };
}

/**
 * 入力画像のグループ(同じ実ページに属する組)と相対配置を判定する。
 */
async function planGroups(imagePaths: string[], groupSize: number | 'auto', log: Logger = console.log): Promise<GroupingPlan> {
    const pages: PageInfo[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
        const img = await loadImage(imagePaths[i]);
        pages.push({ index: i, path: imagePaths[i], width: img.width, height: img.height });
    }

    if (pages.length < 2) {
        return {
            pages,
            groups: [{ indexes: pages.map(p => p.index), links: [], passthrough: true }],
            mode: groupSize === 'auto' ? 'auto' : 'fixed',
            resolvedGroupSize: groupSize,
            pairs: [],
            warnings: [],
        };
    }

    log(`[情報] 位相相関でページの重なりを検出します (${pages.length}ページ)`);
    const { coarse, fine } = await buildPreviewSets(pages);
    const coarseCache = new SpectrumCache(coarse);
    const fineCache = new SpectrumCache(fine);
    const imageCache = new Map<number, any>();
    const loadPageImage = async (index: number) => {
        const cached = imageCache.get(index);
        if (cached) {
            imageCache.delete(index);
            imageCache.set(index, cached);
            return cached;
        }
        const img = await loadImage(pages[index].path);
        imageCache.set(index, img);
        if (imageCache.size > 4) {
            const oldest = imageCache.keys().next().value;
            imageCache.delete(oldest);
        }
        return img;
    };
    const probedPairs: PairProbe[] = [];
    const baseProbe = makeProbeFn(coarse, coarseCache, fine, fineCache, loadPageImage, log);
    const probe: ProbeFn = async (a, b) => {
        const result = await baseProbe(a, b);
        if (!probedPairs.includes(result)) probedPairs.push(result);
        return result;
    };

    if (groupSize !== 'auto') {
        if (pages.length % groupSize !== 0) {
            throw new Error(`ページ数が分割枚数で割り切れません: pages=${pages.length} groupSize=${groupSize}`);
        }
        const groups: GroupPlan[] = [];
        for (let start = 0; start < pages.length; start += groupSize) {
            const indexes = Array.from({ length: groupSize }, (_, offset) => start + offset);
            const links: PairProbe[] = [];
            for (let i = 0; i < groupSize - 1; i++) {
                const pair = await probe(indexes[i], indexes[i + 1]);
                if (!pair.offsetFull) {
                    throw new Error(`ページ ${indexes[i] + 1} と ${indexes[i + 1] + 1} の重なりを検出できませんでした`);
                }
                if (!pair.accepted) {
                    log(`[警告] ページ ${indexes[i] + 1}-${indexes[i + 1] + 1} の重なりが弱いまま続行します (peak=${pair.peak.toFixed(4)})`);
                }
                links.push(pair);
            }
            groups.push({ indexes, links, passthrough: groupSize === 1 });
        }
        return { pages, groups, mode: 'fixed', resolvedGroupSize: groupSize, pairs: probedPairs, warnings: [] };
    }

    for (const candidateSize of [2, 3, 4]) {
        const groups = await sequentialGroups(pages.length, candidateSize, probe);
        if (groups) {
            log(`[auto-group] 連続${candidateSize}枚のグループとして判定しました`);
            log(`[auto-group] ${groups.map(group => `{${group.indexes.map(i => i + 1).join(',')}}`).join(' ')}`);
            return { pages, groups, mode: 'auto', resolvedGroupSize: candidateSize, pairs: probedPairs, warnings: [] };
        }
    }

    const { groups, warnings } = await windowedAutoGroups(pages.length, probe);
    log(`[auto-group] ${groups.map(group => `{${group.indexes.map(i => i + 1).join(',')}}`).join(' ')}`);
    return { pages, groups, mode: 'auto', resolvedGroupSize: 'auto', pairs: probedPairs, warnings };
}

// ---------------------------------------------------------------------------
// 精密位置合わせ (パッチマッチング + 剛体フィット)
// ---------------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number };

function intersectRect(r1: Rect, r2: Rect): Rect | null {
    const x = Math.max(r1.x, r2.x);
    const y = Math.max(r1.y, r2.y);
    const w = Math.min(r1.x + r1.w, r2.x + r2.w) - x;
    const h = Math.min(r1.y + r1.h, r2.y + r2.h) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

function expandRect(r: Rect, margin: number, boundW: number, boundH: number): Rect {
    const x = Math.max(0, Math.floor(r.x - margin));
    const y = Math.max(0, Math.floor(r.y - margin));
    return {
        x,
        y,
        w: Math.min(boundW, Math.ceil(r.x + r.w + margin)) - x,
        h: Math.min(boundH, Math.ceil(r.y + r.h + margin)) - y,
    };
}

/** 元画像をrot度回転した座標系で、矩形rectを切り出してグレースケール化する。 */
function extractGrayRotated(img: any, rot: Rotation, rect: Rect): GrayImage {
    const canvas = createCanvas(rect.w, rect.h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.w, rect.h);
    const m = affineCompose(affineTranslation(-rect.x, -rect.y), rotationAffine(rot, img.width, img.height));
    ctx.setTransform(m.a, m.c, m.b, m.d, m.e, m.f);
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, rect.w, rect.h).data;
    return rgbaToGray(data, rect.w, rect.h);
}

function localStddev(gray: GrayImage, cx: number, cy: number, half: number): number {
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = cy - half; y <= cy + half; y += 2) {
        if (y < 0 || y >= gray.height) continue;
        for (let x = cx - half; x <= cx + half; x += 2) {
            if (x < 0 || x >= gray.width) continue;
            const v = gray.data[y * gray.width + x];
            sum += v;
            sumSq += v * v;
            count++;
        }
    }
    if (count < 9) return 0;
    const mean = sum / count;
    return Math.sqrt(Math.max(0, sumSq / count - mean * mean));
}

type PatchMatch = { dx: number; dy: number; score: number };

/**
 * grayAの(ax,ay)を中心とするパッチを、grayBの(bx,by)周辺±radiusでNCC探索する。
 */
function matchPatch(
    grayA: GrayImage, ax: number, ay: number, half: number,
    grayB: GrayImage, bx: number, by: number, radius: number,
): PatchMatch | null {
    const size = 2 * half + 1;
    if (ax - half < 0 || ay - half < 0 || ax + half >= grayA.width || ay + half >= grayA.height) return null;

    const tpl = new Float64Array(size * size);
    let tplSum = 0;
    let tplSumSq = 0;
    for (let y = 0; y < size; y++) {
        const off = (ay - half + y) * grayA.width + (ax - half);
        for (let x = 0; x < size; x++) {
            const v = grayA.data[off + x];
            tpl[y * size + x] = v;
            tplSum += v;
            tplSumSq += v * v;
        }
    }
    const n = size * size;
    const tplMean = tplSum / n;
    const tplVar = tplSumSq / n - tplMean * tplMean;
    if (tplVar < 1e-3) return null;
    const tplNorm = Math.sqrt(tplVar * n);

    const scores = new Float64Array((2 * radius + 1) * (2 * radius + 1)).fill(-2);
    let best: PatchMatch | null = null;
    for (let dy = -radius; dy <= radius; dy++) {
        const cy = by + dy;
        if (cy - half < 0 || cy + half >= grayB.height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
            const cx = bx + dx;
            if (cx - half < 0 || cx + half >= grayB.width) continue;
            let sum = 0;
            let sumSq = 0;
            let cross = 0;
            for (let y = 0; y < size; y++) {
                const offB = (cy - half + y) * grayB.width + (cx - half);
                const offT = y * size;
                for (let x = 0; x < size; x++) {
                    const v = grayB.data[offB + x];
                    sum += v;
                    sumSq += v * v;
                    cross += v * tpl[offT + x];
                }
            }
            const mean = sum / n;
            const variance = sumSq / n - mean * mean;
            if (variance < 1e-3) continue;
            const ncc = (cross - n * mean * tplMean) / (tplNorm * Math.sqrt(variance * n));
            scores[(dy + radius) * (2 * radius + 1) + (dx + radius)] = ncc;
            if (!best || ncc > best.score) {
                best = { dx, dy, score: ncc };
            }
        }
    }
    if (!best) return null;

    // 相関ピーク近傍の放物線フィットでサブピクセル補間する。
    const stride = 2 * radius + 1;
    const idx = (best.dy + radius) * stride + (best.dx + radius);
    const subOffset = (minus: number, center: number, plus: number) => {
        const denom = minus - 2 * center + plus;
        if (denom >= -1e-9 || minus < -1 || plus < -1) return 0;
        return Math.max(-0.5, Math.min(0.5, 0.5 * (minus - plus) / denom));
    };
    let subX = 0;
    let subY = 0;
    if (Math.abs(best.dx) < radius) {
        subX = subOffset(scores[idx - 1], scores[idx], scores[idx + 1]);
    }
    if (Math.abs(best.dy) < radius) {
        subY = subOffset(scores[idx - stride], scores[idx], scores[idx + stride]);
    }
    return { dx: best.dx + subX, dy: best.dy + subY, score: best.score };
}

type PointPair = { ax: number; ay: number; bx: number; by: number };

function fitRigidTransform(pairs: PointPair[]): { theta: number; tx: number; ty: number; residuals: number[] } {
    let meanAx = 0;
    let meanAy = 0;
    let meanBx = 0;
    let meanBy = 0;
    for (const p of pairs) {
        meanAx += p.ax;
        meanAy += p.ay;
        meanBx += p.bx;
        meanBy += p.by;
    }
    meanAx /= pairs.length;
    meanAy /= pairs.length;
    meanBx /= pairs.length;
    meanBy /= pairs.length;

    let sumCos = 0;
    let sumSin = 0;
    for (const p of pairs) {
        const bx = p.bx - meanBx;
        const by = p.by - meanBy;
        const ax = p.ax - meanAx;
        const ay = p.ay - meanAy;
        sumCos += bx * ax + by * ay;
        sumSin += bx * ay - by * ax;
    }
    const theta = Math.atan2(sumSin, sumCos);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const tx = meanAx - (cos * meanBx - sin * meanBy);
    const ty = meanAy - (sin * meanBx + cos * meanBy);

    const residuals = pairs.map(p => {
        const rx = cos * p.bx - sin * p.by + tx - p.ax;
        const ry = sin * p.bx + cos * p.by + ty - p.ay;
        return Math.sqrt(rx * rx + ry * ry);
    });
    return { theta, tx, ty, residuals };
}

/**
 * 2つのクロップ間の全体オフセットを位相相関で求める。
 * predictedの近傍(searchRadius以内)にあるピークだけを採用する。
 */
function estimateCropShift(
    qA: GrayImage,
    qB: GrayImage,
    predicted: { dx: number; dy: number },
    searchRadius: number,
): { dx: number; dy: number } | null {
    let fA = qA;
    let fB = qB;
    let scale = 1;
    while (Math.max(fA.width, fA.height, fB.width, fB.height) > 768) {
        fA = downsampleGray(fA, 2);
        fB = downsampleGray(fB, 2);
        scale *= 2;
    }
    const padW = nextPow2(fA.width + fB.width + 8);
    const padH = nextPow2(fA.height + fB.height + 8);
    const surface = phaseCorrelationSurface(spectrumOfGray(fA, padW, padH), spectrumOfGray(fB, padW, padH));
    const peaks = findTopPeaks(surface, 8, 6);
    for (const peak of peaks) {
        const dx = wrapOffset(peak.x, padW);
        const dy = wrapOffset(peak.y, padH);
        if (Math.abs(dx - predicted.dx / scale) <= searchRadius / scale
            && Math.abs(dy - predicted.dy / scale) <= searchRadius / scale) {
            return { dx: dx * scale, dy: dy * scale };
        }
    }
    return null;
}

function rigidResiduals(fit: { theta: number; tx: number; ty: number }, points: PointPair[]): number[] {
    const cos = Math.cos(fit.theta);
    const sin = Math.sin(fit.theta);
    return points.map(p => {
        const rx = cos * p.bx - sin * p.by + fit.tx - p.ax;
        const ry = sin * p.bx + cos * p.by + fit.ty - p.ay;
        return Math.sqrt(rx * rx + ry * ry);
    });
}

/**
 * RANSACで剛体変換をフィットする。周期的な内容(表組み等)で一部のパッチが
 * 誤った位置にロックしても、多数派の合意だけからフィットを得られる。
 */
function ransacRigid(points: PointPair[], tol: number): { theta: number; tx: number; ty: number; inlierIndexes: number[] } | null {
    const n = points.length;
    if (n < 2) return null;
    const combos: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) combos.push([i, j]);
    }
    let samples = combos;
    if (combos.length > 400) {
        samples = [];
        const step = combos.length / 400;
        for (let k = 0; k < 400; k++) samples.push(combos[Math.floor(k * step)]);
    }

    const maxTheta = 3.5 * Math.PI / 180;
    let bestIndexes: number[] = [];
    for (const [i, j] of samples) {
        const p = points[i];
        const q = points[j];
        if (Math.hypot(p.ax - q.ax, p.ay - q.ay) < 40) continue;
        const hypothesis = fitRigidTransform([p, q]);
        if (Math.abs(hypothesis.theta) > maxTheta) continue;
        const residuals = rigidResiduals(hypothesis, points);
        const indexes: number[] = [];
        for (let k = 0; k < n; k++) {
            if (residuals[k] <= tol) indexes.push(k);
        }
        if (indexes.length > bestIndexes.length) bestIndexes = indexes;
    }
    if (bestIndexes.length < 2) return null;

    let fit = fitRigidTransform(bestIndexes.map(i => points[i]));
    const residuals = rigidResiduals(fit, points);
    const inlierIndexes: number[] = [];
    for (let k = 0; k < n; k++) {
        if (residuals[k] <= tol) inlierIndexes.push(k);
    }
    if (inlierIndexes.length >= 2) {
        fit = fitRigidTransform(inlierIndexes.map(i => points[i]));
    }
    return { theta: fit.theta, tx: fit.tx, ty: fit.ty, inlierIndexes };
}

function grayMean(gray: GrayImage, rect: Rect): number {
    let sum = 0;
    let count = 0;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(gray.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(gray.height, Math.ceil(rect.y + rect.h));
    for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
            sum += gray.data[y * gray.width + x];
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}

/**
 * 粗い配置(link.offsetFull)を起点に、重なり領域のパッチマッチングで
 * 「回転後B座標 → A座標」の剛体変換を推定する。
 */
function refinePairAlignment(imgA: any, imgB: any, link: PairProbe, log: Logger): PairRefinement {
    const offset = link.offsetFull!;
    const [wB, hB] = rotatedSize(link.rotationB, imgB.width, imgB.height);
    const rectA: Rect = { x: 0, y: 0, w: imgA.width, h: imgA.height };
    const rectB: Rect = { x: offset.dx, y: offset.dy, w: wB, h: hB };
    const fallback: PairRefinement = {
        matrix: affineTranslation(offset.dx, offset.dy),
        thetaDeg: 0,
        patches: 0,
        inliers: 0,
        rmse: null,
        gain: 1,
        method: 'translation',
    };

    const overlap = intersectRect(rectA, rectB);
    if (!overlap || overlap.w < 24 || overlap.h < 24) {
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: 重なりが小さいため平行移動のみで合成します`);
        return fallback;
    }

    // 重なりが狭いときはパッチを小さくして、共有領域の外を見ないようにする。
    const patchHalf = Math.min(REFINE_PATCH_HALF, Math.floor((Math.min(overlap.w, overlap.h) - 8) / 2));
    const searchSlack = 200;
    const cropA = expandRect(overlap, patchHalf * 2, imgA.width, imgA.height);
    const cropBRect = expandRect(
        { x: overlap.x - offset.dx, y: overlap.y - offset.dy, w: overlap.w, h: overlap.h },
        patchHalf * 2 + searchSlack,
        wB,
        hB,
    );
    const grayA = extractGrayRotated(imgA, 0, cropA);
    const grayB = extractGrayRotated(imgB, link.rotationB, cropBRect);

    // 明度ゲイン: 重なり領域の平均輝度を一致させる(紙の白の差を吸収する)。
    const meanA = grayMean(grayA, { x: overlap.x - cropA.x, y: overlap.y - cropA.y, w: overlap.w, h: overlap.h });
    const meanB = grayMean(grayB, { x: overlap.x - offset.dx - cropBRect.x, y: overlap.y - offset.dy - cropBRect.y, w: overlap.w, h: overlap.h });
    const gain = meanA > 30 && meanB > 30 ? Math.min(1.18, Math.max(0.85, meanA / meanB)) : 1;
    fallback.gain = gain;

    const quarterA = downsampleGray(grayA, 4);
    const quarterB = downsampleGray(grayB, 4);

    // 粗いオフセットには数mmの誤差がありうるため、クロップ全体の位相相関でシードを補正する。
    // 表組みのような周期的な内容で誤った行にロックするのを防ぐ。
    let offsetEff = offset;
    {
        const predicted = {
            dx: (cropBRect.x + offset.dx - cropA.x) / 4,
            dy: (cropBRect.y + offset.dy - cropA.y) / 4,
        };
        const found = estimateCropShift(quarterA, quarterB, predicted, Math.ceil((searchSlack - 20) / 4));
        if (found) {
            const ddx = (found.dx - predicted.dx) * 4;
            const ddy = (found.dy - predicted.dy) * 4;
            if (Math.abs(ddx) > 2 || Math.abs(ddy) > 2) {
                offsetEff = { dx: offset.dx + ddx, dy: offset.dy + ddy };
                fallback.matrix = affineTranslation(offsetEff.dx, offsetEff.dy);
                log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: シードを補正しました (${ddx.toFixed(1)}, ${ddy.toFixed(1)})px`);
            }
        }
    }

    // テクスチャの強い位置からパッチ中心を選ぶ。
    const inset = patchHalf + 4;
    const spanX = Math.max(0, overlap.w - 2 * inset);
    const spanY = Math.max(0, overlap.h - 2 * inset);
    const cells = Math.ceil(Math.sqrt(REFINE_PATCH_TARGET * 2));
    const candidates: Array<{ x: number; y: number; texture: number }> = [];
    for (let gy = 0; gy < cells; gy++) {
        for (let gx = 0; gx < cells; gx++) {
            const x = Math.round(overlap.x + inset + spanX * (gx + 0.5) / cells);
            const y = Math.round(overlap.y + inset + spanY * (gy + 0.5) / cells);
            const texture = localStddev(grayA, x - cropA.x, y - cropA.y, patchHalf);
            if (texture >= REFINE_MIN_TEXTURE_STDDEV) candidates.push({ x, y, texture });
        }
    }
    candidates.sort((p, q) => q.texture - p.texture);
    const seen = new Set<string>();
    const selected = candidates
        .filter(p => {
            const key = `${p.x}:${p.y}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, REFINE_PATCH_TARGET);
    if (selected.length < REFINE_MIN_INLIERS) {
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: 重なり領域に十分な模様がないため平行移動のみで合成します`);
        return fallback;
    }

    const pairs: PointPair[] = [];
    for (const point of selected) {
        const ax = Math.round(point.x - cropA.x);
        const ay = Math.round(point.y - cropA.y);
        const bPredX = point.x - offsetEff.dx - cropBRect.x;
        const bPredY = point.y - offsetEff.dy - cropBRect.y;

        const coarse = matchPatch(
            quarterA, Math.round(ax / 4), Math.round(ay / 4), Math.max(4, Math.floor(patchHalf / 4) + 2),
            quarterB, Math.round(bPredX / 4), Math.round(bPredY / 4), REFINE_QUARTER_RADIUS,
        );
        if (!coarse || coarse.score < REFINE_NCC_ACCEPT) continue;

        const searchCx = Math.round(bPredX + coarse.dx * 4);
        const searchCy = Math.round(bPredY + coarse.dy * 4);
        const fine = matchPatch(
            grayA, ax, ay, patchHalf,
            grayB, searchCx, searchCy, 7,
        );
        if (!fine || fine.score < REFINE_NCC_ACCEPT) continue;

        pairs.push({
            ax: cropA.x + ax,
            ay: cropA.y + ay,
            bx: cropBRect.x + searchCx + fine.dx,
            by: cropBRect.y + searchCy + fine.dy,
        });
    }

    if (pairs.length < REFINE_MIN_INLIERS) {
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: 対応点が${pairs.length}点しか取れず、平行移動のみで合成します`);
        return fallback;
    }

    // RANSACで多数派の合意から剛体変換をフィットする。
    const ransac = ransacRigid(pairs, 3);
    if (!ransac || ransac.inlierIndexes.length < REFINE_MIN_INLIERS) {
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: 対応点の合意が取れず、平行移動のみで合成します (matched=${pairs.length})`);
        return fallback;
    }
    const inlierPoints = ransac.inlierIndexes.map(i => pairs[i]);
    const residuals = rigidResiduals(ransac, inlierPoints);
    const rmse = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length);
    const thetaDeg = ransac.theta * 180 / Math.PI;
    if (Math.abs(thetaDeg) > REFINE_MAX_THETA_DEG || rmse > 4) {
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: フィットが不安定なため平行移動のみで合成します (theta=${thetaDeg.toFixed(2)}度, rmse=${rmse.toFixed(2)}px)`);
        return fallback;
    }

    return {
        matrix: affineRigid(ransac.theta, ransac.tx, ransac.ty),
        thetaDeg: Number(thetaDeg.toFixed(4)),
        patches: pairs.length,
        inliers: inlierPoints.length,
        rmse: Number(rmse.toFixed(3)),
        gain,
        method: 'rigid',
    };
}

// ---------------------------------------------------------------------------
// 合成 (フェザーブレンド)
// ---------------------------------------------------------------------------

type ComposeSource = {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    pose: Affine;
    gain: number;
};

type SeamView = ComposeSource & {
    inv: Affine;
    bboxX0: number;
    bboxY0: number;
    bboxX1: number;
    bboxY1: number;
};

/**
 * 出力画素に対応する元画像の色をバイリニア補間で取り出す。
 * 画像外(端のインセットを含む)ならfalseを返す。bufには[r,g,b]が入る。
 */
function sampleViewInto(view: SeamView, px: number, py: number, buf: Float64Array): boolean {
    const sx = view.inv.a * px + view.inv.b * py + view.inv.e;
    const sy = view.inv.c * px + view.inv.d * py + view.inv.f;
    if (Math.min(sx, view.width - sx, sy, view.height - sy) <= BLEND_EDGE_INSET_PX) return false;
    const fx = Math.min(view.width - 1.001, Math.max(0, sx - 0.5));
    const fy = Math.min(view.height - 1.001, Math.max(0, sy - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const i00 = (y0 * view.width + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + view.width * 4;
    const i11 = i01 + 4;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const d = view.rgba;
    buf[0] = Math.min(255, view.gain * (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11));
    buf[1] = Math.min(255, view.gain * (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11));
    buf[2] = Math.min(255, view.gain * (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11));
    return true;
}

/**
 * 重なり帯の中で合成済み画像と新しい画像の差が最小になる縫い目を動的計画法で求め、
 * 縫い目の両側でそれぞれ片方の画像だけを採用する。ブレンドしないためゴーストが出ない。
 * 縫い目の±SEAM_BLEND_PXだけ、切り替えを隠す微小なクロスフェードを行う。
 */
function composeSources(sources: ComposeSource[]): { canvas: any; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const src of sources) {
        for (const [cx, cy] of [[0, 0], [src.width, 0], [0, src.height], [src.width, src.height]]) {
            const [x, y] = affineApply(src.pose, cx, cy);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    const outW = Math.max(1, Math.ceil(maxX - minX));
    const outH = Math.max(1, Math.ceil(maxY - minY));
    const shift = affineTranslation(-minX, -minY);

    const views: SeamView[] = sources.map(src => {
        const pose = affineCompose(shift, src.pose);
        const inv = affineInvert(pose);
        let bMinX = Infinity;
        let bMinY = Infinity;
        let bMaxX = -Infinity;
        let bMaxY = -Infinity;
        for (const [cx, cy] of [[0, 0], [src.width, 0], [0, src.height], [src.width, src.height]]) {
            const [x, y] = affineApply(pose, cx, cy);
            bMinX = Math.min(bMinX, x);
            bMinY = Math.min(bMinY, y);
            bMaxX = Math.max(bMaxX, x);
            bMaxY = Math.max(bMaxY, y);
        }
        return {
            ...src,
            pose,
            inv,
            bboxX0: Math.max(0, Math.floor(bMinX)),
            bboxY0: Math.max(0, Math.floor(bMinY)),
            bboxX1: Math.min(outW, Math.ceil(bMaxX)),
            bboxY1: Math.min(outH, Math.ceil(bMaxY)),
        };
    });

    // alpha=0 を「未充填」として使う。
    const out = new Uint8ClampedArray(outW * outH * 4);
    const buf = new Float64Array(3);

    for (let v = 0; v < views.length; v++) {
        const view = views[v];
        if (v === 0) {
            for (let y = view.bboxY0; y < view.bboxY1; y++) {
                for (let x = view.bboxX0; x < view.bboxX1; x++) {
                    if (!sampleViewInto(view, x + 0.5, y + 0.5, buf)) continue;
                    const offset = (y * outW + x) * 4;
                    out[offset] = buf[0];
                    out[offset + 1] = buf[1];
                    out[offset + 2] = buf[2];
                    out[offset + 3] = 255;
                }
            }
            continue;
        }

        // 1パス目: 合成済み領域との競合範囲(重なりbbox)と、新画像だけが届く側を調べる。
        let ox0 = outW;
        let oy0 = outH;
        let ox1 = 0;
        let oy1 = 0;
        for (let y = view.bboxY0; y < view.bboxY1; y++) {
            for (let x = view.bboxX0; x < view.bboxX1; x++) {
                if (out[(y * outW + x) * 4 + 3] === 0) continue;
                if (!sampleViewInto(view, x + 0.5, y + 0.5, buf)) continue;
                if (x < ox0) ox0 = x;
                if (x >= ox1) ox1 = x + 1;
                if (y < oy0) oy0 = y;
                if (y >= oy1) oy1 = y + 1;
            }
        }

        const hasOverlap = ox1 > ox0 && oy1 > oy0;
        let seamLookup: Float32Array | null = null;
        let vertical = true;
        let along0 = 0;
        let bSideSign = 1;

        if (hasOverlap) {
            // 縫い目の向き: 重なり帯の長い方向に沿って切る。
            vertical = (oy1 - oy0) >= (ox1 - ox0);
            const alongLen = vertical ? oy1 - oy0 : ox1 - ox0;
            const crossLen = vertical ? ox1 - ox0 : oy1 - oy0;
            along0 = vertical ? oy0 : ox0;
            const cross0 = vertical ? ox0 : oy0;
            const stride = Math.max(1, Math.ceil(Math.sqrt(alongLen * crossLen / 4e6)));
            const nAlong = Math.max(1, Math.ceil(alongLen / stride));
            const nCross = Math.max(1, Math.ceil(crossLen / stride));

            // コストグリッド: 両画像の輝度差。片方しか無いセルは通れない。
            const INVALID = 1e9;
            const cost = new Float32Array(nAlong * nCross).fill(INVALID);
            for (let ia = 0; ia < nAlong; ia++) {
                for (let ic = 0; ic < nCross; ic++) {
                    const along = along0 + Math.min(alongLen - 1, ia * stride);
                    const cross = cross0 + Math.min(crossLen - 1, ic * stride);
                    const x = vertical ? cross : along;
                    const y = vertical ? along : cross;
                    const offset = (y * outW + x) * 4;
                    if (out[offset + 3] === 0) continue;
                    if (!sampleViewInto(view, x + 0.5, y + 0.5, buf)) continue;
                    const grayA = 0.299 * out[offset] + 0.587 * out[offset + 1] + 0.114 * out[offset + 2];
                    const grayB = 0.299 * buf[0] + 0.587 * buf[1] + 0.114 * buf[2];
                    cost[ia * nCross + ic] = Math.abs(grayA - grayB);
                }
            }

            // 動的計画法で最小コスト経路を求める。
            const dp = new Float32Array(nAlong * nCross);
            const from = new Int32Array(nAlong * nCross).fill(-1);
            dp.set(cost.subarray(0, nCross));
            for (let ia = 1; ia < nAlong; ia++) {
                const prev = (ia - 1) * nCross;
                const cur = ia * nCross;
                let rowMin = Infinity;
                for (let ic = 0; ic < nCross; ic++) {
                    let bestPrev = dp[prev + ic];
                    let bestIdx = ic;
                    if (ic > 0 && dp[prev + ic - 1] < bestPrev) {
                        bestPrev = dp[prev + ic - 1];
                        bestIdx = ic - 1;
                    }
                    if (ic < nCross - 1 && dp[prev + ic + 1] < bestPrev) {
                        bestPrev = dp[prev + ic + 1];
                        bestIdx = ic + 1;
                    }
                    const value = bestPrev + cost[cur + ic];
                    dp[cur + ic] = value;
                    from[cur + ic] = bestIdx;
                    if (value < rowMin) rowMin = value;
                }
                // 行全体が不通(重なりが途切れる)なら、その行はコストなしで通過させる。
                if (rowMin >= INVALID) {
                    for (let ic = 0; ic < nCross; ic++) {
                        dp[cur + ic] = dp[prev + ic];
                        from[cur + ic] = ic;
                    }
                }
            }

            // 経路を復元してグリッド座標→キャンバス座標の縫い目テーブルを作る。
            const seamGrid = new Int32Array(nAlong);
            {
                let best = 0;
                for (let ic = 1; ic < nCross; ic++) {
                    if (dp[(nAlong - 1) * nCross + ic] < dp[(nAlong - 1) * nCross + best]) best = ic;
                }
                seamGrid[nAlong - 1] = best;
                for (let ia = nAlong - 1; ia > 0; ia--) {
                    const f = from[ia * nCross + seamGrid[ia]];
                    seamGrid[ia - 1] = f >= 0 ? f : seamGrid[ia];
                }
            }
            seamLookup = new Float32Array(alongLen);
            for (let i = 0; i < alongLen; i++) {
                const pos = i / stride;
                const ia0 = Math.min(nAlong - 1, Math.floor(pos));
                const ia1 = Math.min(nAlong - 1, ia0 + 1);
                const t = pos - ia0;
                const crossGrid = seamGrid[ia0] * (1 - t) + seamGrid[ia1] * t;
                seamLookup[i] = cross0 + crossGrid * stride + stride / 2;
            }

            // 新画像が専有する側: 重なりbboxの外で新画像だけが届く画素が多い側。
            let lowSide = 0;
            let highSide = 0;
            for (let y = view.bboxY0; y < view.bboxY1; y += 4) {
                for (let x = view.bboxX0; x < view.bboxX1; x += 4) {
                    const cross = vertical ? x : y;
                    if (cross >= (vertical ? ox0 : oy0) && cross < (vertical ? ox1 : oy1)) continue;
                    if (out[(y * outW + x) * 4 + 3] !== 0) continue;
                    if (!sampleViewInto(view, x + 0.5, y + 0.5, buf)) continue;
                    if (cross < (vertical ? ox0 : oy0)) lowSide++;
                    else highSide++;
                }
            }
            bSideSign = highSide >= lowSide ? 1 : -1;
        }

        // 2パス目: 書き込み。未充填は無条件、競合は縫い目の自分側だけを採用する。
        const alongMax = (vertical ? oy1 - oy0 : ox1 - ox0) - 1;
        for (let y = view.bboxY0; y < view.bboxY1; y++) {
            for (let x = view.bboxX0; x < view.bboxX1; x++) {
                if (!sampleViewInto(view, x + 0.5, y + 0.5, buf)) continue;
                const offset = (y * outW + x) * 4;
                if (out[offset + 3] === 0) {
                    out[offset] = buf[0];
                    out[offset + 1] = buf[1];
                    out[offset + 2] = buf[2];
                    out[offset + 3] = 255;
                    continue;
                }
                if (!seamLookup) continue;
                const along = (vertical ? y : x) - along0;
                const seamAt = seamLookup[Math.max(0, Math.min(alongMax, along))];
                const d = ((vertical ? x : y) - seamAt) * bSideSign;
                if (d > SEAM_BLEND_PX) {
                    out[offset] = buf[0];
                    out[offset + 1] = buf[1];
                    out[offset + 2] = buf[2];
                } else if (d >= -SEAM_BLEND_PX) {
                    const w = (d + SEAM_BLEND_PX) / (2 * SEAM_BLEND_PX);
                    out[offset] = out[offset] * (1 - w) + buf[0] * w;
                    out[offset + 1] = out[offset + 1] * (1 - w) + buf[1] * w;
                    out[offset + 2] = out[offset + 2] * (1 - w) + buf[2] * w;
                }
            }
        }
    }

    // カバレッジを調べてクロップし、未充填は白にする。
    let coverX0 = outW;
    let coverY0 = outH;
    let coverX1 = 0;
    let coverY1 = 0;
    for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
            const offset = (y * outW + x) * 4;
            if (out[offset + 3] !== 0) {
                if (x < coverX0) coverX0 = x;
                if (x >= coverX1) coverX1 = x + 1;
                if (y < coverY0) coverY0 = y;
                if (y >= coverY1) coverY1 = y + 1;
            } else {
                out[offset] = 255;
                out[offset + 1] = 255;
                out[offset + 2] = 255;
                out[offset + 3] = 255;
            }
        }
    }

    if (coverX1 <= coverX0 || coverY1 <= coverY0) {
        throw new Error('合成結果が空になりました');
    }
    const cropW = coverX1 - coverX0;
    const cropH = coverY1 - coverY0;
    const canvas = createCanvas(cropW, cropH);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(outW, outH);
    imageData.data.set(out);
    ctx.putImageData(imageData, -coverX0, -coverY0);
    return { canvas, width: cropW, height: cropH };
}

/**
 * 1グループ分の画像を位置合わせして1枚のPNGへ合成する。
 */
async function stitchGroupImage(pages: PageInfo[], links: PairProbe[], outputPath: string, log: Logger = console.log): Promise<GroupStitchReport> {
    if (pages.length < 2) throw new Error('合成には2枚以上の画像が必要です');
    const localIndex = new Map(pages.map((page, i) => [page.index, i]));
    const images: any[] = [];
    for (const page of pages) {
        images.push(await loadImage(page.path));
    }

    // 各リンクの剛体変換を推定し、ポーズを波及させる。
    type Edge = { from: number; to: number; matrix: Affine; gain: number; report: GroupStitchReport['pairs'][number] };
    const edges: Edge[] = [];
    for (const link of links) {
        const la = localIndex.get(link.a);
        const lb = localIndex.get(link.b);
        if (la === undefined || lb === undefined || !link.offsetFull) continue;
        const refined = refinePairAlignment(images[la], images[lb], link, log);
        const matrix = affineCompose(refined.matrix, rotationAffine(link.rotationB, images[lb].width, images[lb].height));
        edges.push({
            from: la,
            to: lb,
            matrix,
            gain: refined.gain,
            report: {
                pages: [link.a + 1, link.b + 1],
                rotationB: link.rotationB,
                peak: link.peak,
                method: refined.method,
                thetaDeg: refined.thetaDeg,
                patches: refined.patches,
                inliers: refined.inliers,
                rmse: refined.rmse,
                gain: Number(refined.gain.toFixed(4)),
            },
        });
        log(`[stitch] ページ ${link.a + 1}-${link.b + 1}: ${refined.method === 'rigid' ? '剛体フィット' : '平行移動'} theta=${refined.thetaDeg.toFixed(3)}度 inliers=${refined.inliers}/${refined.patches} rmse=${refined.rmse ?? 'n/a'}px gain=${refined.gain.toFixed(3)}`);
    }

    const poses: Array<Affine | null> = pages.map(() => null);
    const gains = pages.map(() => 1);
    poses[0] = affineIdentity();
    // ポーズの伝播順 = 連結ツリーをたどる順。合成もこの順で行うことで、
    // 各画像が描画済み領域と1本の連結した帯で接し、縫い目が正しく機能する。
    const paintOrder: number[] = [0];
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of edges) {
            if (poses[edge.from] && !poses[edge.to]) {
                poses[edge.to] = affineCompose(poses[edge.from]!, edge.matrix);
                gains[edge.to] = gains[edge.from] * edge.gain;
                paintOrder.push(edge.to);
                changed = true;
            } else if (poses[edge.to] && !poses[edge.from]) {
                poses[edge.from] = affineCompose(poses[edge.to]!, affineInvert(edge.matrix));
                gains[edge.from] = gains[edge.to] / edge.gain;
                paintOrder.push(edge.from);
                changed = true;
            }
        }
    }
    const missing = poses.map((pose, i) => (pose ? -1 : pages[i].index + 1)).filter(v => v >= 0);
    if (missing.length > 0) {
        throw new Error(`グループ内のページを連結できませんでした: ${missing.join(', ')}`);
    }

    const sources: ComposeSource[] = paintOrder.map(i => {
        const canvas = createCanvas(images[i].width, images[i].height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(images[i], 0, 0);
        return {
            rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            width: images[i].width,
            height: images[i].height,
            pose: poses[i]!,
            gain: Math.min(1.25, Math.max(0.8, gains[i])),
        };
    });

    const composed = composeSources(sources);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, composed.canvas.toBuffer('image/png'));
    return {
        outputPath,
        width: composed.width,
        height: composed.height,
        pairs: edges.map(edge => edge.report),
    };
}

module.exports = {
    planGroups,
    stitchGroupImage,
};
