import { SimpleMeshLayer } from "@deck.gl/mesh-layers";

/**
 * deck.gl-raster's MeshTextureLayer (every raster tile: AlphaEarth, the year map, the Sentinel-2 COGs) replaces
 * SimpleMeshLayer's fragment shader with its own, which reads its textures from its own modules and declares no
 * `sampler`. SimpleMeshLayer still binds its mesh texture as `sampler`, so luma.gl warns that the binding is not in
 * the shader layout (deck.gl-raster 0.8.1, deck.gl 9.4). The texture was never read: it is left out for that layer
 * only, so a binding warning in the console means a real one.
 */
type TextureProps = Record<string, unknown>;
const proto = SimpleMeshLayer.prototype as unknown as { getTextureProps: (t: unknown) => TextureProps };
const getTextureProps = proto.getTextureProps;
proto.getTextureProps = function (this: { constructor: { layerName?: string } }, texture: unknown) {
  const props = getTextureProps.call(this, texture);
  if (this.constructor.layerName !== "mesh-texture-layer") return props;
  const { sampler: _unused, ...rest } = props;
  return rest;
};
