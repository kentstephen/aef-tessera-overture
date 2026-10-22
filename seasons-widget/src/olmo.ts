import * as zarr from "zarrita";

import { fromS3, RES, X0, Y0, YEAR_ORIGIN } from "./aef";
import { DiskCachedStore } from "./disk-cache";
import { toUtm, zoneOf } from "./utm";

/**
 * OlmoEarth v1.3 (Ai2) on Source Cooperative: one Zarr v3 group per UTM zone, 10 m, 128 int8 bands per calendar
 * year (2017 to 2025), sharded 2048 px with 256 x 256 inner chunks of 64 bands. The first 64 bands are a complete
 * embedding on their own and sit in their own chunks, so only they are read: as many bytes as AlphaEarth's.
 * Quantized as AlphaEarth is ((q / 127.5)^2 * sign(q)), -128 where no embedding was made (2017 to 2022 cover only
 * some countries so far).
 */
export const OLMO_URL = "https://data.source.coop/olmoearth/olmoearth-v1-3-embeddings/embeddings.zarr";
export const OLMO_BANDS = 64;
const PX = 10;
/** The inner chunk: 256 x 256 pixels, 64 bands. A block is read whole and kept, since neighboring AlphaEarth chunks
 * fall on the same blocks. */
const BLOCK = 256;
/** Blocks kept decoded (4 MB each). */
const KEEP = 48;

type Zone = { x0: number; y0: number; rows: number; cols: number; emb: zarr.Array<"int8", zarr.Readable>; tIdx: Map<number, number> };

const zones = new Map<number, Promise<Zone | null>>();
function openZone(zone: number): Promise<Zone | null> {
  let p = zones.get(zone);
  if (!p) {
    p = (async () => {
      const url = `${OLMO_URL}/utm${String(zone).padStart(2, "0")}`;
      // read from S3 over its three host names in turn (a browser keeps six connections a host, and TESSERA uses
      // the same three), kept on disk under the gateway's URL (as TESSERA)
      const hosts = ["s3.us-west-2", "s3-us-west-2", "s3.dualstack.us-west-2"].map((h) => new zarr.FetchStore(fromS3(url).replace("s3.us-west-2", h)));
      let turn = 0;
      const store = new DiskCachedStore(url, {
        get: (key, opts) => hosts[0].get(key, opts),
        getRange: (key, range, opts) => hosts[turn++ % hosts.length].getRange(key, range, opts),
      });
      const root = await zarr.open.v3(store, { kind: "group" });
      const tr = root.attrs["spatial:transform"] as number[];
      const emb = await zarr.open.v3(root.resolve("embeddings"), { kind: "array" });
      if (!emb.is("int8")) throw new Error(`OlmoEarth zone ${zone}: unexpected data type`);
      const time = await zarr.open.v3(root.resolve("time"), { kind: "array" });
      const ys = (await zarr.get(time)).data as Int32Array;
      // AlphaEarth's year index (year - 2017) to this store's time index
      const tIdx = new Map<number, number>();
      ys.forEach((y, i) => tIdx.set(y - YEAR_ORIGIN, i));
      const [, , rows, cols] = emb.shape;
      return { x0: tr[2], y0: tr[5], rows, cols, emb, tIdx };
    })();
    p.catch(() => zones.delete(zone));
    zones.set(zone, p);
  }
  return p;
}

// decoded blocks, the last used last; a read is shared and never let go by one chunk's signal (the next chunk wants it)
const blocks = new Map<string, Promise<{ d: Int8Array; h: number; w: number } | null>>();
function block(zn: Zone, zone: number, t: number, br: number, bc: number) {
  const k = `${zone}:${t}:${br}:${bc}`;
  let p = blocks.get(k);
  if (p) {
    blocks.delete(k);
    blocks.set(k, p);
    return p;
  }
  const y0 = br * BLOCK, x0 = bc * BLOCK;
  const y1 = Math.min(zn.rows, y0 + BLOCK), x1 = Math.min(zn.cols, x0 + BLOCK);
  p = zarr
    .get(zn.emb, [t, zarr.slice(0, OLMO_BANDS), zarr.slice(y0, y1), zarr.slice(x0, x1)])
    .then((got) => ({ d: got.data as Int8Array, h: y1 - y0, w: x1 - x0 }));
  p.catch(() => blocks.get(k) === p && blocks.delete(k));
  blocks.set(k, p);
  while (blocks.size > KEEP) blocks.delete(blocks.keys().next().value as string);
  return p;
}

