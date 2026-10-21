import * as zarr from "zarrita";

import { type AefArray, NUM_BANDS, openMosaic, RES, X0, Y0 } from "./aef";
import { cacheGet, cachePut, DiskCachedStore, fingerprint } from "./disk-cache";
import { aefScores, crossCheckChunk, type LayerKind, type WorldModel } from "./earthwork-cpu";
import ScoreWorker from "./score.worker.ts?worker&inline";
import { TES_BANDS, TES_OK, tesseraOnChunk } from "./tessera";

// the scoring math on a few workers of its own (score.worker.ts), the least busy first: several chunks score at once
// on other cores, and the reads here never wait on it. Same functions on the same inputs, so the same scores
type Sw = { w: Worker; busy: number; waiting: Map<number, (v: Float32Array) => void> };
let sws: Sw[] | null = null;
let swId = 0;
function swRun(job: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<Float32Array> {
  if (!sws)
    sws = Array.from({ length: Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)) }, () => {
      const w = new ScoreWorker();
      w.postMessage({ type: "init", model });
      const sw: Sw = { w, busy: 0, waiting: new Map() };
      w.onmessage = (ev: MessageEvent<{ id: number; out: Float32Array }>) => {
        sw.busy--;
        sw.waiting.get(ev.data.id)?.(ev.data.out);
        sw.waiting.delete(ev.data.id);
      };
      return sw;
    });
  const sw = sws.reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = ++swId;
  sw.busy++;
  return new Promise((ok) => {
    sw.waiting.set(id, ok);
    sw.w.postMessage({ ...job, id }, transfer);
  });
}

/**
 * Every chunk is read here, off the page's thread: AlphaEarth's two years, its own scores (which say
 * where TESSERA is worth reading), then TESSERA on its pixels (not for AlphaEarth's layer alone). Downloads, decoding and resampling never
 * hold up the map, the imagery or the keys; the page only makes the textures.
 */
type Read = { type: "read"; id: number; px0: number; py0: number; w: number; h: number; firstIdx: number; lastIdx: number; aefOnly?: boolean };
/** The paint: a layer's score for one chunk, for every year in `allIdx` (each from the year before it); with `check`
 * (the year map), each year's cross-check too, a plane a year. */
type Score = { type: "score"; id: number; kind: LayerKind; px0: number; py0: number; w: number; h: number; allIdx: number[]; check?: boolean };
/** The cross-check of a window's chunk (crossCheckChunk): AlphaEarth's three years before the first read too, and TESSERA unless `aefOnly`. */
type Check = { type: "check"; id: number; px0: number; py0: number; w: number; h: number; firstIdx: number; lastIdx: number; aefOnly?: boolean };
/** One chunk's codes for the map: each pixel's latest year the aggregate had it over its cutoff (an index into the
 * years, 0 none), every year it did (a bit each), and the WSF Tracker's half-year index there (0 never, 1 built by
 * July 2016, k the half-year). */
type Codes = { type: "codes"; id: number; px0: number; py0: number; w: number; h: number; allIdx: number[] };
/** The quarter each pixel over the cutoff in year `idx` changed in (1 to 4, 5 unclear, 0 not that year). */
type Seasons = { type: "seasons"; id: number; px0: number; py0: number; w: number; h: number; idx: number; allIdx: number[] };
type Msg = { type: "init"; model: WorldModel } | Read | Score | Check | Codes | Seasons | { type: "abort"; id: number };

let model: WorldModel | null = null;
// the model's fingerprint, in the keys of the scores kept on disk (a new model scores afresh)
let modelFp = "";
let mosaic: Promise<AefArray> | null = null;
const running = new Map<number, AbortController>();

