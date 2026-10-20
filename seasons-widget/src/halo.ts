import { Layer, picking, project32, type UpdateParameters } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type * as arrow from "apache-arrow";

/**
 * A fading buffer around every footprint, so the raster eases out toward a building on an even, geometric edge
 * instead of stopping on the 10 m pixels' staircase.
 *
 * Each footprint gets one square: its bounding box grown by HALO_M on every side. The fragment shader reads the
 * footprint's ring from a float texture and works out, for each screen pixel, whether it is inside the ring and how
 * far it is from the nearest edge. Inside is left alone (the fill drawn over it, or nothing for a footprint with no
 * year); outside, the basemap's background color is laid on, solid at the edge and clear at HALO_M. The distance is
 * exact, so the sides and the corners fade alike, at any footprint size.
 *
 * Drawn over our raster and under the basemap's roads, so it dims the ground near a building and not the streets.
 */

/** how far out from a footprint's edge the ground is dimmed, in meters */
export const HALO_M = 30;
/** the dark-matter basemap's background */
const HALO_RGB = [14, 14, 14].map((c) => (c / 255).toFixed(4)).join(", ");
/** the most vertices a footprint's ring is walked for */
const MAX_VERTS = 4096;
/** the vertex texture's width */
const TEX_W = 4096;

