import { COGLayer, MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { DecoderPool, GeoTIFF, PerOriginSemaphore } from "@developmentseed/geotiff";
import GeoTiffWorker from "@developmentseed/geotiff/pool/worker?worker&inline";
import type * as maplibregl from "maplibre-gl";
import { getTileData, renderTile, type S2TileData } from "./s2-shaders";

/**
 * Sentinel-2 behind the map: one clear L2A pass a year, found through Element 84's Earth Search (AWS Open Data's
 * sentinel-cogs bucket: open to the browser, no keys).
 *
 * A year shows a single acquisition (one datatake: the MGRS tiles of one pass, all the same day), never a stack of
 * days, so what is on screen is one image and blinking between years compares two images, nothing else.
 *
 * The pass is chosen for the view, not for its whole 110 km tile: each candidate's scene classification (the SCL
 * band) is read at a coarse overview over the view, and a pass is taken only when it covers the view with almost no
 * cloud, cloud shadow, cirrus or snow there. Before that, by metadata: the hemisphere's winter months are skipped
 * (December to February north of the tropics, June to August south of them, none inside them) and so are scenes
 * under a low sun.
 *
 * The chosen pass stays while the view stays near where it was chosen; when the view leaves, the same pass is checked
 * again over the new view and kept if it is still clear there. The image is drawn as it is: the precomposed true
 * color (TCI) at gain 1.0, only its black nodata fill dropped (s2-shaders.ts). No cloud masking, no blending.
 *
 * `next` steps a year to its next clear pass. Every year the model reads, 2017 to 2025.
 */
const STAC = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-2-l2a";
export const S2_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
/** scene-wide cloud the search lets through: loose, since the view's own cloud is what decides */
const MAX_SCENE_CLOUD = 70;
/** under this sun the scene is dark, its shadows long */
const MIN_SUN = 15;
/** the share of the view a pass must have data over */
const MIN_COVER = 0.97;
/** the share of the view's pixels allowed to be cloud, shadow, cirrus or snow */
const MAX_BAD = 0.02;
/** sample points across the view, per side */
const GRID = 48;
/** passes checked at once, and at most per look for one */
const BATCH = 3;
const MAX_CHECKED = 24;
/** years whose layers stay loaded (hidden) besides the one shown, so blinking back is instant */
const WARM = 3;

/** SCL classes counted against a pass: defective, cloud shadow, cloud medium and high, cirrus, snow */
const BAD = new Set([1, 3, 8, 9, 10, 11]);

type Feature = {
  id: string;
  bbox: [number, number, number, number];
  assets: Record<string, { href?: string }>;
  properties: Record<string, unknown>;
};
type Scene = { id: string; bbox: [number, number, number, number]; tile: string; url: string; scl: string; epsg: number };
/** One acquisition: its MGRS tiles over the view, all one day. */
type Pass = { key: string; date: string; cloud: number; scenes: Scene[] };
type Rated = Pass & { cover: number; bad: number };
type BBox = [number, number, number, number];

type YearState = {
  /** the view the passes were checked over, and the area around it the choice holds for */
  view: BBox;
  hold: BBox;
  /** clear passes found, in the order found; `look` indexes the one shown */
  clear: Rated[];
  look: number;
  /** passes not checked yet, clearest by metadata first */
  queue: Pass[];
  /** the best rated so far, shown when no pass is clear */
  best: Rated | null;
  /** the pass shown before this view's was chosen: it stays on screen until then */
  prev: Rated | null;
  busy: boolean;
  done: boolean;
};

const MONTH_WINTER_N = new Set([12, 1, 2]);
const MONTH_WINTER_S = new Set([6, 7, 8]);

/** WGS84 to UTM (Krüger's series, sub-millimeter within a zone). */
function utm(lon: number, lat: number, zone: number, south: boolean): [number, number] {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const al = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const phi = (lat * Math.PI) / 180, lam = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const e = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + k0 * A * E, (south ? 1e7 : 0) + k0 * A * N];
}

const inside = (a: BBox, b: BBox) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];