// AlphaEarth's chunks by year, the last used last (each 64 bands x 256 x 256, 4 MB; 64 kept, about 250 MB): a chunk's
// years are read once for all the pairs that share them (2022 for 2021-2022 and 2022-2023)
const AEF_KEEP = 64;
// a read is shared by the tiles waiting on it, and stopped only when every one of them has let go
type Kept = { p: Promise<zarr.Chunk<"int8">>; ac: AbortController; waiting: number; done: boolean };
const aefKept = new Map<string, Kept>();
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
function aefChunk(arr: AefArray, idx: number, py0: number, px0: number, h: number, w: number, signal: AbortSignal) {
  const k = `${idx}:${py0}:${px0}:${h}:${w}`;
  let e = aefKept.get(k);
  if (e) {
    aefKept.delete(k);
    aefKept.set(k, e);
  } else {
    const ac = new AbortController();
    const p = zarr.get(arr, [idx, null, zarr.slice(py0, py0 + h), zarr.slice(px0, px0 + w)], { signal: ac.signal }) as Promise<zarr.Chunk<"int8">>;
    const ent: Kept = { p, ac, waiting: 0, done: false };
    p.then(() => (ent.done = true), () => aefKept.get(k) === ent && aefKept.delete(k));
    aefKept.set(k, ent);
    while (aefKept.size > AEF_KEEP) aefKept.delete(aefKept.keys().next().value as string);
    e = ent;
  }
  if (e.done) return e.p;
  const ent = e;
  ent.waiting++;
  return new Promise<zarr.Chunk<"int8">>((resolve, reject) => {
    const letGo = () => {
      reject(aborted());
      if (--ent.waiting === 0 && !ent.done) {
        ent.ac.abort();
        if (aefKept.get(k) === ent) aefKept.delete(k);
      }
    };
    if (signal.aborted) return letGo();
    signal.addEventListener("abort", letGo, { once: true });
    ent.p.then(
      (v) => { signal.removeEventListener("abort", letGo); ent.waiting--; resolve(v); },
      (err) => { signal.removeEventListener("abort", letGo); ent.waiting--; reject(err); },
    );
  });
}

