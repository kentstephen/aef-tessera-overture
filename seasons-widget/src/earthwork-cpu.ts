import { NUM_BANDS } from "./aef";
import { TES_BANDS, TES_FLIP, TES_OK, TES_SKIP } from "./tessera";

/** The map's three layers, as the notebook names them. */
export type LayerKind = "aggregate" | "aef" | "tessera";
export const LAYERS: LayerKind[] = ["aggregate", "aef", "tessera"];

export type Model = { w: number[]; b: number };

/**
 * The world recipe (models/model_world.npz): a logistic
 * regression per layer on [b, a, a*b, (a-b)^2] of unit vectors (the aggregate's
 * 768 weights take AlphaEarth's 256 then TESSERA's 512), TESSERA's gate bounds,
 * and each layer's cutoff (60% of held-out digging found).
 */
export type WorldModel = Record<LayerKind, Model> & {
  bounds: [number, number];
  cut: Record<LayerKind, number>;
};

/** AlphaEarth's change (1 - cos) at which its gate opens and is fully open. */
export const GATE_LO = 0.05;
export const GATE_HI = 0.15;

/** The inputs at one pixel: AlphaEarth's chunk, and TESSERA on it where read. */
export type PixelInputs = {
  aefFirst: Int8Array;
  aefLast: Int8Array;
  tesFirst?: Int8Array;
  tesLast?: Int8Array;
  tesFlags?: Uint8Array;
  /** Pixels per band plane (w * h) and the pixel's index in a plane. */
  plane: number;
  at: number;
};

const clip01 = (v: number) => Math.min(1, Math.max(0, v));
const sig = (z: number) => 1 / (1 + Math.exp(-z));

// AlphaEarth dequantized ((v / 127.5)^2 * sign(v)) and scaled to unit length; false where missing (-128)
function unitAef(src: Int8Array, plane: number, at: number, out: Float64Array): boolean {
  let n = 0;
  for (let i = 0; i < NUM_BANDS; i++) {
    const v = src[i * plane + at];
    if (v === -128) return false;
    const f = v / 127.5;
    out[i] = f * Math.abs(f);
    n += out[i] * out[i];
  }
  const s = 1 / Math.max(Math.sqrt(n), 1e-9);
  for (let i = 0; i < NUM_BANDS; i++) out[i] *= s;
  return true;
}

// TESSERA's int8 scaled to unit length as is (its per-pixel scale only says where a year is embedded)
function unitTes(src: Int8Array, plane: number, at: number, out: Float64Array): void {
  let n = 0;
  for (let i = 0; i < TES_BANDS; i++) {
    out[i] = src[i * plane + at];
    n += out[i] * out[i];
  }
  const s = 1 / Math.max(Math.sqrt(n), 1e-9);
  for (let i = 0; i < TES_BANDS; i++) out[i] *= s;
}

// b.w[0:d] + a.w[d:2d] + (a*b).w[2d:3d] + ((a-b)^2).w[3d:4d], from w[off]
function half(b: Float64Array, a: Float64Array, w: number[], off: number, d: number): number {
  let z = 0;
  for (let i = 0; i < d; i++) {
    const dd = a[i] - b[i];
    z += w[off + i] * b[i] + w[off + d + i] * a[i] + w[off + 2 * d + i] * a[i] * b[i] + w[off + 3 * d + i] * dd * dd;
  }
  return z;
}

function cosine(b: Float64Array, a: Float64Array, d: number): number {
  let c = 0;
  for (let i = 0; i < d; i++) c += a[i] * b[i];
  return c;
}

const bA = new Float64Array(NUM_BANDS), aA = new Float64Array(NUM_BANDS);
const bT = new Float64Array(TES_BANDS), aT = new Float64Array(TES_BANDS);

/** AlphaEarth's own score moved onto the aggregate's scale, piecewise linear: 0, its cutoff and 1 to 0, the
 * aggregate's cutoff and 1, so a pixel over AlphaEarth's cutoff is over the aggregate's. */
