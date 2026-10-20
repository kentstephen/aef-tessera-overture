import { COGLayer, MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import { DecoderPool, GeoTIFF, PerOriginSemaphore } from "@developmentseed/geotiff";
import GeoTiffWorker from "@developmentseed/geotiff/pool/worker?worker&inline";
import type { Device } from "@luma.gl/core";
import type * as maplibregl from "maplibre-gl";

/**
 * Sentinel-2 true color behind the map, from Earth Genome's yearly mosaics (and their fill mosaics under them, for
 * cloud gaps), as the Earthwork map reads them (aef-earthwork-web's s2.ts and ui.js): the footprints from Earth
 * Genome's STAC search, each footprint's TCI COG read and decoded here (MosaicLayer and COGLayer).
 */
const STAC = "https://stac.earthgenome.org/search";
const YEARLY = "sentinel2-yearly-mosaics";
const FILL = "sentinel2-temporal-mosaics";
export const S2_YEARS = [2022, 2023, 2024, 2025];

type StacFeature = { id: string; collection: string; bbox: [number, number, number, number]; assets: Record<string, { href: string }> };
type Item = { id: string; url: string; bbox: [number, number, number, number]; fill: boolean };

const searches = new Map<string, Promise<StacFeature[]>>();
function search(bbox: number[]): Promise<StacFeature[]> {
  const k = bbox.map((v) => v.toFixed(3)).join(",");
  let p = searches.get(k);
  if (!p) {
    p = fetch(STAC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collections: [YEARLY, FILL], bbox, limit: 200 }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`STAC ${r.status}`))))
      .then((j) => j.features as StacFeature[]);
    p.catch(() => searches.delete(k));
    searches.set(k, p);
  }
  return p;
}

/** The year's footprints under one web mercator tile: yearly first, the fill after them. */
async function items(year: number, z: number, x: number, y: number): Promise<Item[]> {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  const features = await search([lon(x), lat(y + 1), lon(x + 1), lat(y)]);
  const span = `${year}-01-01_${year + 1}-01-01`;
  const yearly: Item[] = [], fill: Item[] = [];
  for (const f of features) {
    if (!f.id.endsWith(span) || !f.assets.TCI || !f.bbox) continue;
    (f.collection === FILL ? fill : yearly).push({ id: f.collection === FILL ? `${f.id}#fill` : f.id, url: f.assets.TCI.href, bbox: f.bbox, fill: f.collection === FILL });
  }
  if (!yearly.length) {
    // the STAC lags the bucket (a year in the bucket the search does not know yet): the same MGRS tile's path with
    // the year swapped; a tile that is not there reads as empty
    const seen = new Set<string>();
    for (const f of features) {
      if (f.collection !== YEARLY || !f.assets.TCI) continue;
      const tile = f.id.split("_")[0];
      if (seen.has(tile)) continue;
      seen.add(tile);
      const id = `${tile}_${span}`;
      const base = f.assets.TCI.href.split("/").slice(0, -2).join("/");
      yearly.push({ id, url: `${base}/${id}/TCI.tif`, bbox: f.bbox, fill: false });
    }
  }
  return [...yearly, ...fill];
}

// nodata (alpha 0) dropped; at a footprint's edge the filtered color is the edge pixel's times the filtered alpha, so
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
  // year -> footprints found, in batches (a batch a STAC answer: its own MosaicLayer, so it shows at once)
  const src = new Map<number, { ids: Set<string>; batches: { key: string; yearly: Item[]; fill: Item[]; bbox: number[] }[] }>();
  const asked = new Set<string>();

  /** Looks for the year's footprints under the view (and half of it again around), once per tile. */
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
        items(year, z, x, y).then(
          (its) => {
            let e = src.get(year);
            if (!e) src.set(year, (e = { ids: new Set(), batches: [] }));
            const bt = { key: k.replace(/\//g, "-"), yearly: [] as Item[], fill: [] as Item[], bbox: [180, 90, -180, -90] };
            for (const it of its) {
              if (e.ids.has(it.id)) continue;
              e.ids.add(it.id);
              (it.fill ? bt.fill : bt.yearly).push(it);
              bt.bbox = [Math.min(bt.bbox[0], it.bbox[0]), Math.min(bt.bbox[1], it.bbox[1]), Math.max(bt.bbox[2], it.bbox[2]), Math.max(bt.bbox[3], it.bbox[3])];
            }
            if (bt.yearly.length || bt.fill.length) {
              e.batches.push(bt);
              onChange();
            }
          },
          () => asked.delete(k),
        );
      }
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

  /** The year's imagery layers (the fill under the yearly), hidden but loading when not `visible`. */
  function layers(year: number, visible: boolean, beforeId: string) {
    poolGet();
    const e = src.get(year);
    if (!e) return [];
    const b = map.getBounds(), dx = (b.getEast() - b.getWest()) / 2, dy = (b.getNorth() - b.getSouth()) / 2;
    const W = b.getWest() - dx, E = b.getEast() + dx, S = b.getSouth() - dy, N = b.getNorth() + dy;
    const live = e.batches.filter((bt) => bt.bbox[0] < E && bt.bbox[2] > W && bt.bbox[1] < N && bt.bbox[3] > S);
    const parts = [...live.filter((bt) => bt.fill.length).map((bt) => [bt, "fill"] as const), ...live.filter((bt) => bt.yearly.length).map((bt) => [bt, "yearly"] as const)];
    return parts.map(
      ([bt, part]) =>
        new MosaicLayer({
          id: `s2-${year}-${bt.key}-${part}`,
          sources: bt[part],
          maxCacheSize: 0,
          minZoom: 7,
          visible,
          beforeId,
          getSource: (s: Item) => tiff(s.url).catch(() => null),
          renderSource: (s: Item, { data, signal }: { data: GeoTIFF | null; signal?: AbortSignal }) =>
            !data
              ? null
              : new COGLayer({
                  id: `s2-${year}-${s.id}`,
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

  return { discover, layers };
}