// ---- the paint's scores: per layer, chunk and year, the layer's score from the year before (TESSERA read for the
// aggregate and TESSERA's own, where AlphaEarth points, as for the map), as 1 + 254 x score (0 where
// a year is missing), 64 KB a chunk and year where its two years are 8 MB. Kept by "kind:lastIdx:py0:px0:h:w", the
// last used last, so a layer switched back to draws from here
const SCORE_KEEP = 1500;
// the cross-check's years before a pair's first: crops rotate within two or three, and each year is 4 MB a chunk to read
const EARLIER = 3;
const scoreKept = new Map<string, Promise<Uint8Array>>();
const scoreKey = (kind: LayerKind, lastIdx: number, m: { py0: number; px0: number; h: number; w: number }) => `${kind}:${lastIdx}:${m.py0}:${m.px0}:${m.h}:${m.w}`;
function encodeScores(sc: Float32Array): Uint8Array {
  const out = new Uint8Array(sc.length);
  for (let i = 0; i < sc.length; i++) out[i] = sc[i] < 0 ? 0 : 1 + Math.round(254 * Math.min(1, sc[i]));
  return out;
}
// the year map's cross-check a year, by scoreKey: made with the pair's score, from the same years in hand (and the
// three before, which the year map reads anyway), for the pixels it draws only
const yearCheckKept = new Map<string, Promise<Uint8Array>>();
// the scores and cross-checks are kept on disk too (disk-cache.ts), so a reload draws them without reading the
// embeddings again (64 KB a chunk and year, against 8 MB of embeddings). SCORE_V goes up when the scoring changes
const SCORE_V = 1;
const SCORE_TTL = 30 * 864e5;
const diskKey = (part: "s" | "c", k: string) => `score:v${SCORE_V}:${modelFp}:${part}:${k}`;
const kept_ = <T,>(m: Map<string, T>, k: string) => {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
};
const keepIn = <T,>(m: Map<string, Promise<T>>, k: string, p: Promise<T>) => {
  m.set(k, p);
  p.catch(() => m.get(k) === p && m.delete(k));
  while (m.size > SCORE_KEEP) m.delete(m.keys().next().value as string);
};
async function pairScore(kind: LayerKind, lastIdx: number, g: { py0: number; px0: number; h: number; w: number }, signal: AbortSignal, wantCheck = false): Promise<Uint8Array> {
  const k = scoreKey(kind, lastIdx, g);
  const kept = kept_(scoreKept, k);
  if (kept && (!wantCheck || yearCheckKept.has(k))) return kept;
  const plane = g.w * g.h;
  const both = (async () => {
    const [ds, dc] = await Promise.all([cacheGet(diskKey("s", k)), wantCheck ? cacheGet(diskKey("c", k)) : undefined]);
    if (ds && ds.length === plane && (!wantCheck || (dc && dc.length === plane))) return { score: ds, check: dc || null };
    if (!mosaic) mosaic = openMosaic().then((o) => o.arr);
    mosaic.catch(() => (mosaic = null));
    const arr = await mosaic;
    const [f, l] = await Promise.all([
      aefChunk(arr, lastIdx - 1, g.py0, g.px0, g.h, g.w, signal),
      aefChunk(arr, lastIdx, g.py0, g.px0, g.h, g.w, signal),
    ]);
    const aefFirst = f.data as Int8Array, aefLast = l.data as Int8Array;
    // copies of the kept AlphaEarth chunks go to the scoring workers
    const aef = await swRun({ type: "aef", first: aefFirst, last: aefLast, plane });
    let t: Awaited<ReturnType<typeof tesseraOnChunk>> | null = null, sc = aef;
    if (kind !== "aef") {
      t = await tesseraOnChunk(g.px0, g.py0, g.w, g.h, lastIdx - 1, lastIdx, signal, aef);
      // TESSERA's arrays handed over when the cross-check does not need them after
      sc = await swRun(
        { type: "pair", kind, aefFirst, aefLast, tesFirst: t.first, tesLast: t.last, tesFlags: t.flags, plane },
        wantCheck ? [] : ([t.first.buffer, t.last.buffer, t.flags.buffer] as ArrayBuffer[]),
      );
    }
    let check: Uint8Array | null = null;
    if (wantCheck) {
      const before = Array.from({ length: lastIdx - 1 }, (_, i) => i).slice(-EARLIER);
      const earlier = (await Promise.all(before.map((i) => aefChunk(arr, i, g.py0, g.px0, g.h, g.w, signal)))).map((c) => c.data as Int8Array);
      check = crossCheckChunk(aefFirst, aefLast, earlier, t, aef, plane, g.w, model!, { score: sc, cut: model!.cut[kind] });
    }
    const score = encodeScores(sc);
    cachePut(diskKey("s", k), score, SCORE_TTL);
    if (check) cachePut(diskKey("c", k), check, SCORE_TTL);
    return { score, check };
  })();
  const p = both.then((r) => r.score);
  keepIn(scoreKept, k, p);
  if (wantCheck) keepIn(yearCheckKept, k, both.then((r) => r.check as Uint8Array));
  return p;
}
// every year of a chunk at once, packed one year per channel (RGBA: up to four years), so a step between years
// only reads another channel on the GPU; five to eight years (the year map's) packed eight to a pixel
async function score(m: Score) {
  const ac = new AbortController();
  running.set(m.id, ac);
  try {
    const plane = m.w * m.h, n = Math.min(8, m.allIdx.length), stride = n <= 4 ? 4 : 8, ys = m.allIdx.slice(0, n);
    const each = await Promise.all(ys.map((y) => pairScore(m.kind, y, m, ac.signal, !!m.check)));
    const out = new Uint8Array(stride * plane);
    for (let c = 0; c < n; c++) {
      const sc = each[c];
      for (let i = 0; i < plane; i++) out[stride * i + c] = sc[i];
    }
    if (!m.check) {
      postMessage({ id: m.id, score: out }, { transfer: [out.buffer] as ArrayBuffer[] });
      return;
    }
    // the cross-check a plane a year, one after another
    const cs = await Promise.all(ys.map((y) => yearCheckKept.get(scoreKey(m.kind, y, m)) as Promise<Uint8Array>));
    const check = new Uint8Array(plane * n);
    cs.forEach((c, i) => check.set(c, i * plane));
    postMessage({ id: m.id, score: out, check }, { transfer: [out.buffer, check.buffer] as ArrayBuffer[] });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    postMessage({ id: m.id, error: { name: err?.name || "Error", message: err?.message || String(e) } });
  } finally {
    running.delete(m.id);
  }
}