function onAggregateScale(s: number, m: WorldModel): number {
  const ca = m.cut.aef, cg = m.cut.aggregate;
  return s < ca ? (s * cg) / ca : cg + ((s - ca) * (1 - cg)) / (1 - ca);
}

/**
 * One layer's score at a pixel, as the shaders (earthwork-score.ts) and the
 * notebook's score_layers compute it; null where the layer has none there (a
 * year missing, or TESSERA not embedded for TESSERA's own layer). The aggregate
 * where TESSERA is missing a year takes AlphaEarth's own score instead.
 */
export function scorePixel(kind: LayerKind, m: WorldModel, p: PixelInputs): number | null {
  const { plane, at } = p;
  const needAef = kind !== "tessera", needTes = kind !== "aef";
  if (needAef && !unitAef(p.aefFirst, plane, at, bA)) return null;
  if (needAef && !unitAef(p.aefLast, plane, at, aA)) return null;
  // TESSERA not read here (AlphaEarth saw nothing worth it, see aefScores): the aggregate scores none
  if (kind === "aggregate" && p.tesFlags && p.tesFlags[at] & TES_SKIP) return 0;
  if (needTes) {
    if (!p.tesFirst || !p.tesLast || !p.tesFlags || !(p.tesFlags[at] & TES_OK)) {
      // TESSERA missing a year here (not embedded, or outside its store): the aggregate falls back to AlphaEarth's
      // own score, put on the aggregate's scale so that AlphaEarth's cutoff lands on the aggregate's
      if (kind !== "aggregate") return null;
      const ga = clip01((1 - cosine(bA, aA, NUM_BANDS) - GATE_LO) / (GATE_HI - GATE_LO));
      return onAggregateScale(sig(half(bA, aA, m.aef.w, 0, NUM_BANDS) + m.aef.b) * ga, m);
    }
    unitTes(p.tesFirst, plane, at, bT);
    unitTes(p.tesLast, plane, at, aT);
  }
  if (kind === "tessera") return sig(half(bT, aT, m.tessera.w, 0, TES_BANDS) + m.tessera.b);
  const ga = clip01((1 - cosine(bA, aA, NUM_BANDS) - GATE_LO) / (GATE_HI - GATE_LO));
  if (kind === "aef") return sig(half(bA, aA, m.aef.w, 0, NUM_BANDS) + m.aef.b) * ga;
  const [lo, hi] = m.bounds;
  const gt = clip01((1 - cosine(bT, aT, TES_BANDS) - lo) / Math.max(hi - lo, 1e-6));
  // where TESSERA's radar came or went its change says little: AlphaEarth's alone opens the gate
  const gate = p.tesFlags![at] & TES_FLIP ? ga : Math.max(ga, gt);
  const w = m.aggregate.w;
  return sig(half(bA, aA, w, 0, NUM_BANDS) + half(bT, aT, w, 4 * NUM_BANDS, TES_BANDS) + m.aggregate.b) * gate;
}

/**
 * AlphaEarth's own gated score at every pixel of a chunk, -1 where a year is missing. TESSERA is read
 * only in its blocks where some pixel scores at least TES_READ_AT: elsewhere the aggregate lights almost
 * nothing (on 277 lidar sites, reading half of TESSERA lost 0.2% of the digging the aggregate finds).
 */
export function aefScores(first: Int8Array, last: Int8Array, plane: number, m: WorldModel): Float32Array {
  const out = new Float32Array(plane);
  for (let at = 0; at < plane; at++) {
    if (!unitAef(first, plane, at, bA) || !unitAef(last, plane, at, aA)) {
      out[at] = -1;
      continue;
    }
    const ga = clip01((1 - cosine(bA, aA, NUM_BANDS) - GATE_LO) / (GATE_HI - GATE_LO));
    out[at] = ga > 0 ? sig(half(bA, aA, m.aef.w, 0, NUM_BANDS) + m.aef.b) * ga : 0;
  }
  return out;
}

