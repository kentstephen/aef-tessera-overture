import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Device, Texture } from "@luma.gl/core";
import * as zarr from "zarrita";

import { DiskCachedStore } from "./disk-cache";

/** The AlphaEarth Foundations GeoZarr mosaic on Source Cooperative. */
export const ZARR_URL = "https://data.source.coop/tge-labs/aef-mosaic";

/**
 * The same bytes as a data.source.coop URL, straight from the S3 bucket behind it (open, CORS for any origin). The
 * gateway can throttle many requests at once; the bucket does not. Disk cache keys stay on the gateway URL, so what
 * is kept under it still reads.
 */
export const fromS3 = (url: string) =>
  url.replace("https://data.source.coop/", "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/");
export const VARIABLE = "embeddings";
export const NUM_BANDS = 64;
export const YEAR_ORIGIN = 2017;
export const YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

/**
 * The mosaic is one level at about 10 m with no overviews, so every zoom step
 * out reads about four times the chunks. Two years per tile at zoom 12 is
 * the most this reads per view.
 */
export const MIN_ZOOM = 12;

/** The mosaic's grid (EPSG:4326, pixel registered) and its chunk size. */
export const RES = 8.983111749910169e-5;
export const X0 = -180;
export const Y0 = 83.68570533713473;
export const CHUNK = 256;

export type AefArray = zarr.Array<"int8", zarr.Readable>;

/** One spatial chunk, both years of the window. */
export type PairTileData = MinimalTileData & {
  firstTex: Texture;
  lastTex: Texture;
  /** The raw int8 [band, y, x] chunks, kept for the card's worker. */
  first: Int8Array;
  last: Int8Array;
};

export async function openMosaic(): Promise<{ arr: AefArray; attrs: unknown }> {
  // its chunks kept on disk between visits (disk-cache.ts)
  const store = new DiskCachedStore(ZARR_URL, new zarr.FetchStore(ZARR_URL));
  const root = await zarr.open.v3(store, { kind: "group" });
  const arr = await zarr.open.v3(root.resolve(VARIABLE), { kind: "array" });
  if (!arr.is("int8")) {
    throw new Error(`Expected int8 embeddings, got ${arr.dtype}`);
  }
  return { arr, attrs: root.attrs };
}

export function bandTexture(device: Device, data: Int8Array, width: number, height: number, depth = NUM_BANDS): Texture {
  // zarrita's [band, y, x] row-major layout is the Texture2DArray's
  // layer-major storage, so the chunk uploads as is
  return device.createTexture({
    dimension: "2d-array",
    format: "r8sint",
    width,
    height,
    depth,
    mipLevels: 1,
    data,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });
}

/**
 * Read the tile's chunk for both years of the window. The layer's selection
 * pins `time` to the first year; the last year is the same slice with the
 * time index swapped.
 */
export function makeGetTileData(firstIdx: number, lastIdx: number, onDevice: (device: Device) => void) {
  return async function getTileData(arr: AefArray, options: GetTileDataOptions): Promise<PairTileData> {
    const { device, sliceSpec, width, height, signal } = options;
    onDevice(device);
    const lastSpec = [...sliceSpec];
    lastSpec[0] = lastIdx;
    const firstSpec = [...sliceSpec];
    firstSpec[0] = firstIdx;
    const [f, l] = await Promise.all([
      zarr.get(arr, firstSpec, { signal }),
      zarr.get(arr, lastSpec, { signal }),
    ]);
    for (const c of [f, l]) {
      if (c.shape.length !== 3 || c.shape[0] !== NUM_BANDS || c.shape[1] !== height || c.shape[2] !== width) {
        throw new Error(`Unexpected chunk shape [${c.shape.join(", ")}] for a ${width} x ${height} tile`);
      }
    }
    const first = f.data as Int8Array;
    const last = l.data as Int8Array;
    return {
      firstTex: bandTexture(device, first, width, height),
      lastTex: bandTexture(device, last, width, height),
      first,
      last,
      width,
      height,
      byteLength: first.byteLength + last.byteLength,
    };
  };
}
