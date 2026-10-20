import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * The cloud-masked true color of single Sentinel-2 L2A scenes, as deckgl-raster-mapterhorn-s2 draws it (its
 * shaders/trueColor.ts, shaders/sclCloudMask.ts and discardBlack.ts): B04, B03, B02 in r, g, b and the Scene
 * Classification Layer in alpha (MultiCOGLayer's composite), stretched, then cloud, shadow and nodata dropped so the
 * clearer scene stacked beneath shows through.
 */

/** A pixel any of whose three bands is the layer's zero padding (a band still loading, or off the scene) is dropped. */
export const DiscardIncompleteBands = {
  name: "discard-incomplete-bands",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r < 0.00005 || color.g < 0.00005 || color.b < 0.00005) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

const STRETCH = "trueColorStretch";
/**
 * The raw bands are r16unorm, and Earth Search's L2A stores (reflectance + 0.1) x 1e4 in every year (its raster:bands
 * scale 0.0001, offset -0.1), so reflectance 0 reads 1000 / 65535 = 0.0153. The stretch runs from reflectance 0 to
 * 0.28 (0.058), where dry ground, roofs and roads sit (the mapterhorn app's 0.16 tops out near 0.95, for Denali's
 * snow); then a mild gamma.
 */
export const CLEAR_RANGE: [number, number] = [0.0153, 0.058];
export const TrueColorStretch = {
  name: STRETCH,
  fs: `\
uniform ${STRETCH}Uniforms {
  float rescaleMin;
  float rescaleMax;
} ${STRETCH};
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float trueColorStretch_span = max(${STRETCH}.rescaleMax - ${STRETCH}.rescaleMin, 1e-5);
      vec3 trueColorStretch_lin = clamp((color.rgb - vec3(${STRETCH}.rescaleMin)) / trueColorStretch_span, 0.0, 1.0);
      color.rgb = pow(trueColorStretch_lin, vec3(0.85));
    `,
  },
  uniformTypes: { rescaleMin: "f32", rescaleMax: "f32" },
  getUniforms: (props: { rescaleMin?: number; rescaleMax?: number }) => ({
    rescaleMin: props.rescaleMin ?? CLEAR_RANGE[0],
    rescaleMax: props.rescaleMax ?? CLEAR_RANGE[1],
  }),
} as const satisfies ShaderModule<{ rescaleMin: number; rescaleMax: number }>;

/**
 * SCL in alpha (class = alpha x 255): no data (0), saturated (1), cloud shadow (3), cloud (8, 9) and cirrus (10)
 * dropped; snow (11) kept. The pixels kept are made opaque.
 */
export const SclCloudMask = {
  name: "scl-cloud-mask",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      int sclCloudMask_class = int(floor(color.a * 255.0 + 0.5));
      if (sclCloudMask_class == 0 || sclCloudMask_class == 1 || sclCloudMask_class == 3 ||
          sclCloudMask_class == 8 || sclCloudMask_class == 9 || sclCloudMask_class == 10) {
        discard;
      }
      color.a = 1.0;
    `,
  },
} as const satisfies ShaderModule;

/** The order matters: the stretch runs on rgb before the mask reads alpha. */
export const CLEAR_PIPELINE = [
  { module: DiscardIncompleteBands },
  { module: TrueColorStretch, props: { rescaleMin: CLEAR_RANGE[0], rescaleMax: CLEAR_RANGE[1] } },
  { module: SclCloudMask },
];