async function read(m: Read) {
  const ac = new AbortController();
  running.set(m.id, ac);
  const signal = ac.signal;
  try {
    if (!mosaic) mosaic = openMosaic().then((o) => o.arr);
    mosaic.catch(() => (mosaic = null));
    const arr = await mosaic;
    const [f, l] = await Promise.all([
      aefChunk(arr, m.firstIdx, m.py0, m.px0, m.h, m.w, signal),
      aefChunk(arr, m.lastIdx, m.py0, m.px0, m.h, m.w, signal),
    ]);
    for (const c of [f, l])
      if (c.shape.length !== 3 || c.shape[0] !== NUM_BANDS || c.shape[1] !== m.h || c.shape[2] !== m.w)
        throw new Error(`Unexpected chunk shape [${c.shape.join(", ")}] for a ${m.w} x ${m.h} tile`);
    // copies: the kept chunks stay here, the copies go to the page
    const aefFirst = (f.data as Int8Array).slice(), aefLast = (l.data as Int8Array).slice();
    // AlphaEarth's layer alone needs no TESSERA
    if (m.aefOnly) {
      const none = new Int8Array(0), noFlags = new Uint8Array(0);
      postMessage({ id: m.id, aefFirst, aefLast, tesFirst: none, tesLast: none, tesFlags: noFlags }, { transfer: [aefFirst.buffer, aefLast.buffer] as ArrayBuffer[] });
      return;
    }
    const scores = model ? aefScores(aefFirst, aefLast, m.w * m.h, model) : undefined;
    const t = await tesseraOnChunk(m.px0, m.py0, m.w, m.h, m.firstIdx, m.lastIdx, signal, scores);
    const out = { id: m.id, aefFirst, aefLast, tesFirst: t.first, tesLast: t.last, tesFlags: t.flags };
    postMessage(out, { transfer: [aefFirst.buffer, aefLast.buffer, t.first.buffer, t.last.buffer, t.flags.buffer] as ArrayBuffer[] });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    postMessage({ id: m.id, error: { name: err?.name || "Error", message: err?.message || String(e) } });
  } finally {
    running.delete(m.id);
  }
}

// a pair's cross-check for a chunk, kept like the scores (64 KB each). The pair's two years come from the chunks kept
// (the map has just read them), TESSERA from its kept ranges
const checkKept = new Map<string, Promise<Uint8Array>>();
async function pairCheck(firstIdx: number, lastIdx: number, aefOnly: boolean, g: { py0: number; px0: number; h: number; w: number }, signal: AbortSignal) {
  const k = `${aefOnly ? "a" : "t"}:${firstIdx}:${lastIdx}:${g.py0}:${g.px0}:${g.h}:${g.w}`;
  const kept = checkKept.get(k);
  if (kept) {
    checkKept.delete(k);
    checkKept.set(k, kept);
    return kept;
  }
  if (!mosaic) mosaic = openMosaic().then((o) => o.arr);
  mosaic.catch(() => (mosaic = null));
  const arr = await mosaic;
  const before = Array.from({ length: firstIdx }, (_, i) => i).slice(-EARLIER);
  const p = Promise.all([firstIdx, lastIdx, ...before].map((i) => aefChunk(arr, i, g.py0, g.px0, g.h, g.w, signal))).then(async (cs) => {
    const [aefFirst, aefLast, ...earlier] = cs.map((c) => c.data as Int8Array);
    const plane = g.w * g.h, aef = aefScores(aefFirst, aefLast, plane, model!);
    const t = aefOnly ? null : await tesseraOnChunk(g.px0, g.py0, g.w, g.h, firstIdx, lastIdx, signal, aef);
    return crossCheckChunk(aefFirst, aefLast, earlier, t, aef, plane, g.w, model!);
  });
  checkKept.set(k, p);
  p.catch(() => checkKept.get(k) === p && checkKept.delete(k));
  while (checkKept.size > SCORE_KEEP) checkKept.delete(checkKept.keys().next().value as string);
  return p;
}