/** The year's candidate passes over a box, clearest by metadata first, the hemisphere's winter and low suns left out. */
async function passes(year: number, box: BBox): Promise<Pass[]> {
  const r = await fetch(STAC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collections: [COLLECTION],
      bbox: box,
      datetime: `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`,
      query: { "eo:cloud_cover": { lt: MAX_SCENE_CLOUD } },
      // Earth Search caps a page at 100 (over it answers 502); the clearest first
      limit: 100,
      sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
    }),
  });
  if (!r.ok) throw new Error(`Earth Search ${r.status}`);
  const features = (await r.json()).features as Feature[];
  const lat = (box[1] + box[3]) / 2;
  const winter = lat > 23.5 ? MONTH_WINTER_N : lat < -23.5 ? MONTH_WINTER_S : null;
  const byPass = new Map<string, Pass>();
  for (const f of features) {
    const p = f.properties;
    const date = String(p.datetime ?? "").slice(0, 10);
    const url = f.assets.visual?.href ?? f.assets.TCI?.href;
    const scl = f.assets.scl?.href ?? f.assets.SCL?.href;
    const epsg = Number(p["proj:epsg"]);
    if (!url || !scl || !f.bbox || !date || !epsg) continue;
    if (winter?.has(+date.slice(5, 7))) continue;
    if (typeof p["view:sun_elevation"] === "number" && p["view:sun_elevation"] < MIN_SUN) continue;
    const tile = String(p["grid:code"] ?? f.id).replace(/^MGRS-/, "");
    // a pass is its datatake (one platform, one day, one orbit); its baseline suffix dropped, so a scene processed
    // twice is still the one pass
    const key = String(p["s2:datatake_id"] ?? `${p.platform}_${date}`).replace(/_N\d\d\.\d\d$/, "");
    const cloud = Number(p["eo:cloud_cover"] ?? 100);
    let ps = byPass.get(key);
    if (!ps) byPass.set(key, (ps = { key, date, cloud, scenes: [] }));
    ps.cloud = Math.max(ps.cloud, cloud);
    // the answer is clearest first: a tile's first scene is kept, a reprocessed copy of it is not
    if (!ps.scenes.some((s) => s.tile === tile)) ps.scenes.push({ id: f.id, bbox: f.bbox, tile, url, scl, epsg });
  }
  return [...byPass.values()].sort((a, b) => a.cloud - b.cloud);
}

