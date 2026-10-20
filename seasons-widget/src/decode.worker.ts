/**
 * The decoder's quarters for a batch of pixels, off every other thread: one of a small pool. The chunk worker gathers
 * each dug pixel's inputs ([unit AlphaEarth, unit TESSERA] / sqrt(2), its year and the year before); here each year's
 * first layer is run once on them, and only the day's two inputs (sin and cos) are added per quarter.
 *
 * A quarter is the first whose decoded color departs from the same quarter of the year before by at least SPLIT of
 * the largest departure; 5 (unclear) under MIN.
 */
type Layer = { inputs: number; outputs: number; texels: number; offset: number };
type Init = { type: "init"; w: Float32Array; layers: Layer[] };
type Job = { type: "job"; id: number; a: Float32Array; b: Float32Array; n: number };

const QUARTER_DAYS = [45, 136, 227, 319];
const SPLIT = 0.5, MIN = 0.03;
const D = 192;

let W1: Float32Array, B1: Float32Array, Ws: Float32Array, Wc: Float32Array, rest: { w: Float32Array; b: Float32Array; inputs: number; outputs: number }[];

function init(m: Init) {
  const [l1, ...more] = m.layers;
  const row = l1.texels * 4;
  // the first layer split: the embedding's 192 weights (row-major, a row per unit), and the day's two
  W1 = new Float32Array(l1.outputs * D);
  B1 = new Float32Array(l1.outputs);
  Ws = new Float32Array(l1.outputs);
  Wc = new Float32Array(l1.outputs);
  for (let j = 0; j < l1.outputs; j++) {
    const r = l1.offset + j * row;
    W1.set(m.w.subarray(r, r + D), j * D);
    Ws[j] = m.w[r + D];
    Wc[j] = m.w[r + D + 1];
    B1[j] = m.w[r + (l1.texels - 1) * 4];
  }
  rest = more.map((l) => {
    const r0 = l.texels * 4, w = new Float32Array(l.outputs * l.inputs), b = new Float32Array(l.outputs);
    for (let j = 0; j < l.outputs; j++) {
      const r = l.offset + j * r0;
      w.set(m.w.subarray(r, r + l.inputs), j * l.inputs);
      b[j] = m.w[r + (l.texels - 1) * 4];
    }
    return { w, b, inputs: l.inputs, outputs: l.outputs };
  });
}

const H = 256;
const pre = new Float32Array(H), h1 = new Float32Array(H), h2 = new Float32Array(128), out = new Float32Array(3);

// the first layer's embedding part for one pixel: pre = W1 x + b1
function first(x: Float32Array, at: number) {
  for (let j = 0; j < H; j++) {
    let acc = B1[j];
    const o = j * D;
    for (let i = 0; i < D; i++) acc += W1[o + i] * x[at + i];
    pre[j] = acc;
  }
  return pre.slice();
}

// the rest of the net from a pixel's first-layer part and the day
function rest3(p: Float32Array, s: number, c: number): Float32Array {
  for (let j = 0; j < H; j++) h1[j] = Math.max(0, p[j] + Ws[j] * s + Wc[j] * c);
  const [l2, l3] = rest;
  for (let j = 0; j < l2.outputs; j++) {
    let acc = l2.b[j];
    const o = j * l2.inputs;
    for (let i = 0; i < l2.inputs; i++) acc += l2.w[o + i] * h1[i];
    h2[j] = Math.max(0, acc);
  }
  for (let j = 0; j < 3; j++) {
    let acc = l3.b[j];
    const o = j * l3.inputs;
    for (let i = 0; i < l3.inputs; i++) acc += l3.w[o + i] * h2[i];
    out[j] = acc;
  }
  return out;
}

const ANG = QUARTER_DAYS.map((d) => (2 * Math.PI * (d - 1)) / 365.25);
const SC = ANG.map((a) => [Math.sin(a), Math.cos(a)]);

function job(m: Job) {
  const codes = new Uint8Array(m.n);
  for (let k = 0; k < m.n; k++) {
    const pa = first(m.a, k * D), pb = first(m.b, k * D);
    let big = 0;
    const dep = SC.map(([s, c]) => {
      const ya = rest3(pa, s, c), r0 = ya[0], r1 = ya[1], r2 = ya[2];
      const yb = rest3(pb, s, c);
      const d = Math.hypot(r0 - yb[0], r1 - yb[1], r2 - yb[2]);
      if (d > big) big = d;
      return d;
    });
    codes[k] = big < MIN ? 5 : dep.findIndex((d) => d >= SPLIT * big) + 1;
  }
  postMessage({ id: m.id, codes }, { transfer: [codes.buffer] });
}

self.onmessage = (ev: MessageEvent<Init | Job>) => {
  if (ev.data.type === "init") init(ev.data);
  else job(ev.data);
};