async function check(m: Check) {
  const ac = new AbortController();
  running.set(m.id, ac);
  const signal = ac.signal;
  try {
    const out = (await pairCheck(m.firstIdx, m.lastIdx, !!m.aefOnly, m, signal)).slice();
    postMessage({ id: m.id, score: out }, { transfer: [out.buffer] as ArrayBuffer[] });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    postMessage({ id: m.id, error: { name: err?.name || "Error", message: err?.message || String(e) } });
  } finally {
    running.delete(m.id);
  }
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  if (m.type === "init") { model = m.model; modelFp = fingerprint(JSON.stringify(m.model)); }
  else if (m.type === "codes") void answer(m.id, () => codes(m));
  else if (m.type === "seasons") void answer(m.id, () => seasons(m));
  else if (m.type === "abort") running.get(m.id)?.abort();
  else if (m.type === "score") void score(m);
  else if (m.type === "check") void check(m);
  else void read(m);
};

// ---- the map's codes and seasons --------------------------------------------------------------------------------

async function answer(id: number, f: () => Promise<Record<string, Uint8Array>>) {
  try {
    const r = await f();
    postMessage({ id, ...r }, { transfer: Object.values(r).map((a) => a.buffer) as ArrayBuffer[] });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    postMessage({ id, error: { name: err?.name || "Error", message: err?.message || String(e) } });
  } finally {
    running.delete(id);
  }
}

/** Each pixel's latest year over the aggregate's cutoff, as its index into the years (0 none), and every year it was
 * over it (a bit for each of allIdx, in order), from the kept scores. */
async function lit(g: { py0: number; px0: number; h: number; w: number; allIdx: number[] }, signal: AbortSignal) {
  const plane = g.w * g.h, over = 1 + 254 * model!.cut.aggregate;
  const each = await Promise.all(g.allIdx.map((i) => pairScore("aggregate", i, g, signal)));
  const last = new Uint8Array(plane), bits = new Uint8Array(plane);
  g.allIdx.forEach((idx, c) => {
    const sc = each[c];
    for (let i = 0; i < plane; i++)
      if (sc[i] >= over) {
        bits[i] |= 1 << c;
        if (idx > last[i]) last[i] = idx;
      }
  });
  return { last, bits };
}

// the WSF Tracker: one global GeoZarr at about 10 m (its own grid, a hair off AlphaEarth's), int8, level 0
const WSF_URL = "https://data.source.coop/mindearth/wsf/World_WSF_20160701-20260101.zarr";
const WSF_RES = 8.983152841195216e-5, WSF_X0 = -180.00001488697754, WSF_Y0 = 78.0100585990529;
let wsfArr: Promise<zarr.Array<"int8", zarr.Readable>> | null = null;
async function wsfChunk(g: { py0: number; px0: number; h: number; w: number }, signal: AbortSignal) {
  if (!wsfArr)
    wsfArr = (async () => {
      const store = new DiskCachedStore(WSF_URL, new zarr.FetchStore(WSF_URL));
      const root = await zarr.open.v3(store, { kind: "group" });
      return (await zarr.open.v3(root.resolve("0/wsf_tracker"), { kind: "array" })) as zarr.Array<"int8", zarr.Readable>;
    })();
  wsfArr.catch(() => (wsfArr = null));
  const arr = await wsfArr;
  // the WSF pixel under each AlphaEarth pixel center
  const col = (i: number) => Math.floor((X0 + (g.px0 + i + 0.5) * RES - WSF_X0) / WSF_RES);
  const row = (j: number) => Math.floor((WSF_Y0 - (Y0 - (g.py0 + j + 0.5) * RES)) / WSF_RES);
  const c0 = col(0), c1 = col(g.w - 1), r0 = row(0), r1 = row(g.h - 1);
  const out = new Uint8Array(g.w * g.h);
  if (r1 < 0 || r0 >= arr.shape[0]) return out;
  const got = await zarr.get(arr, [zarr.slice(Math.max(0, r0), r1 + 1), zarr.slice(c0, c1 + 1)], { signal });
  const d = got.data as Int8Array, ww = c1 - c0 + 1;
  for (let j = 0; j < g.h; j++) {
    const r = row(j) - Math.max(0, r0);
    if (r < 0) continue;
    for (let i = 0; i < g.w; i++) out[j * g.w + i] = Math.max(0, d[r * ww + (col(i) - c0)]);
  }
  return out;
}

