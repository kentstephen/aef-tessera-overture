import type { GetTileDataOptions } from "@developmentseed/deck.gl-geotiff";
import type { RasterModule, RenderTileResult } from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Sentinel-2's precomposed true color (the TCI COG) drawn as deckgl-raster-mapterhorn-s2 draws it, copied from its
 * getTileData.ts, renderTile.ts, discardBlack.ts and shaders/scaleColor.ts: the tile read (retried), uploaded, its
 * black nodata fill dropped, and a uniform gain on the finished color (1.0 = the TCI as it is).
 */

async function fetchTileWithRetry(image: GeoTIFF | Overview, x: number, y: number, signal: AbortSignal | undefined, attempts = 3) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await image.fetchTile(x, y, { signal, boundless: false });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * 2 ** i + Math.random() * 150));
    }
  }
  throw lastErr;
}

export type S2TileData = { width: number; height: number; texture: Texture };

export async function getTileData(image: GeoTIFF | Overview, options: GetTileDataOptions, filter: "nearest" | "linear" = "nearest"): Promise<S2TileData> {
  const { device, x, y, signal } = options;
  const tile = await fetchTileWithRetry(image, x, y, signal);
  const { array } = tile;
  const { width, height } = array;
  if (array.layout === "band-separate") throw new Error("Sentinel-2 TCI expected pixel-interleaved");
  const src = array.data;
  if (!(src instanceof Uint8Array)) throw new Error(`expected Uint8Array, got ${src?.constructor?.name}`);
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = src[i * 3];
    rgba[i * 4 + 1] = src[i * 3 + 1];
    rgba[i * 4 + 2] = src[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const texture = device.createTexture({
    data: rgba,
    format: "rgba8unorm",
    width,
    height,
    sampler: { minFilter: filter, magFilter: filter, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
  });
  return { width, height, texture };
}

export const discardBlack = {
  name: "discard-black",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.01) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

const SCALE = "scaleColor";
/** The final RGB times a scalar: under 1 darkens, over 1 brightens (clipped to 1). Alpha left alone. */
export const ScaleColor = {
  name: SCALE,
  fs: `\
uniform ${SCALE}Uniforms {
  float factor;
} ${SCALE};
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color.rgb = color.rgb * ${SCALE}.factor;
    `,
  },
  uniformTypes: { factor: "f32" },
  getUniforms: (props: { factor?: number }) => ({ factor: props.factor ?? 1.0 }),
} as const satisfies ShaderModule<{ factor: number }>;

export function renderTile(tileData: S2TileData, gain = 1.0): RenderTileResult {
  const renderPipeline: RasterModule[] = [
    { module: CreateTexture, props: { textureName: tileData.texture } },
    { module: discardBlack },
    { module: ScaleColor, props: { factor: gain } },
  ];
  return { renderPipeline };
}
