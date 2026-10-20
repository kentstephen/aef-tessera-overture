import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import * as zarr from "zarrita";

import { type AefArray, CHUNK, openMosaic, RES, X0, Y0, YEAR_ORIGIN, YEARS } from "./aef";
import ChunkWorker from "./chunk.worker.ts?worker&inline";
import DecodeWorker from "./decode.worker.ts?worker&inline";
import type { WorldModel } from "./earthwork-cpu";

/** What the map colors: the aggregate's years (ours) or WSF's, all years or one year opened. */
export type Look = { src: "ours" | "wsf"; year: number | null };

/** The year ramp (Crameri's imola, blue to yellow, its whole length), 2018 to 2025:
 * the years ours can date (its first pair is 2017 to 2018). */
// 2016 and 2017 commented out with WSF, the only source that dates them:
// export const YEAR_COL = ["#1a33b3", "#2446a9", "#2d59a0", "#396b94", "#497b85", "#60927b", "#7bae74", "#99cc6d", "#c4ea67", "#ffff66"];
// export const Y0_RAMP = 2016;
export const YEAR_COL = ["#1a33b3", "#274ca6", "#346499", "#467987", "#64967a", "#87ba71", "#b5e268", "#ffff66"];
export const Y0_RAMP = 2018;
/** The quarters (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec) and WSF's halves, steps of the same ramp; a quarter not made out, gray. */
export const SEASON_COL = ["#1a33b3", "#396b94", "#7bae74", "#ffff66"];
export const HALF_COL = ["#356598", "#b2e068"];
export const UNCLEAR = "#9aa1a9";
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const YR = YEAR_COL.map(rgb), SE = SEASON_COL.map(rgb), UN = rgb(UNCLEAR);
// WSF commented out for now
// const HF = HALF_COL.map(rgb);
const ALPHA = 225;

/** The pairs of years scored: 2018 (from 2017) to 2025, as indices into YEARS. */
const ALL_IDX = YEARS.slice(1).map((y) => y - YEAR_ORIGIN);

type Tile = {
  key: string;
  px0: number;
  py0: number;
  width: number;
  height: number;
  byteLength: number;
  /** each pixel's latest year index over the cutoff (0 none), and WSF's half-year index (0 never) */
  ours: Uint8Array;
  /** every year it was over the cutoff, a bit for each of ALL_IDX */
  bits: Uint8Array;
  wsf: Uint8Array;
  /** the seasons asked for, by year index */
  seasons: Map<number, Uint8Array>;
  asking: Set<number>;
  tex: Texture | null;
  painted: string;
  gone?: boolean;
};