/** OlmoEarth on one AlphaEarth chunk's pixels, both years: int8 [band, y, x] the chunk's own size, and `ok` where
 * both years have an embedding. */
export type OlmoChunk = { first: Int8Array; last: Int8Array; ok: Uint8Array };

/**
 * OlmoEarth at each pixel center of the AlphaEarth chunk at (px0, py0), w x h: the OlmoEarth pixel holding the center,
 * in the UTM zone of the pixel's own longitude (as TESSERA is read).
 */
export async function olmoOnChunk(px0: number, py0: number, w: number, h: number, firstIdx: number, lastIdx: number): Promise<OlmoChunk> {
  const plane = w * h;
  const first = new Int8Array(OLMO_BANDS * plane).fill(-128);
  const last = new Int8Array(OLMO_BANDS * plane).fill(-128);
  const ok = new Uint8Array(plane);
  const byZone = new Map<number, [number, number]>();
  for (let i = 0; i < w; i++) {
    const z = zoneOf(X0 + (px0 + i + 0.5) * RES);
    const span = byZone.get(z);
    if (span) span[1] = i + 1;
    else byZone.set(z, [i, i + 1]);
  }
  await Promise.all(
    [...byZone].map(async ([zone, [i0, i1]]) => {
      const zn = await openZone(zone);
      if (!zn) return;
      const tF = zn.tIdx.get(firstIdx), tL = zn.tIdx.get(lastIdx);
      if (tF == null || tL == null) return;
      const en = new Float64Array(2);
      // each pixel's block and place in it
      const n = (i1 - i0) * h;
      const bk = new Array<string>(n), at = new Int32Array(n).fill(-1), dst = new Int32Array(n);
      const want = new Map<string, [number, number]>();
      for (let j = 0, k = 0; j < h; j++) {
        const lat = Y0 - (py0 + j + 0.5) * RES;
        for (let i = i0; i < i1; i++, k++) {
          dst[k] = j * w + i;
          toUtm(X0 + (px0 + i + 0.5) * RES, lat, zone, en);
          const r = Math.floor((zn.y0 - en[1]) / PX), c = Math.floor((en[0] - zn.x0) / PX);
          if (r < 0 || c < 0 || r >= zn.rows || c >= zn.cols) continue;
          const br = Math.floor(r / BLOCK), bc = Math.floor(c / BLOCK);
          const key = `${br}:${bc}`;
          bk[k] = key;
          at[k] = (r - br * BLOCK) * BLOCK + (c - bc * BLOCK);
          want.set(key, [br, bc]);
        }
      }
      const got = new Map<string, [Awaited<ReturnType<typeof block>>, Awaited<ReturnType<typeof block>>]>();
      await Promise.all(
        [...want].map(async ([key, [br, bc]]) => {
          got.set(key, await Promise.all([block(zn, zone, tF, br, bc), block(zn, zone, tL, br, bc)]));
        }),
      );
      for (let k = 0; k < n; k++) {
        if (at[k] < 0) continue;
        const pair = got.get(bk[k]);
        if (!pair || !pair[0] || !pair[1]) continue;
        const [bF, bL] = pair as [{ d: Int8Array; h: number; w: number }, { d: Int8Array; h: number; w: number }];
        // the block's own size (smaller at the zone's edge)
        const r = Math.floor(at[k] / BLOCK), c = at[k] % BLOCK;
        if (r >= bF.h || c >= bF.w) continue;
        const s = r * bF.w + c, sp = bF.h * bF.w, o = dst[k];
        if (bF.d[s] === -128 || bL.d[s] === -128) continue;
        for (let b = 0; b < OLMO_BANDS; b++) {
          first[b * plane + o] = bF.d[b * sp + s];
          last[b * plane + o] = bL.d[b * sp + s];
        }
        ok[o] = 1;
      }
    }),
  );
  return { first, last, ok };
}