/**
 * How far a chunk's lit ground can be trusted, 0 to 255 a pixel (255 where there is nothing to doubt: TESSERA not
 * read, where the aggregate scores none; for AlphaEarth's layer alone, ground it scores under 0.05). The product of
 * two parts:
 *
 * - agreement: AlphaEarth's own model and TESSERA's own both call it moved, each against its own cutoff (the lower of
 *   the two, score over cutoff, up to 1). They are fooled on different ground (AlphaEarth by crop switches TESSERA
 *   is quiet on), so a call only one of them makes is a weak one. Without TESSERA (AlphaEarth's layer alone,
 *   `tes` null), 1.
 * - somewhere new: the last year's ground is not one AlphaEarth saw in the earlier years (`earlier`, the few years
 *   before the first). Its nearest earlier year, as 1 - cos, over the first year's: a field cycling through its crops lands
 *   near a year it has been before (low), ground dug or built on lands somewhere it never was (near 1).
 */
export function crossCheckChunk(
  aefFirst: Int8Array,
  aefLast: Int8Array,
  earlier: Int8Array[],
  tes: { first: Int8Array; last: Int8Array; flags: Uint8Array } | null,
  aef: Float32Array,
  plane: number,
  w: number,
  m: WorldModel,
  drawn?: { score: Float32Array; cut: number },
): Uint8Array {
  const out = new Uint8Array(plane).fill(255);
  const read = new Uint8Array(plane);
  const e = new Float64Array(NUM_BANDS);
  for (let at = 0; at < plane; at++) {
    // only the pixels drawn (the year map's, over its layer's cutoff), when given
    if (drawn && !(drawn.score[at] >= drawn.cut)) continue;
    if (tes ? !(tes.flags[at] & TES_OK) || aef[at] < 0 : aef[at] < 0.05) continue;
    if (!unitAef(aefFirst, plane, at, bA) || !unitAef(aefLast, plane, at, aA)) continue;
    let agree = 1;
    if (tes) {
      unitTes(tes.first, plane, at, bT);
      unitTes(tes.last, plane, at, aT);
      const sT = sig(half(bT, aT, m.tessera.w, 0, TES_BANDS) + m.tessera.b);
      agree = clip01(Math.min(aef[at] / m.cut.aef, sT / m.cut.tessera));
    }
    const moved = 1 - cosine(bA, aA, NUM_BANDS);
    let near = moved;
    for (const y of earlier) if (unitAef(y, plane, at, e)) near = Math.min(near, 1 - cosine(e, aA, NUM_BANDS));
    const fresh = moved > 1e-3 ? clip01((near / moved - 0.2) / 0.5) : 1;
    out[at] = Math.round(255 * agree * fresh);
    read[at] = 1;
  }
  return smoothed(out, read, w, plane / w, 2);
}

// each pixel read, the mean of the pixels read within r of it (a (2r + 1) square): a patch reads as one call, not
// speckle. Summed tables, so a chunk is two passes
function smoothed(v: Uint8Array, read: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const W = w + 1, sum = new Float64Array(W * (h + 1)), cnt = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, k = (y + 1) * W + x + 1, on = read[i];
      sum[k] = (on ? v[i] : 0) + sum[k - 1] + sum[k - W] - sum[k - W - 1];
      cnt[k] = on + cnt[k - 1] + cnt[k - W] - cnt[k - W - 1];
    }
  const out = v.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!read[i]) continue;
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const a = y1 * W + x1, b = y0 * W + x1, c = y1 * W + x0, d = y0 * W + x0;
      out[i] = Math.round((sum[a] - sum[b] - sum[c] + sum[d]) / (cnt[a] - cnt[b] - cnt[c] + cnt[d]));
    }
  return out;
}