const PaintTex = {
  name: "paintTex",
  inject: {
    "fs:#decl": `uniform highp sampler2D paintTex;\n`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      ivec2 size = textureSize(paintTex, 0);
      ivec2 px = clamp(ivec2(geometry.uv * vec2(size)), ivec2(0), size - 1);
      vec4 c = texelFetch(paintTex, px, 0);
      if (c.a < 0.01) discard;
      color = c;
    `,
  },
  getUniforms: (p: { paintTex?: Texture }) => ({ paintTex: p.paintTex }),
} as const satisfies ShaderModule<{ paintTex?: Texture }>;

const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/**
 * The map's one data layer: per 256 x 256 chunk of the AlphaEarth mosaic, the aggregate earthwork model scored on
 * every pair of years in the worker (its scores kept on disk), each pixel's latest year over the cutoff, and WSF's
 * half-year there. Colored here, so switching between the sources, or opening a year, reads nothing; a year opened
 * for ours asks the worker for that year's quarters (the decoder, for the pixels of that year only).
 */
export async function createCodesLayer(model: WorldModel, decoder: { w: Float32Array; layers: unknown[] }, redraw: () => void) {
  const { arr, attrs } = await openMosaic();
  const worker = new ChunkWorker();
  worker.postMessage({ type: "init", model });

  // the decoder's pool: a few workers of their own, each given batches of pixels, the least busy first
  const POOL = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const BATCH = 1500;
  const pool = Array.from({ length: POOL }, () => {
    const w = new DecodeWorker();
    w.postMessage({ type: "init", w: decoder.w, layers: decoder.layers });
    const job = { w, busy: 0, waiting: new Map<number, (c: Uint8Array) => void>() };
    w.onmessage = (ev: MessageEvent<{ id: number; codes: Uint8Array }>) => {
      job.busy--;
      job.waiting.get(ev.data.id)?.(ev.data.codes);
      job.waiting.delete(ev.data.id);
    };
    return job;
  });
  let jobId = 0;
  function decodeBatch(a: Float32Array, b: Float32Array, n: number): Promise<Uint8Array> {
    const j = pool.reduce((x, y) => (y.busy < x.busy ? y : x));
    const id = ++jobId;
    j.busy++;
    return new Promise((ok) => {
      j.waiting.set(id, ok);
      j.w.postMessage({ type: "job", id, a, b, n }, [a.buffer, b.buffer]);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asked = new Map<number, { resolve: (r: any) => void; reject: (e: unknown) => void }>();
  let askId = 0;
  worker.onmessage = (ev: MessageEvent<{ id: number; error?: { name: string; message: string } }>) => {
    const { id, error, ...r } = ev.data;
    const a = asked.get(id);
    if (!a) return;
    asked.delete(id);
    if (error) a.reject(Object.assign(new Error(error.message), { name: error.name }));
    else a.resolve(r);
  };
  function ask<T>(msg: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted());
    const id = ++askId;
    return new Promise<T>((resolve, reject) => {
      asked.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id });
      signal?.addEventListener("abort", () => {
        if (!asked.has(id)) return;
        asked.delete(id);
        worker.postMessage({ type: "abort", id });
        reject(aborted());
      });
    });
  }

  let look: Look = { src: "ours", year: null };
  // the area read, in mosaic pixels: the raster stops at its edge (its footprints were read only inside it)
  let areaPx = [-Infinity, -Infinity, Infinity, Infinity];
  // what is being worked on now, for the loading bar: chunks asked of the worker and not back yet (and how many this
  // read has had back), and chunks whose quarters are decoding
  const work = { reading: 0, readDone: 0, decoding: 0, decodeDone: 0 };
  let device: Device | null = null;
  let version = 0;
  const live = new Map<string, Tile>();
  const keyOf = (r: number, c: number) => `${r}-${c}`;
  const lookKey = (l: Look, t: Tile) => `${l.src}:${l.year ?? "all"}:${l.year != null && l.src === "ours" && t.seasons.has(l.year - YEAR_ORIGIN) ? "s" : "-"}`;

  function paint(t: Tile) {
    if (!device || t.gone) return;
    const k = lookKey(look, t);
    if (t.painted === k && t.tex) return;
    const n = t.width * t.height, out = new Uint8Array(4 * n);
    const yIdx = look.year != null ? look.year - YEAR_ORIGIN : -1;
    // a year opened: every pixel over the cutoff that year, whatever came after (not only those it was last for)
    const yBit = yIdx >= 0 ? 1 << ALL_IDX.indexOf(yIdx) : 0;
    const sea = look.src === "ours" && yIdx >= 0 ? t.seasons.get(yIdx) : undefined;
    const [ax0, ay0, ax1, ay1] = areaPx;
    for (let i = 0; i < n; i++) {
      const gx = t.px0 + (i % t.width), gy = t.py0 + Math.floor(i / t.width);
      if (gx < ax0 || gx > ax1 || gy < ay0 || gy > ay1) continue;
      let c: number[] | null = null;
      if (look.src === "ours") {
        const idx = t.ours[i];
        if (!idx) continue;
        if (yIdx < 0) c = YR[YEAR_ORIGIN + idx - Y0_RAMP];
        else if (t.bits[i] & yBit) {
          // still decoding: not drawn (gray is only for a quarter not made out)
          if (!sea) continue;
          c = sea[i] >= 1 && sea[i] <= 4 ? SE[sea[i] - 1] : UN;
        }
      }
      // WSF commented out for now (its years 2016 and 2017 are off the ramp too)
      // else {
      //   const k = t.wsf[i];
      //   if (k < 2) continue;
      //   const y = 2016 + ((k - 1) >> 1);
      //   if (look.year == null) c = YR[y - Y0_RAMP];
      //   else if (y === look.year) c = HF[k % 2 === 0 ? 1 : 0];
      // }
      if (!c) continue;
      out[4 * i] = c[0];
      out[4 * i + 1] = c[1];
      out[4 * i + 2] = c[2];
      out[4 * i + 3] = ALPHA;
    }
    t.tex?.destroy();
    t.tex = device.createTexture({
      format: "rgba8unorm",
      width: t.width,
      height: t.height,
      mipLevels: 1,
      data: out,
      sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
    });
    t.painted = k;
  }

  /** The seasons of a year for a tile, asked once. */
  function wantSeasons(t: Tile, idx: number) {
    if (t.seasons.has(idx) || t.asking.has(idx)) return;
    t.asking.add(idx);
    work.decoding++;
    ask<{ px: Uint8Array; a: Uint8Array; b: Uint8Array; unclear: Uint8Array }>({ type: "seasons", px0: t.px0, py0: t.py0, w: t.width, h: t.height, idx, allIdx: ALL_IDX })
      .then(async (r) => {
        const px = new Uint32Array(r.px.buffer, r.px.byteOffset, r.px.byteLength / 4);
        const unclear = new Uint32Array(r.unclear.buffer, r.unclear.byteOffset, r.unclear.byteLength / 4);
        const a = new Float32Array(r.a.buffer, r.a.byteOffset, r.a.byteLength / 4), b = new Float32Array(r.b.buffer, r.b.byteOffset, r.b.byteLength / 4);
        const out = new Uint8Array(t.width * t.height);
        for (const at of unclear) out[at] = 5;
        const parts: Promise<void>[] = [];
        for (let s0 = 0; s0 < px.length; s0 += BATCH) {
          const n = Math.min(BATCH, px.length - s0);
          parts.push(
            decodeBatch(a.slice(s0 * 192, (s0 + n) * 192), b.slice(s0 * 192, (s0 + n) * 192), n).then((codes) => {
              for (let k = 0; k < n; k++) out[px[s0 + k]] = codes[k];
            }),
          );
        }
        await Promise.all(parts);
        return out;
      })
      .then((seasons) => {
        t.seasons.set(idx, seasons);
        t.asking.delete(idx);
        work.decoding--;
        work.decodeDone++;
        seasonWaiters.get(t.key)?.forEach((f) => f());
        seasonWaiters.delete(t.key);
        if (look.src === "ours" && look.year === YEAR_ORIGIN + idx) {
          paint(t);
          version++;
          redraw();
        }
      })
      .catch(() => {
        t.asking.delete(idx);
        work.decoding--;
      });
  }
  const seasonWaiters = new Map<string, (() => void)[]>();

  function setLook(l: Look) {
    if (l.year !== look.year) work.decodeDone = 0;
    look = l;
    for (const t of live.values()) {
      if (l.src === "ours" && l.year != null) wantSeasons(t, l.year - YEAR_ORIGIN);
      paint(t);
    }
    version++;
    redraw();
  }

  /** The layer, reading only the chunks that meet `area` (the view the last read was asked for; a new read is a new
   * `readId`, and the worker's kept scores make the chunks read before quick). */
  let lastRead = -1;
  function layer(opts: { minZoom: number; area: [number, number, number, number]; readId: number; beforeId?: string; visible?: boolean; onTile?: () => void }) {
    const [aW, aS, aE, aN] = opts.area;
    if (opts.readId !== lastRead) {
      lastRead = opts.readId;
      work.readDone = 0;
      areaPx = [Math.floor((aW - X0) / RES), Math.floor((Y0 - aN) / RES), Math.floor((aE - X0) / RES), Math.floor((Y0 - aS) / RES)];
    }
    return new ZarrLayer<zarr.Readable, "int8", Tile>({
      id: `codes-${opts.readId}`,
      extent: opts.area,
      node: arr as AefArray,
      metadata: attrs,
      selection: { time: YEARS.length - 1, band: null },
      getTileData: async (_a, o) => {
        const ys = o.sliceSpec[2] as zarr.Slice, xs = o.sliceSpec[3] as zarr.Slice;
        const py0 = ys.start ?? 0, px0 = xs.start ?? 0;
        const { width, height } = o;
        device = o.device as Device;
        const cW = X0 + px0 * RES, cN = Y0 - py0 * RES, cE = cW + width * RES, cS = cN - height * RES;
        if (cE < aW || cW > aE || cN < aS || cS > aN) {
          // outside the area read: nothing asked of the worker, nothing drawn
          const none = new Uint8Array(width * height);
          return { key: "", px0, py0, width, height, byteLength: 0, ours: none, bits: none, wsf: none, seasons: new Map(), asking: new Set(), tex: null, painted: "" } as Tile;
        }
        work.reading++;
        let r: { ours: Uint8Array; bits: Uint8Array; wsf: Uint8Array };
        try {
          r = await ask<{ ours: Uint8Array; bits: Uint8Array; wsf: Uint8Array }>({ type: "codes", px0, py0, w: width, h: height, allIdx: ALL_IDX }, o.signal);
          work.readDone++;
        } finally {
          work.reading--;
          opts.onTile?.();
        }
        const t: Tile = {
          key: keyOf(Math.floor(py0 / CHUNK), Math.floor(px0 / CHUNK)),
          px0, py0, width, height, byteLength: 7 * width * height,
          ours: r.ours, bits: r.bits, wsf: r.wsf, seasons: new Map(), asking: new Set(), tex: null, painted: "",
        };
        live.set(t.key, t);
        if (look.src === "ours" && look.year != null) wantSeasons(t, look.year - YEAR_ORIGIN);
        paint(t);
        return t;
      },
      renderTile: (d: Tile) => ({ renderPipeline: d.tex ? [{ module: PaintTex, props: { paintTex: d.tex } }] : [] }),
      minZoom: opts.minZoom,
      visible: opts.visible ?? true,
      // a chunk scores every pair of years (nine AlphaEarth reads and TESSERA where AlphaEarth points)
      maxRequests: 6,
      maxCacheSize: 400,
      onTileLoad: () => opts.onTile?.(),
      onViewportLoad: () => opts.onTile?.(),
      onTileUnload: (tile: { content?: Tile | null }) => {
        const t = tile.content;
        if (!t) return;
        t.gone = true;
        if (live.get(t.key) === t) live.delete(t.key);
        t.tex?.destroy();
      },
      updateTriggers: { renderTile: [version] },
      // @ts-expect-error beforeId is read by the MapLibre overlay, not typed on the layer
      beforeId: opts.beforeId,
    });
  }

  /** The chunks under a box on hand, and how many it wants. */
  function loadedIn(bbox: [number, number, number, number]) {
    const [W, S, E, N] = bbox;
    if (E <= W || N <= S) return { loaded: 0, wanted: 0 };
    const c0 = Math.floor((W - X0) / RES / CHUNK), c1 = Math.floor((E - X0) / RES / CHUNK);
    const r0 = Math.floor((Y0 - N) / RES / CHUNK), r1 = Math.floor((Y0 - S) / RES / CHUNK);
    let n = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (live.has(keyOf(r, c))) n++;
    return { loaded: n, wanted: (r1 - r0 + 1) * (c1 - c0 + 1) };
  }

  /** The codes at a mosaic pixel, from the chunk on hand (null where it is not). */
  function at(px: number, py: number) {
    const t = live.get(keyOf(Math.floor(py / CHUNK), Math.floor(px / CHUNK)));
    if (!t) return null;
    const i = (py - t.py0) * t.width + (px - t.px0);
    return { tile: t, ours: t.ours[i], bits: t.bits[i], wsf: t.wsf[i], season: (idx: number) => t.seasons.get(idx)?.[i] };
  }

  /** Waits for a year's seasons on the tiles given (asking for them as needed). */
  function seasonsReady(tiles: Tile[], idx: number): Promise<void> {
    return Promise.all(
      tiles.map(
        (t) =>
          new Promise<void>((ok) => {
            if (t.seasons.has(idx)) return ok();
            const w = seasonWaiters.get(t.key) ?? [];
            w.push(ok);
            seasonWaiters.set(t.key, w);
            wantSeasons(t, idx);
          }),
      ),
    ).then(() => undefined);
  }

  /** For the year opened, the chunks under a box with their quarters in hand, and how many it has. */
  function quartersIn(bbox: [number, number, number, number], year: number) {
    const [W, S, E, N] = bbox, idx = year - YEAR_ORIGIN;
    let done = 0, wanted = 0;
    for (const t of live.values()) {
      const tW = X0 + t.px0 * RES, tN = Y0 - t.py0 * RES, tE = tW + t.width * RES, tS = tN - t.height * RES;
      if (tE < W || tW > E || tN < S || tS > N) continue;
      wanted++;
      if (t.seasons.has(idx)) done++;
    }
    return { done, wanted };
  }

  return { layer, setLook, loadedIn, quartersIn, at, seasonsReady, work: () => ({ ...work }), version: () => version };
}

/** Lon/lat to the mosaic pixel. */
export const pixelOf = (lon: number, lat: number) => [Math.floor((lon - X0) / RES), Math.floor((Y0 - lat) / RES)] as const;
export const pixelCenter = (px: number, py: number) => [X0 + (px + 0.5) * RES, Y0 - (py + 0.5) * RES] as const;
