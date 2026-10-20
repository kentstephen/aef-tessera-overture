import { COGLayer, MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import { DecoderPool, GeoTIFF, PerOriginSemaphore } from "@developmentseed/geotiff";
import GeoTiffWorker from "@developmentseed/geotiff/pool/worker?worker&inline";
import type { Device } from "@luma.gl/core";
import type * as maplibregl from "maplibre-gl";

/**
 * Sentinel-2 true color behind the map, from single Sentinel-2 L2A scenes found through Element 84's Earth Search
 * (AWS Open Data's sentinel-cogs bucket: open to the browser, no keys), as deckgl-raster-mapterhorn-s2 finds them
 * (its earthSearchStac.ts). Each scene's TCI COG is read and decoded here (MosaicLayer and COGLayer).
 *
 * A year shows, for each MGRS tile, the latest scene of that year with almost no cloud and no missing pixels (the
 * ground as it stood by the year's end), and under it the tile's next clearest scenes, which fill an orbit's edge or a
 * cloud hole. `next` steps a year to another look: each tile's next earlier clear scene, round again after the last.
 * Every year the model reads, 2017 to 2025.
 */
const STAC = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-2-l2a";
export const S2_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
/** a scene is clear under this much cloud, and whole under this much missing, in percent */
const CLEAR = 1, WHOLE = 1;
/** scenes under the top one of a tile, to fill its gaps */
const UNDER = 2;
/** the most scenes a tile keeps to step through */
const KEEP = 12;

type Feature = {
  id: string;
  bbox: [number, number, number, number];
  assets: Record<string, { href?: string }>;
  properties: { datetime?: string; "eo:cloud_cover"?: number; "s2:nodata_pixel_percentage"?: number; "grid:code"?: string };
};
type Item = { id: string; url: string; bbox: [number, number, number, number]; date: string; tile: string; score: number };
/** A tile's scenes in the order the looks step through them: the clear, whole ones latest first, then the rest. */
type Tile = { tile: string; ranked: Item[]; bbox: [number, number, number, number] };

const searches = new Map<string, Promise<Feature[]>>();
function search(year: number, bbox: number[]): Promise<Feature[]> {
  const k = year + ":" + bbox.map((v) => v.toFixed(3)).join(",");
  let p = searches.get(k);
  if (!p) {
    p = fetch(STAC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collections: [COLLECTION],
        bbox,
        datetime: `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`,
        query: { "eo:cloud_cover": { lt: 30 } },
        // Earth Search caps a page at 100; the clearest first
        limit: 100,
        sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Earth Search ${r.status}`))))
      .then((j) => j.features as Feature[]);
    p.catch(() => searches.delete(k));
    searches.set(k, p);
  }
  return p;
}

/** the MGRS tile a scene belongs to ("12SUC") */
const tileOf = (f: Feature) => f.properties["grid:code"]?.replace(/^MGRS-/, "") ?? /_(\d{1,2}[A-Z]{3})_/.exec(f.id)?.[1] ?? f.bbox.map((v) => v.toFixed(1)).join(",");

/** The year's scenes under one web mercator tile, by MGRS tile, ranked. */
async function tilesUnder(year: number, z: number, x: number, y: number): Promise<Tile[]> {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  const features = await search(year, [lon(x), lat(y + 1), lon(x + 1), lat(y)]);
  const byTile = new Map<string, Feature[]>();
  for (const f of features) {
    if (!f.assets.visual?.href || !f.bbox) continue;
    const t = tileOf(f);
    byTile.set(t, [...(byTile.get(t) ?? []), f]);
  }
  const out: Tile[] = [];
  const cloud = (f: Feature) => f.properties["eo:cloud_cover"] ?? 100;
  const missing = (f: Feature) => f.properties["s2:nodata_pixel_percentage"] ?? 100;
  const date = (f: Feature) => (f.properties.datetime ?? "").slice(0, 10);
  for (const [tile, fs] of byTile) {
    const item = (f: Feature): Item => ({ id: f.id, url: f.assets.visual.href!, bbox: f.bbox, date: date(f), tile, score: cloud(f) + missing(f) });
    // the clear, whole scenes, latest first; where a tile has none, the rest by cloud and missing together
    const good = fs.filter((f) => cloud(f) < CLEAR && missing(f) < WHOLE).sort((a, b) => (date(a) < date(b) ? 1 : -1));
    const rest = fs.filter((f) => !good.includes(f)).sort((a, b) => cloud(a) + missing(a) - cloud(b) - missing(b));
    const ranked = [...good, ...rest].slice(0, KEEP).map(item);
    const bbox = ranked.reduce((b, it) => [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] as [number, number, number, number], [180, 90, -180, -90] as [number, number, number, number]);
    out.push({ tile, ranked, bbox });
  }
  return out;
}

// nodata (alpha 0) dropped; at a scene's edge the filtered color is the edge pixel's times the filtered alpha, so
// dividing by alpha gives the pixel back with no dark fringe
const S2Look = {
  name: "s2Look",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
  if (color.a < 0.5) discard;
  color = vec4(color.rgb / color.a, 1.0);
`,
  },
};

export function createS2(map: maplibregl.Map, onChange: () => void) {
  let pool: DecoderPool | null = null;
  const poolGet = () => pool || (pool = new DecoderPool({ size: Math.min(6, navigator.hardwareConcurrency || 4), createWorker: () => new GeoTiffWorker() }));
  const limiter = new PerOriginSemaphore({ maxRequests: 16 });
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
  // year -> the MGRS tiles found and their ranked scenes, in batches (a batch a search's answer: its own MosaicLayers,
  // so it shows at once). A tile is taken once a year: a later search that meets it again leaves it be
  const src = new Map<number, { tiles: Map<string, Tile>; batches: { key: string; tiles: Tile[]; bbox: number[] }[] }>();
  const asked = new Set<string>();
  // year -> how many looks it has stepped (N)
  const looks = new Map<number, number>();
  /** A tile's scene on top in the year's look, and the clearest of its other days under it (cloudiest first). */
  function pick(year: number, t: Tile) {
    const top = t.ranked[(looks.get(year) ?? 0) % t.ranked.length];
    const under = t.ranked.filter((it) => it !== top && it.date !== top.date).sort((a, b) => a.score - b.score).slice(0, UNDER).reverse();
    return { top, under };
  }
  /** The year's next look: each tile's next scene. */
  function next(year: number) {
    looks.set(year, (looks.get(year) ?? 0) + 1);
  }

  /** Looks for the year's scenes under the view (and half of it again around), once per tile. */
  function discover(year: number) {
    const z = Math.max(7, Math.min(9, Math.floor(map.getZoom()))), n = 2 ** z;
    const b = map.getBounds(), dx = (b.getEast() - b.getWest()) / 2, dy = (b.getNorth() - b.getSouth()) / 2;
    const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const ty = (lat: number) => {
      const v = Math.sin((lat * Math.PI) / 180);
      return Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + v) / (1 - v)) / (4 * Math.PI)) * n)));
    };
    const x0 = tx(b.getWest() - dx), x1 = tx(b.getEast() + dx), y0 = ty(Math.min(85, b.getNorth() + dy)), y1 = ty(Math.max(-85, b.getSouth() - dy));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${year}/${z}/${x}/${y}`;
        if (asked.has(k)) continue;
        asked.add(k);
        tilesUnder(year, z, x, y).then(
          (ts) => {
            let e = src.get(year);
            if (!e) src.set(year, (e = { tiles: new Map(), batches: [] }));
            const fresh = ts.filter((t) => t.ranked.length && !e.tiles.has(t.tile));
            if (!fresh.length) return;
            fresh.forEach((t) => e.tiles.set(t.tile, t));
            const bbox = fresh.reduce((b, t) => [Math.min(b[0], t.bbox[0]), Math.min(b[1], t.bbox[1]), Math.max(b[2], t.bbox[2]), Math.max(b[3], t.bbox[3])], [180, 90, -180, -90]);
            e.batches.push({ key: k.replace(/\//g, "-"), tiles: fresh, bbox });
            onChange();
          },
          () => asked.delete(k),
        );
      }
  }

  /** The day of the year's top scene under a point, or "" before one is found. */
  function dateAt(year: number, lon: number, lat: number) {
    const e = src.get(year);
    let d = "";
    for (const bt of e?.batches ?? [])
      for (const t of bt.tiles) {
        const it = pick(year, t).top;
        if (it.bbox[0] <= lon && lon <= it.bbox[2] && it.bbox[1] <= lat && lat <= it.bbox[3]) d = it.date;
      }
    return d;
  }

  async function tileData(image: { fetchTile: (x: number, y: number, o: unknown) => Promise<{ array: { width: number; height: number; data: Uint8Array } }> }, o: { device: Device; x: number; y: number; signal?: AbortSignal; pool?: unknown }) {
    const { array } = await image.fetchTile(o.x, o.y, { boundless: false, pool: o.pool, signal: o.signal });
    const { width, height, data } = array, px = width * height;
    // TCI's black is nodata: alpha 0 there
    let rgba = data;
    if (data.length === 3 * px) {
      rgba = new Uint8Array(4 * px);
      for (let i = 0; i < px; i++) {
        const r = data[3 * i], g = data[3 * i + 1], b = data[3 * i + 2];
        rgba[4 * i] = r;
        rgba[4 * i + 1] = g;
        rgba[4 * i + 2] = b;
        rgba[4 * i + 3] = r || g || b ? 255 : 0;
      }
    }
    return { texture: o.device.createTexture({ data: rgba, format: "rgba8unorm", width, height, sampler: { magFilter: "linear", minFilter: "linear" } }), width, height };
  }

  /** The year's imagery layers (the fill under the top scenes), hidden but loading when not `visible`. `tag` keeps
   * the ids of a second map's layers apart. */
  function layers(year: number, visible: boolean, beforeId?: string, tag = "") {
    poolGet();
    const e = src.get(year);
    if (!e) return [];
    const b = map.getBounds(), dx = (b.getEast() - b.getWest()) / 2, dy = (b.getNorth() - b.getSouth()) / 2;
    const W = b.getWest() - dx, E = b.getEast() + dx, S = b.getSouth() - dy, N = b.getNorth() + dy;
    const live = e.batches.filter((bt) => bt.bbox[0] < E && bt.bbox[2] > W && bt.bbox[1] < N && bt.bbox[3] > S);
    const look = looks.get(year) ?? 0;
    const parts = live.flatMap((bt) => {
      const picks = bt.tiles.map((t) => pick(year, t));
      const fill = picks.flatMap((p) => p.under), yearly = picks.map((p) => p.top);
      return [...(fill.length ? [[bt.key, "fill", fill] as const] : []), [bt.key, "yearly", yearly] as const];
    });
    // the fill under every batch's top scenes
    parts.sort((a, b) => (a[1] === b[1] ? 0 : a[1] === "fill" ? -1 : 1));
    return parts.map(
      ([key, part, sources]) =>
        new MosaicLayer({
          id: `s2${tag}-${year}-${look}-${key}-${part}`,
          sources,
          maxCacheSize: 0,
          minZoom: 7,
          visible,
          beforeId,
          getSource: (s: Item) => tiff(s.url).catch(() => null),
          renderSource: (s: Item, { data, signal }: { data: GeoTIFF | null; signal?: AbortSignal }) =>
            !data
              ? null
              : new COGLayer({
                  id: `s2${tag}-${year}-${s.id}`,
                  geotiff: data,
                  getTileData: (img: never, o: never) => tileData(img, o),
                  pool: pool!,
                  signal,
                  refinementStrategy: "best-available",
                  maxRequests: 16,
                  renderTile: (d: { texture: unknown }) => ({ renderPipeline: [{ module: CreateTexture, props: { textureName: d.texture } }, { module: S2Look, props: {} }] }),
                } as never),
        } as never),
    );
  }

  return { discover, layers, dateAt, next };
}