// deck.gl's common space: 512 units around the world, y growing north
const WORLD = 512;
const EARTH_M = 40075016.686;
const commonX = (lon: number) => (lon * WORLD) / 360;
const commonY = (lat: number) => (WORLD / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** The footprints laid out for the shader: a square and a run of vertices each, offsets in common units. */
type HaloData = {
  length: number;
  /** each footprint's bounding-box center, lon, lat */
  center: Float64Array;
  /** each square's half width and half height, the buffer included */
  extent: Float32Array;
  /** each footprint's first vertex in the texture and its count; the reach of its buffer */
  verts: Float32Array;
  /** the vertices, x y, from their footprint's center */
  xy: Float32Array;
  height: number;
};

const cache = new WeakMap<arrow.RecordBatch, HaloData>();

function haloData(batch: arrow.RecordBatch): HaloData {
  const hit = cache.get(batch);
  if (hit) return hit;
  const poly = batch.getChild("geometry")!.data[0];
  const ring = poly.children[0];
  const geomOff = poly.valueOffsets as Int32Array;
  const ringOff = ring.valueOffsets as Int32Array;
  const coords = ring.children[0].children[0].values as Float64Array;
  const n = poly.length, base = poly.offset;
  const center = new Float64Array(2 * n);
  const extent = new Float32Array(2 * n);
  const verts = new Float32Array(3 * n);
  // the exterior ring of each row; its closing vertex (a repeat of the first) left out
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = geomOff[base + i];
    total += Math.max(0, ringOff[r + 1] - ringOff[r] - 1);
  }
  const height = Math.max(1, Math.ceil(total / TEX_W));
  const xy = new Float32Array(2 * TEX_W * height);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const r = geomOff[base + i], k0 = ringOff[r];
    const k1 = Math.min(ringOff[r + 1] - 1, k0 + MAX_VERTS);
    let W = Infinity, E = -Infinity, S = Infinity, N = -Infinity;
    for (let k = k0; k < k1; k++) {
      const x = coords[2 * k], y = coords[2 * k + 1];
      if (x < W) W = x;
      if (x > E) E = x;
      if (y < S) S = y;
      if (y > N) N = y;
    }
    if (k1 <= k0) continue;
    const lon = (W + E) / 2, lat = (S + N) / 2;
    const cx = commonX(lon), cy = commonY(lat);
    // the buffer in common units at this footprint's latitude
    const reach = (HALO_M * WORLD) / (EARTH_M * Math.cos((lat * Math.PI) / 180));
    center[2 * i] = lon;
    center[2 * i + 1] = lat;
    extent[2 * i] = (commonX(E) - commonX(W)) / 2 + reach * 1.02;
    extent[2 * i + 1] = (commonY(N) - commonY(S)) / 2 + reach * 1.02;
    verts[3 * i] = at;
    verts[3 * i + 1] = k1 - k0;
    verts[3 * i + 2] = reach;
    for (let k = k0; k < k1; k++, at++) {
      xy[2 * at] = commonX(coords[2 * k]) - cx;
      xy[2 * at + 1] = commonY(coords[2 * k + 1]) - cy;
    }
  }
  const d = { length: n, center, extent, verts, xy, height };
  cache.set(batch, d);
  return d;
}

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME foot-halo-vertex-shader
in vec3 positions;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in vec2 instanceExtent;
in vec3 instanceVerts;
out vec2 vLocal;
flat out vec3 vVerts;
void main(void) {
  geometry.worldPosition = instancePositions;
  geometry.uv = positions.xy;
  vLocal = positions.xy * instanceExtent;
  vVerts = instanceVerts;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, vec3(vLocal, 0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME foot-halo-fragment-shader
precision highp float;
precision highp int;
uniform highp sampler2D haloVerts;
in vec2 vLocal;
flat in vec3 vVerts;
out vec4 fragColor;
vec2 haloVertex(int i) {
  return texelFetch(haloVerts, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0).xy;
}
void main(void) {
  int s = int(vVerts.x), n = int(vVerts.y);
  float reach = vVerts.z;
  float d = 1e20;
  bool inside = false;
  vec2 p = vLocal;
  vec2 a = haloVertex(s + n - 1);
  for (int k = 0; k < ${MAX_VERTS}; k++) {
    if (k >= n) break;
    vec2 b = haloVertex(s + k);
    vec2 e = b - a, w = p - a;
    float t = clamp(dot(w, e) / max(dot(e, e), 1e-30), 0.0, 1.0);
    d = min(d, length(w - e * t));
    // even-odd: does the edge cross the ray running east from p
    if ((a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) * e.x / e.y) inside = !inside;
    a = b;
  }
  if (inside || d >= reach) discard;
  fragColor = vec4(${HALO_RGB}, 1.0 - smoothstep(0.0, 1.0, d / reach));
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

type HaloProps = { data: HaloData };

class FootHaloLayer extends Layer<HaloProps> {
  static layerName = "FootHaloLayer";
  declare state: { model?: Model; tex?: Texture };

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, picking] });
  }

  initializeState() {
    this.getAttributeManager()!.addInstanced({
      instancePositions: {
        size: 3,
        type: "float64",
        fp64: this.use64bitPositions(),
        accessor: "getPosition",
      },
      instanceExtent: { size: 2, accessor: "getExtent" },
      instanceVerts: { size: 3, accessor: "getVerts" },
    });
  }

  updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged || !this.state.model) {
      this.state.model?.destroy();
      this.state.model = new Model(this.context.device, {
        ...this.getShaders(),
        id: this.props.id,
        bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
        geometry: new Geometry({
          topology: "triangle-strip",
          attributes: { positions: { size: 3, value: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]) } },
        }),
        isInstanced: true,
      });
      this.getAttributeManager()!.invalidateAll();
    }
    if (params.changeFlags.dataChanged || !this.state.tex) {
      const d = this.props.data;
      this.state.tex?.destroy();
      this.state.tex = this.context.device.createTexture({
        format: "rg32float",
        width: TEX_W,
        height: d.height,
        mipLevels: 1,
        data: d.xy,
        sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
      });
    }
  }

  finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
    super.finalizeState(context);
    this.state.tex?.destroy();
  }

  draw() {
    const { model, tex } = this.state;
    if (!model || !tex) return;
    model.setBindings({ haloVerts: tex });
    model.draw(this.context.renderPass!);
  }
}

export function haloLayer(footBatch: arrow.RecordBatch, opts: { visible: boolean; beforeId: string }) {
  const d = haloData(footBatch);
  return new FootHaloLayer({
    id: "foot-halo",
    data: d,
    // the accessors read the laid-out arrays by row
    getPosition: (_: unknown, { index }: { index: number }) => [d.center[2 * index], d.center[2 * index + 1], 0],
    getExtent: (_: unknown, { index }: { index: number }) => [d.extent[2 * index], d.extent[2 * index + 1]],
    getVerts: (_: unknown, { index }: { index: number }) => [d.verts[3 * index], d.verts[3 * index + 1], d.verts[3 * index + 2]],
    visible: opts.visible,
    pickable: false,
    // read by the MapLibre overlay
    beforeId: opts.beforeId,
  } as never);
}