export function createS2(map: maplibregl.Map, onChange: () => void) {
  let pool: DecoderPool | null = null;
  const poolGet = () => pool || (pool = new DecoderPool({ size: Math.min(6, navigator.hardwareConcurrency || 4), createWorker: () => new GeoTiffWorker() }));
  const limiter = new PerOriginSemaphore({ maxRequests: 16 });
  // each GeoTIFF opened once, kept for the session (a failed open is let go, to be asked again)
  const tiffs = new Map<string, Promise<GeoTIFF>>();
  const tiff = (url: string) => {
    let p = tiffs.get(url);
    if (!p) {
      p = GeoTIFF.fromUrl(url, { concurrencyLimiter: limiter } as never);
      tiffs.set(url, p);
      p.catch(() => tiffs.get(url) === p && tiffs.delete(url));
    }
    return p;
  };

  const years = new Map<number, YearState>();
  /** years asked for lately, the latest last: their layers stay loaded */
  const recent: number[] = [];

  const viewBox = (): BBox => {
    const b = map.getBounds();
    return [b.getWest(), Math.max(-85, b.getSouth()), b.getEast(), Math.min(85, b.getNorth())];
  };
  const grow = (v: BBox, k: number): BBox => {
    const dx = (v[2] - v[0]) * k, dy = (v[3] - v[1]) * k;
    return [v[0] - dx, v[1] - dy, v[2] + dx, v[3] + dy];
  };

  /** A scene's SCL class at each of the points (lon, lat pairs), 0 where it has no data. */
  async function classes(s: Scene, pts: Float64Array, span: number): Promise<Uint8Array> {
    const g = await tiff(s.scl);
    const zone = s.epsg % 100, south = Math.floor(s.epsg / 100) === 327;
    const n = pts.length / 2;
    const xy = new Float64Array(pts.length);
    for (let i = 0; i < n; i++) {
      const [x, y] = utm(pts[2 * i], pts[2 * i + 1], zone, south);
      xy[2 * i] = x;
      xy[2 * i + 1] = y;
    }
    // the coarsest level that still has a pixel or two between sample points, and needs few tiles
    const levels = [g, ...g.overviews].sort((a, b) => b.transform[0] - a.transform[0]);
    const step = span / GRID;
    let lvl = levels.find((l) => l.transform[0] <= step / 2) ?? levels[levels.length - 1];
    const tilesOf = (l: typeof lvl) => {
      const [a, , c, , e, f] = l.transform;
      const need = new Map<string, [number, number]>();
      for (let i = 0; i < n; i++) {
        const col = Math.floor((xy[2 * i] - c) / a), row = Math.floor((xy[2 * i + 1] - f) / e);
        if (col < 0 || row < 0 || col >= l.width || row >= l.height) continue;
        const tx = Math.floor(col / l.tileWidth), ty = Math.floor(row / l.tileHeight);
        need.set(tx + "," + ty, [tx, ty]);
      }
      return need;
    };
    let need = tilesOf(lvl);
    // too many tiles: a coarser level instead
    while (need.size > 12 && levels.indexOf(lvl) > 0) {
      lvl = levels[levels.indexOf(lvl) - 1];
      need = tilesOf(lvl);
    }
    const tiles = new Map<string, { w: number; data: ArrayLike<number> }>();
    await Promise.all(
      [...need].map(async ([k, [tx, ty]]) => {
        const t = await lvl.fetchTile(tx, ty, { pool: poolGet(), boundless: true });
        const arr = t.array;
        tiles.set(k, { w: arr.width, data: arr.layout === "band-separate" ? arr.bands[0] : arr.data });
      }),
    );
    const out = new Uint8Array(n);
    const [a, , c, , e, f] = lvl.transform;
    for (let i = 0; i < n; i++) {
      const col = Math.floor((xy[2 * i] - c) / a), row = Math.floor((xy[2 * i + 1] - f) / e);
      if (col < 0 || row < 0 || col >= lvl.width || row >= lvl.height) continue;
      const tx = Math.floor(col / lvl.tileWidth), ty = Math.floor(row / lvl.tileHeight);
      const t = tiles.get(tx + "," + ty);
      if (t) out[i] = t.data[(row - ty * lvl.tileHeight) * t.w + (col - tx * lvl.tileWidth)];
    }
    return out;
  }

  /** How much of the view a pass covers, and how much of what it covers is cloud, shadow, cirrus or snow. */
  async function rate(p: Pass, v: BBox): Promise<Rated> {
    const pts = new Float64Array(GRID * GRID * 2);
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        pts[2 * (j * GRID + i)] = v[0] + ((i + 0.5) / GRID) * (v[2] - v[0]);
        pts[2 * (j * GRID + i) + 1] = v[1] + ((j + 0.5) / GRID) * (v[3] - v[1]);
      }
    // the view's width in meters, for the sampling level
    const midLat = ((v[1] + v[3]) / 2) * (Math.PI / 180);
    const span = Math.max((v[2] - v[0]) * 111320 * Math.cos(midLat), (v[3] - v[1]) * 110540);
    const over = p.scenes.filter((s) => s.bbox[0] < v[2] && s.bbox[2] > v[0] && s.bbox[1] < v[3] && s.bbox[3] > v[1]);
    const per = await Promise.all(over.map((s) => classes(s, pts, span).catch(() => new Uint8Array(GRID * GRID))));
    let cov = 0, bad = 0;
    for (let i = 0; i < GRID * GRID; i++) {
      // the pass's tiles overlap with the same pixels: any one with data answers
      let c = 0;
      for (const cl of per) if (cl[i]) { c = cl[i]; break; }
      if (!c) continue;
      cov++;
      if (BAD.has(c)) bad++;
    }
    return { ...p, cover: cov / (GRID * GRID), bad: cov ? bad / cov : 1 };
  }
  const isClear = (r: Rated) => r.cover >= MIN_COVER && r.bad <= MAX_BAD;

  /** Checks the year's queue a few passes at a time until it has `want` clear passes, or runs out. */
  async function fill(year: number, s: YearState, want: number) {
    if (s.busy) return;
    s.busy = true;
    let checked = 0;
    try {
      while (s.clear.length < want && s.queue.length && checked < MAX_CHECKED && years.get(year) === s) {
        const batch = s.queue.splice(0, BATCH);
        checked += batch.length;
        const rated = await Promise.all(batch.map((p) => rate(p, s.view)));
        if (years.get(year) !== s) return;
        for (const r of rated) if (!s.best || r.cover - r.bad > s.best.cover - s.best.bad) s.best = r;
        // within a batch the least cloudy first, so the one shown is the best of those checked together
        const ok = rated.filter(isClear).sort((a, b) => a.bad - b.bad);
        if (ok.length) {
          const had = s.clear.length;
          s.clear.push(...ok);
          if (!had) onChange();
        }
      }
      if (!s.queue.length || checked >= MAX_CHECKED) s.done = true;
      if (!s.clear.length) onChange();
    } finally {
      s.busy = false;
    }
  }

  /** The year's pass for the view: kept while the view stays near where it was chosen, else checked again. */
  async function choose(year: number) {
    const v = viewBox();
    if (v[2] - v[0] > 4 || v[3] - v[1] > 4) return;
    const old = years.get(year);
    if (old && inside(v, old.hold)) return;
    const shown = old ? shownOf(old) : null;
    const s: YearState = { view: v, hold: grow(v, 0.25), clear: [], look: 0, queue: [], best: null, prev: shown, busy: false, done: false };
    // the pass on screen checked first over the new view: if it is still clear there, it stays
    if (shown) {
      const r = await rate(shown, v).catch(() => null);
      if (r && isClear(r)) {
        s.clear.push(r);
        years.set(year, s);
        passes(year, s.hold).then((ps) => (s.queue = ps.filter((p) => p.key !== shown.key)), () => {});
        onChange();
        return;
      }
    }
    years.set(year, s);
    try {
      s.queue = await passes(year, s.hold);
    } catch {
      years.delete(year);
      return;
    }
    await fill(year, s, 1);
  }
  const shownOf = (s: YearState): Rated | null => (s.clear.length ? s.clear[s.look % s.clear.length] : s.done ? s.best : s.prev);

  let chain: Promise<void> = Promise.resolve();
  /** Finds the year's pass for the view, then every other year's after it, one year at a time. */
  function discover(year: number) {
    const i = recent.indexOf(year);
    if (i >= 0) recent.splice(i, 1);
    recent.push(year);
    choose(year).then(() => {
      chain = chain.then(async () => {
        for (const y of S2_YEARS) if (y !== year) await choose(y).catch(() => {});
      });
    });
  }

  /** The year's next clear pass (another is looked for when none is left). */
  function next(year: number) {
    const s = years.get(year);
    if (!s) return;
    if (s.look + 1 < s.clear.length) s.look++;
    else if (!s.done && s.queue.length)
      fill(year, s, s.clear.length + 1).then(() => {
        if (s.look + 1 < s.clear.length) s.look++;
        else s.look = 0;
        onChange();
      });
    else s.look = 0;
  }

  /** The day of the year's pass, or "" before one is chosen. */
  function dateAt(year: number, _lon?: number, _lat?: number) {
    const s = years.get(year);
    return (s && shownOf(s)?.date) || "";
  }
  /** "finding", "clear", or "cloudy" (no clear pass: the least cloudy shown). */
  function status(year: number): "finding" | "clear" | "cloudy" {
    const s = years.get(year);
    if (!s || (!s.clear.length && !s.done)) return "finding";
    return s.clear.length ? "clear" : "cloudy";
  }

  function layerOf(year: number, p: Rated, visible: boolean, beforeId: string | undefined, tag: string) {
    return new MosaicLayer({
      id: `s2${tag}-${year}-${p.key}`,
      sources: p.scenes,
      maxCacheSize: 0,
      minZoom: 7,
      visible,
      beforeId,
      getSource: (s: Scene) => tiff(s.url).catch(() => null),
      renderSource: (s: Scene, { data, signal }: { data: GeoTIFF | null; signal?: AbortSignal }) =>
        !data
          ? null
          : new COGLayer({
              id: `s2${tag}-${year}-${s.id}`,
              geotiff: data,
              getTileData: (img: never, o: never) => getTileData(img, o),
              renderTile: (d: S2TileData) => renderTile(d, 1.0),
              pool: pool!,
              signal,
              refinementStrategy: "best-available",
              maxRequests: 16,
            } as never),
    } as never);
  }

  /**
   * The year's imagery (hidden but loading when not `visible`), with the last few years asked for kept loaded and
   * hidden beside it. `tag` keeps a second map's layer ids apart.
   */
  function layers(year: number, visible: boolean, beforeId?: string, tag = "") {
    poolGet();
    const ys = [...recent.filter((y) => y !== year).slice(-WARM), year];
    const out = [];
    for (const y of ys) {
      const s = years.get(y), p = s && shownOf(s);
      if (p) out.push(layerOf(y, p, visible && y === year, beforeId, tag));
    }
    return out;
  }

  /** The years given chosen for the view now, side by side, ahead of the rest (each kept if already chosen near here). */
  function want(ys: number[]) {
    for (const y of ys) choose(y).catch(() => {});
  }

  /** The year's pass alone, shown (none until it is chosen). `tag` keeps another map's layer ids apart. */
  function layerFor(year: number, tag: string) {
    poolGet();
    const s = years.get(year), p = s && shownOf(s);
    return p ? [layerOf(year, p, true, undefined, tag)] : [];
  }

  return { discover, layers, layerFor, want, dateAt, status, next };
}
