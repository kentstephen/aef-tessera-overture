import { COGLayer, MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { DecoderPool, GeoTIFF, PerOriginSemaphore } from "@developmentseed/geotiff";
import GeoTiffWorker from "@developmentseed/geotiff/pool/worker?worker&inline";
import type * as maplibregl from "maplibre-gl";
import { getTileData, renderTile, type S2TileData } from "./s2-shaders";

/**
 * Sentinel-2 behind the map from single L2A scenes found through Element 84's Earth Search (AWS Open Data's
 * sentinel-cogs bucket: open to the browser, no keys), found, chosen and drawn as deckgl-raster-mapterhorn-s2 does
 * (its earthSearchStac.ts and its cloud-masked true color in App.tsx):
 * - the year's candidates under 30% cloud, clearest first;
 * - coverage first: every MGRS tile keeps up to PER_TILE scenes on different days, its clearest drawn last, on top;
 * - each scene's precomposed true color (TCI) drawn as that app draws it (s2-shaders.ts: gain 1.0, the TCI as it
 *   is), its black nodata dropped so the scene beneath fills an orbit's edge.
 * `next` steps a year's look: each tile's next scene goes on top. Every year the model reads, 2017 to 2025.
 */
const STAC = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-2-l2a";
export const S2_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const MAX_CLOUD = 30;
/** scenes a tile keeps, on different days: the one on top and those under it */
const PER_TILE = 4;

type Feature = {
  id: string;
  bbox: [number, number, number, number];
  assets: Record<string, { href?: string }>;
  properties: { datetime?: string; "eo:cloud_cover"?: number; "grid:code"?: string };
};
type Scene = { id: string; bbox: [number, number, number, number]; date: string; cloud: number; tile: string; url: string };
/** A tile's scenes, clearest first. */
type Tile = { tile: string; scenes: Scene[]; bbox: [number, number, number, number] };

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
        query: { "eo:cloud_cover": { lt: MAX_CLOUD } },
        // Earth Search caps a page at 100 (over it answers 502); the clearest first
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

/** the MGRS tile a scene belongs to ("12SUC"): its grid code, else the one in its id */
const tileOf = (f: Feature) => f.properties["grid:code"]?.replace(/^MGRS-/, "") ?? /_T?(\d{1,2}[A-Z]{3})_/.exec(f.id)?.[1] ?? f.bbox.map((v) => v.toFixed(1)).join(",");

/** The year's scenes under one web mercator tile, by MGRS tile: up to PER_TILE a tile on different days, clearest first. */
async function tilesUnder(year: number, z: number, x: number, y: number): Promise<Tile[]> {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  const features = await search(year, [lon(x), lat(y + 1), lon(x + 1), lat(y)]);
  const byTile = new Map<string, Scene[]>();
  for (const f of features) {
    const url = f.assets.visual?.href ?? f.assets.TCI?.href;
    if (!url || !f.bbox) continue;
    const s: Scene = { id: f.id, bbox: f.bbox, date: (f.properties.datetime ?? "").slice(0, 10), cloud: f.properties["eo:cloud_cover"] ?? 100, tile: tileOf(f), url };
    const kept = byTile.get(s.tile) ?? [];
    // the answer is clearest first: the first PER_TILE days of each tile, never the same pass twice
    if (kept.length < PER_TILE && !kept.some((k) => k.date === s.date)) kept.push(s);
    byTile.set(s.tile, kept);
  }
  return [...byTile].map(([tile, scenes]) => ({
    tile,
    scenes,
    bbox: scenes.reduce((bb, s) => [Math.min(bb[0], s.bbox[0]), Math.min(bb[1], s.bbox[1]), Math.max(bb[2], s.bbox[2]), Math.max(bb[3], s.bbox[3])] as [number, number, number, number], [180, 90, -180, -90] as [number, number, number, number]),
  }));
}

export function createS2(map: maplibregl.Map, onChange: () => void) {
  let pool: DecoderPool | null = null;
  const poolGet = () => pool || (pool = new DecoderPool({ size: Math.min(6, navigator.hardwareConcurrency || 4), createWorker: () => new GeoTiffWorker() }));
  const limiter = new PerOriginSemaphore({ maxRequests: 16 });
  // each scene's GeoTIFF opened once, kept for the session (a failed open is let go, to be asked again)
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
  // year -> the MGRS tiles found and their scenes, in batches (a batch a search's answer: its own MosaicLayer, so it
  // shows at once). A tile is taken once a year: a later search that meets it again leaves it be
  const src = new Map<number, { tiles: Map<string, Tile>; batches: { key: string; tiles: Tile[]; bbox: number[] }[] }>();
  const asked = new Set<string>();
  // year -> how many looks it has stepped (N)
  const looks = new Map<number, number>();

  /** A tile's scenes in drawing order: the cloudiest first, the look's scene last, on top. */
  function stack(year: number, t: Tile) {
    const top = t.scenes[(looks.get(year) ?? 0) % t.scenes.length];
    return [...t.scenes.filter((s) => s !== top).sort((a, b) => b.cloud - a.cloud), top];
  }
  /** The year's next look: each tile's next scene on top. */
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
            const fresh = ts.filter((t) => t.scenes.length && !e.tiles.has(t.tile));
            if (!fresh.length) return;
            fresh.forEach((t) => e.tiles.set(t.tile, t));
            const bbox = fresh.reduce((bb, t) => [Math.min(bb[0], t.bbox[0]), Math.min(bb[1], t.bbox[1]), Math.max(bb[2], t.bbox[2]), Math.max(bb[3], t.bbox[3])], [180, 90, -180, -90]);
            e.batches.push({ key: k.replace(/\//g, "-"), tiles: fresh, bbox });
            onChange();
          },
          () => asked.delete(k),
        );
      }
  }

  /** The day of the year's top scene under a point, or "" before one is found. */
  function dateAt(year: number, lon: number, lat: number) {
    let d = "";
    for (const bt of src.get(year)?.batches ?? [])
      for (const t of bt.tiles) {
        const s = stack(year, t).at(-1)!;
        if (s.bbox[0] <= lon && lon <= s.bbox[2] && s.bbox[1] <= lat && lat <= s.bbox[3]) d = s.date;
      }
    return d;
  }

  /** The year's imagery layers, hidden but loading when not `visible`. `tag` keeps a second map's layer ids apart. */
  function layers(year: number, visible: boolean, beforeId?: string, tag = "") {
    poolGet();
    const e = src.get(year);
    if (!e) return [];
    const b = map.getBounds(), dx = (b.getEast() - b.getWest()) / 2, dy = (b.getNorth() - b.getSouth()) / 2;
    const W = b.getWest() - dx, E = b.getEast() + dx, S = b.getSouth() - dy, N = b.getNorth() + dy;
    const look = looks.get(year) ?? 0;
    return e.batches
      .filter((bt) => bt.bbox[0] < E && bt.bbox[2] > W && bt.bbox[1] < N && bt.bbox[3] > S)
      .map((bt) => {
        // a mosaic draws its sources in order: every tile's under scenes (cloudiest first), then the tops
        const stacks = bt.tiles.map((t) => stack(year, t));
        const sources = [...stacks.flatMap((s) => s.slice(0, -1)).sort((a, c) => c.cloud - a.cloud), ...stacks.map((s) => s.at(-1)!)];
        return new MosaicLayer({
          id: `s2${tag}-${year}-${look}-${bt.key}`,
          sources,
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
      });
  }

  return { discover, layers, dateAt, next };
}