async function codes(m: Codes) {
  const ac = new AbortController();
  running.set(m.id, ac);
  // WSF commented out for now: not read
  // const [ours, wsf] = await Promise.all([latest(m, ac.signal), wsfChunk(m, ac.signal).catch(() => new Uint8Array(m.w * m.h))]);
  const { last: ours, bits } = await lit(m, ac.signal), wsf = new Uint8Array(m.w * m.h);
  void wsfChunk;
  return { ours, bits, wsf };
}

// one pixel's [unit AlphaEarth, unit TESSERA] / sqrt(2) into out at `o`; false where AlphaEarth is missing
function decoderInputs(aef: Int8Array, tes: Int8Array, plane: number, at: number, out: Float32Array, o: number): boolean {
  let na = 0, nt = 0;
  for (let i = 0; i < NUM_BANDS; i++) {
    const v = aef[i * plane + at];
    if (v === -128) return false;
    const f = v / 127.5;
    out[o + i] = f * Math.abs(f);
    na += out[o + i] * out[o + i];
  }
  for (let i = 0; i < TES_BANDS; i++) {
    out[o + 64 + i] = tes[i * plane + at];
    nt += out[o + 64 + i] * out[o + 64 + i];
  }
  const sa = Math.SQRT1_2 / Math.max(Math.sqrt(na), 1e-9), st = Math.SQRT1_2 / Math.max(Math.sqrt(nt), 1e-9);
  for (let i = 0; i < 64; i++) out[o + i] *= sa;
  for (let i = 64; i < 192; i++) out[o + i] *= st;
  return true;
}

/**
 * The pixels over the cutoff in year `idx` (whatever came after), and the decoder's inputs for each, that year and the year before (n x 192
 * each): the decoding itself is the decode workers' (decode.worker.ts). `unclear` the pixels it cannot be made out for
 * (TESSERA or AlphaEarth missing in a year).
 */
async function seasons(m: Seasons) {
  const ac = new AbortController();
  running.set(m.id, ac);
  const plane = m.w * m.h;
  const { bits } = await lit(m, ac.signal);
  const bit = 1 << m.allIdx.indexOf(m.idx);
  const want: number[] = [];
  for (let i = 0; i < plane; i++) if (bits[i] & bit) want.push(i);
  if (!want.length || m.idx < 1) return { px: new Uint8Array(0), a: new Uint8Array(0), b: new Uint8Array(0), unclear: new Uint8Array(0) };
  if (!mosaic) mosaic = openMosaic().then((o) => o.arr);
  const arr = await mosaic;
  const [f, l] = await Promise.all([aefChunk(arr, m.idx - 1, m.py0, m.px0, m.h, m.w, ac.signal), aefChunk(arr, m.idx, m.py0, m.px0, m.h, m.w, ac.signal)]);
  const aefB = f.data as Int8Array, aefA = l.data as Int8Array;
  // TESSERA where AlphaEarth pointed, as the scores read it (so its blocks are the ones already kept)
  const t = await tesseraOnChunk(m.px0, m.py0, m.w, m.h, m.idx - 1, m.idx, ac.signal, aefScores(aefB, aefA, plane, model!));
  const a = new Float32Array(want.length * 192), b = new Float32Array(want.length * 192);
  const px = new Uint32Array(want.length), unclear: number[] = [];
  let n = 0;
  for (const at of want) {
    if (!(t.flags[at] & TES_OK) || !decoderInputs(aefA, t.last, plane, at, a, n * 192) || !decoderInputs(aefB, t.first, plane, at, b, n * 192)) {
      unclear.push(at);
      continue;
    }
    px[n++] = at;
  }
  const u8 = (x: ArrayBufferView) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return { px: u8(px.slice(0, n)), a: u8(a.slice(0, n * 192)), b: u8(b.slice(0, n * 192)), unclear: u8(new Uint32Array(unclear)) };
}
