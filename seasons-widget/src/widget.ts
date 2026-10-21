import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import "./mesh-sampler";

import { MapLibreOverlay as MapboxOverlay } from "@deck.gl/maplibre";
import { COORDINATE_SYSTEM, LayerExtension } from "@deck.gl/core";
import { MaskExtension } from "@deck.gl/extensions";
import { BitmapLayer, LineLayer, PathLayer } from "@deck.gl/layers";
import * as maplibregl from "maplibre-gl";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";

import { MIN_ZOOM, RES, X0, Y0 } from "./aef";
import { createCodesLayer, pixelOf } from "./codes-layer";
import decoderBin from "./decoder_month.bin?url";
import { createS2, type Rated, S2_YEARS } from "./es-s2";
import { extentRuns, FIRST_YEAR, outerOutline, outerShape, type Patch, patchesIn } from "./patch";
import decoderMeta from "./decoder_month.json";
import type { WorldModel } from "./earthwork-cpu";
import world from "./earthwork_world.json";
import widgetCss from "./widget.css?inline";

type Model = {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
  save_changes(): void;
  on(ev: string, f: () => void): void;
};

// the patches' outlines: light orchid, solid. A hue Sentinel-2's ground rarely takes, and light: with protanopia it
// reads as a pale lavender, apart from the greens, browns and grays of the imagery
const ORCHID: [number, number, number, number] = [240, 165, 255, 255];
// the outline's colors, C steps through them: each reads with protanopia; cyan is a hue sand, clay and soil never take,
// the blue and the violet are darker than bright desert
const LINE_COLS: { name: string; rgb: [number, number, number, number] }[] = [
  { name: "orchid", rgb: ORCHID },
  { name: "cyan", rgb: [0, 229, 255, 255] },
  { name: "electric blue", rgb: [47, 107, 255, 255] },
  { name: "deep violet", rgb: [122, 60, 255, 255] },
];
let lineCol = 0;
const lineRgb = () => LINE_COLS[lineCol].rgb;
// from this zoom the view reads by itself once the map settles; below it nothing is read
const AUTO_Z = MIN_ZOOM;
// the panels come no closer than this (aef-tessera-earthwork's spotlight flies to a patch no closer either): Sentinel-2's
// 10 m pixels stay small, not blocks; a bigger patch is framed farther out
const PANEL_MAX_Z = 14.2;
const FIT_CLS = "sm-fit-on";
// the panels' maps: no basemap, the imagery alone on a dark ground
const BLANK = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0e0e0e" } }] } as maplibregl.StyleSpecification;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- the spotlight, as aef-tessera-earthwork's year map dims around a patch (its ui.js on the year-map branch:
// SpotExtension, DiscardClear, SpotMaskLayer, copied): deck.gl's mask extension with the patch's pixels as the mask, the
// imagery outside it darkened (or grayed, J) in place of dropped, inside it as it is
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MASK_MOD = (MaskExtension.prototype as any).getShaders.call({ getAttributeManager: () => ({ attributes: {} }), props: {}, state: {} }).modules[0];
const { "fs:#main-start": _maskDiscard, ...maskInject } = MASK_MOD.inject;
const SPOT_FILL = { name: "spotFill", fs: "layout(std140) uniform spotFillUniforms {\n  float k;\n  float gray;\n} spotFill;\n", uniformTypes: { k: "f32", gray: "f32" } };
const SPOT_MOD = {
  ...MASK_MOD,
  inject: {
    ...maskInject,
    "fs:#main-end": `
  if (mask.enabled && spotFill.k > 0.0 && !mask_isInBounds(mask_texCoords)) {
    float l = dot(fragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 o = mix(fragColor.rgb * 0.3, vec3(l) * 0.8, spotFill.gray);
    fragColor.rgb = mix(fragColor.rgb, o, spotFill.k);
  }
`,
  },
};
/** around the patch: darkened (false) or gray (true); and how far (1: to 30% of its brightness, 0: not at all), D steps it */
const spot = { gray: false, k: 0.5 };
const SPOT_STEPS = [0.5, 0.25, 0, 1];
class SpotExtension extends MaskExtension {
  getShaders() {
    (this as unknown as { state: { maskByInstance: boolean } }).state.maskByInstance = false;
    return { modules: [SPOT_MOD, SPOT_FILL] };
  }
  // called with the layer as `this`, as every extension's draw
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(this: any, ...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MaskExtension.prototype.draw as any).apply(this, args);
    this.setShaderModuleProps({ spotFill: { k: spot.k, gray: spot.gray ? 1 : 0 } });
  }
}
SpotExtension.extensionName = "SpotExtension";
const SPOT = new SpotExtension();
/** around every patch on the map: how dim (0 not at all, 0.5 half), D toggles it */
const mapSpot = { k: 0 };
class MapSpotExtension extends SpotExtension {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(this: any, ...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MaskExtension.prototype.draw as any).apply(this, args);
    this.setShaderModuleProps({ spotFill: { k: mapSpot.k, gray: 0 } });
  }
}
MapSpotExtension.extensionName = "MapSpotExtension";
const MAP_SPOT = new MapSpotExtension();
// the reveal: the latest year drawn only inside the patches (deck.gl's mask extension, the patches' extents the mask)
const REVEAL = new MaskExtension();
// the mask: a bitmap of the patch's pixels, its clear pixels dropped so only the patch counts
class DiscardClear extends LayerExtension {
  getShaders() {
    return { inject: { "fs:DECKGL_FILTER_COLOR": "if (color.a < 0.5) discard;" } };
  }
}
DiscardClear.extensionName = "DiscardClear";
const DISCARD_CLEAR = new DiscardClear();
// a BitmapLayer gives deck no bounds (its positions are not kept), so its mask was never drawn: its own bounds here
class SpotMaskLayer extends BitmapLayer {
  getBounds() {
    const [w, s, e, n] = this.props.bounds as number[];
    return [[w, s], [e, n]] as [number[], number[]];
  }
}
SpotMaskLayer.layerName = "SpotMaskLayer";

// maplibre's worker from the bundle itself, as a blob: the widget is one file with nothing beside it
maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([maplibreWorker], { type: "text/javascript" })));

function render({ model, el }: { model: Model; el: HTMLElement }) {
  const cfg = JSON.parse(String(model.get("config") || "{}")) as { home: { lon: number; lat: number; zoom: number } };
  // the styles: maplibre's and the widget's, in the page and in the widget's own root if it has one
  for (const host of new Set<Node>([document.head, el.getRootNode()])) {
    const target = host instanceof ShadowRoot ? host : document.head;
    if (target.querySelector?.("#sm-styles")) continue;
    const s = document.createElement("style");
    s.id = "sm-styles";
    s.textContent = maplibreCss + "\n" + widgetCss;
    target.appendChild(s);
  }
  if (!document.getElementById("sm-fonts")) {
    const f = document.createElement("link");
    f.id = "sm-fonts";
    f.rel = "stylesheet";
    f.href = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap";
    document.head.appendChild(f);
  }
  // filling the window: the notebook's own buttons and outlines out of the way
  if (!document.getElementById("sm-fit-style")) {
    const s = document.createElement("style");
    s.id = "sm-fit-style";
    s.textContent =
      ["notebook-actions-dropdown", "cell-actions-button", "drag-button", "expand-output-button", "fullscreen-output-button", "chrome-sidebar", "chrome-footer", "chrome-controls-top-right", "chrome-controls-bottom-right"]
        .map((t) => `html.${FIT_CLS} [data-testid='${t}']`)
        .join(",") + `{display:none!important}html.${FIT_CLS}{overflow:hidden}html.${FIT_CLS} *:focus,html.${FIT_CLS} *:focus-visible,html.${FIT_CLS} *:focus-within{outline:none!important;box-shadow:none!important}`;
    document.head.appendChild(s);
  }

  const st = { fit: true, area: null as [number, number, number, number] | null, readId: 0, s2Year: S2_YEARS[0], open: null as Patch | null, lines: true, panelLines: true, reveal: false };
  // the reveal (R): the map in st.s2Year (2017 to start), and inside every patch in view this year instead
  const REVEAL_YEAR = S2_YEARS[S2_YEARS.length - 1];
  const E = (t: string, c?: string, h?: string) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (h != null) e.innerHTML = h;
    return e;
  };
  const root = E("div", "sm"), mapEl = E("div", "map");
  const load = E("div", "load", "<i></i>"), loadTag = E("div", "loadtag glass");
  root.append(mapEl, load, loadTag);
  el.appendChild(root);
  const toast = E("div", "toast glass");
  // top left, as in aef-earthwork-web: the search, and under it the Sentinel-2 card
  const top = E("div", "top");
  const sBox = E("div", "search glass", '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>');
  const q = E("input") as HTMLInputElement, hits = E("div", "hits");
  q.type = "search";
  q.placeholder = "Search";
  q.title = "a place (/)";
  q.autocomplete = "off";
  q.spellcheck = false;
  sBox.append(q, E("kbd", "", "/"), hits);
  const s2Card = E("div", "s2card glass showing");
  top.append(sBox, s2Card);
  // the panels: the clicked patch in 2017 and 2025, side by side over the whole window; a click anywhere goes back
  const tri = E("div", "tri");
  const panels = [0, 1, 2].map(() => {
    const p = E("div", "pan"), m = E("div", "pm"), l = E("div", "pl");
    p.append(m, l);
    tri.appendChild(p);
    // pass: a given pass (the dug panel's pick), else the year's pass shown; wait: its pick still being made
    return { el: p, mapEl: m, label: l, map: null as maplibregl.Map | null, overlay: null as InstanceType<typeof MapboxOverlay> | null, year: 0, role: "", pass: null as Rated | null, wait: false };
  });
  const back = E("div", "back glass");
  tri.appendChild(back);
  root.append(top, tri, toast);
  let toastT = 0;
  const note = (t: string) => {
    toast.textContent = t;
    toast.classList.add("on");
    clearTimeout(toastT);
    toastT = window.setTimeout(() => toast.classList.remove("on"), 1600);
  };

  // ---- the map
  const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  const map = new maplibregl.Map({
    container: mapEl,
    style: STYLE,
    center: [cfg.home.lon, cfg.home.lat],
    zoom: cfg.home.zoom,
    hash: true,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false,
    canvasContextAttributes: { antialias: true },
    // room for the 4x export (K); maplibre's own cap is 4096. Past this the export comes out smaller (its name says)
    maxCanvasSize: [8192, 8192],
  });
  // the credits folded into their i until it is clicked (maplibre opens a compact one on a wide map)
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "AlphaEarth Foundations, Google DeepMind (CC BY 4.0) · TESSERA v1.1, University of Cambridge · Sentinel-2: Copernicus, via Element 84 Earth Search",
    }),
    "bottom-right",
  );
  const foldCredits = () => root.querySelectorAll(".maplibregl-ctrl-attrib.maplibregl-compact-show").forEach((e) => e.classList.remove("maplibregl-compact-show"));
  map.once("load", foldCredits);
  map.once("idle", foldCredits);
  map.keyboard.disable();
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);

  const resizeAll = () => {
    try {
      map.resize();
      for (const p of panels) p.map?.resize();
    } catch {
      // the map is gone
    }
  };
  function sizes() {
    root.classList.toggle("fit", st.fit);
    document.documentElement.classList.toggle(FIT_CLS, st.fit);
    setTimeout(() => {
      resizeAll();
      if (st.open) frame();
    }, 30);
  }
  const fsOn = () => !!document.fullscreenElement;
  const fullScreen = () => (fsOn() ? document.exitFullscreen() : root.requestFullscreen?.());
  const onFs = () =>
    setTimeout(() => {
      resizeAll();
      if (st.open) frame();
    }, 60);
  document.addEventListener("fullscreenchange", onFs);
  new ResizeObserver(() => map.resize()).observe(mapEl);

  // ---- the data: the chunks scored in the worker (not drawn: they only give the patches), and Sentinel-2
  let codes: Awaited<ReturnType<typeof createCodesLayer>> | null = null;
  let s2: ReturnType<typeof createS2> | null = null;
  let ready = false;
  const decoderP = fetch(decoderBin)
    .then((r) => r.arrayBuffer())
    .then((b) => ({ w: new Float32Array(b), layers: (decoderMeta as { net: { layers: unknown[] } }).net.layers }));

  // ---- the patches of dug ground in the area read, found again as chunks come in (a few times a second at most)
  let patches: Patch[] = [];
  // every patch's outline as segments, for the map: their ends, and how many
  let segSrc = new Float64Array(0), segTgt = new Float64Array(0), segN = 0, segV = 0;
  // the patches' runs by row: [start, end, patch, ...], to find the patch under the pointer
  let rowsOf = new Map<number, number[]>();
  let patchT = 0;
  function patchesSoon() {
    clearTimeout(patchT);
    patchT = window.setTimeout(findPatches, 400);
  }
  // each patch's outer outline and extent kept by its first run and size, so a patch unchanged as chunks come in is not
  // closed again
  let outlines = new Map<string, { edges: number[][]; ext: number[] }>();
  // every patch's extent as one bitmap over them (coarser past 2048 across): the reveal's mask
  let revealMask: { image: HTMLCanvasElement; bounds: [number, number, number, number] } | null = null;
  function findPatches() {
    if (!codes || !st.area) return;
    patches = patchesIn(st.area, codes.chunk);
    const kept = new Map<string, { edges: number[][]; ext: number[] }>();
    const edges: number[] = [];
    rowsOf = new Map();
    patches.forEach((p, i) => {
      const key = `${p.runs[0]}:${p.runs[1]}:${p.n}`;
      const out = outlines.get(key) ?? outerShape(p.runs);
      kept.set(key, out);
      for (const e of out.edges) edges.push(e[0], e[1], e[2], e[3]);
      for (let k = 0; k < p.runs.length; k += 3) {
        const r = rowsOf.get(p.runs[k]);
        if (r) r.push(p.runs[k + 1], p.runs[k + 2], i);
        else rowsOf.set(p.runs[k], [p.runs[k + 1], p.runs[k + 2], i]);
      }
    });
    outlines = kept;
    revealMask = maskOfRuns([...kept.values()].map((o) => o.ext));
    segN = edges.length / 4;
    segSrc = new Float64Array(2 * segN);
    segTgt = new Float64Array(2 * segN);
    for (let i = 0; i < segN; i++) {
      segSrc[2 * i] = edges[4 * i];
      segSrc[2 * i + 1] = edges[4 * i + 1];
      segTgt[2 * i] = edges[4 * i + 2];
      segTgt[2 * i + 1] = edges[4 * i + 3];
    }
    segV++;
    draw();
  }
  /** The patch at a point: the one under it, else the nearest within two pixels (so a click on an outline finds it). */
  function patchAt(lng: number, lat: number): Patch | null {
    const [gx, gy] = pixelOf(lng, lat);
    let best: Patch | null = null, bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      const r = rowsOf.get(gy + dy);
      if (!r) continue;
      for (let k = 0; k < r.length; k += 3) {
        const dx = gx < r[k] ? r[k] - gx : gx >= r[k + 1] ? gx - r[k + 1] + 1 : 0;
        const d = Math.max(Math.abs(dy), dx);
        if (d <= 2 && d < bestD) (bestD = d), (best = patches[r[k + 2]]);
      }
    }
    return best;
  }

  // ---- the Sentinel-2 card: the year shown, the day of its pass, the keys
  function drawS2Card() {
    const c = map.getCenter(), d = s2?.dateAt(st.s2Year, c.lng, c.lat) ?? "", stt = s2?.status(st.s2Year) ?? "finding";
    const day = d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` + (stt === "cloudy" ? ", cloudy" : "") : stt === "cloudy" ? "no scene" : "finding…";
    const ends = `${String(S2_YEARS[0]).slice(2)}/${String(S2_YEARS[S2_YEARS.length - 1]).slice(2)}`;
    void ends;
    const z = map.getZoom();
    s2Card.innerHTML =
      `<div class="s2hd"><b>${st.s2Year}</b><span>Sentinel-2<br>${day}</span><span class="zw">z<br><i class="z">${z.toFixed(1)}</i></span></div>`;
    // the keys' hints commented out for now
    // `<div class="keys"><span><kbd>[</kbd><kbd>]</kbd> year</span><span><kbd>B</kbd> ${ends}</span><span><kbd>N</kbd> new look</span><span><kbd>R</kbd> reveal</span><span><kbd>O</kbd> outlines</span><span><kbd>C</kbd> color</span></div>` +
    // the note under it commented out: the card is the year, Sentinel-2, the day and the zoom alone
    // `<div class="pnote">${z < AUTO_Z ? `Zoom in to ${AUTO_Z} to outline the dug ground` : (st.reveal ? `<i></i>Dug ground, 2018 to 2025: ${REVEAL_YEAR} inside, ${st.s2Year} around. Click a patch for both` : `<i></i>Dug ground, 2018 to 2025. Click a patch for its years`)}</div>`;
  }
  function stepS2(d: number) {
    const i = Math.max(0, Math.min(S2_YEARS.length - 1, S2_YEARS.indexOf(st.s2Year) + d));
    if (S2_YEARS[i] === st.s2Year) return;
    st.s2Year = S2_YEARS[i];
    s2?.discover(st.s2Year);
    drawS2Card();
    draw();
  }

  // ---- the map's layers: the imagery over everything of the basemap (no beforeId: drawn last), the patches' outlines
  // over it; the scored chunks loaded but not drawn
  function draw() {
    if (!ready || !codes) return;
    const layers: unknown[] = [];
    // every patch's extent as the mask (first, so the imagery after it can use it), while the map is dimmed around them
    // or the reveal is on
    if (s2 && revealMask && (mapSpot.k > 0 || st.reveal))
      layers.push(new SpotMaskLayer({ id: "reveal-mask", image: revealMask.image, bounds: revealMask.bounds, operation: "mask", extensions: [DISCARD_CLEAR], _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT } as never));
    // the imagery, dimmed outside the patches by mapSpot.k (D); each scene's layer given the mask from its first tile,
    // so it is there before D is first pressed (with no mask layer, nothing is dimmed)
    if (s2) layers.push(...s2.layers(st.s2Year, true, undefined, "", { extensions: [MAP_SPOT], maskId: "reveal-mask", maskByInstance: false }));
    // the reveal: the latest year over it, only inside the patches
    if (s2 && st.reveal && revealMask) layers.push(...s2.layerFor(REVEAL_YEAR, "rv", { extensions: [REVEAL], maskId: "reveal-mask", maskByInstance: false }));
    if (st.area)
      layers.push(
        codes.layer({
          minZoom: MIN_ZOOM,
          area: st.area,
          readId: st.readId,
          visible: false,
          onTile: () => {
            progressSoon();
            patchesSoon();
          },
        }),
      );
    if (segN && st.lines)
      layers.push(
        new LineLayer({
          id: "patches",
          data: { length: segN, attributes: { getSourcePosition: { value: segSrc, size: 2 }, getTargetPosition: { value: segTgt, size: 2 } } } as never,
          getColor: lineRgb(),
          getWidth: 1.5,
          widthUnits: "pixels",
          updateTriggers: { getSourcePosition: segV, getTargetPosition: segV, getColor: lineCol },
        }),
      );
    overlay.setProps({ layers: layers as never });
    progressSoon();
  }

  // ---- the panels
  function bootPanel(i: number) {
    const pn = panels[i];
    if (pn.map) return;
    const m = (pn.map = new maplibregl.Map({ container: pn.mapEl, style: BLANK, center: map.getCenter(), zoom: map.getZoom(), interactive: false, attributionControl: false, maxCanvasSize: [8192, 8192] }));
    pn.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    m.addControl(pn.overlay as unknown as maplibregl.IControl);
    m.on("load", drawPanels);
  }
  /** The patch framed the same in every panel: its box with room around it, no closer than PANEL_MAX_Z. */
  function frame() {
    const p = st.open, m = panels[0].map;
    if (!p || !m) return;
    const [W, S, E, N] = p.box, w = m.getContainer().clientWidth, h = m.getContainer().clientHeight;
    const cam = m.cameraForBounds([[W, S], [E, N]], { padding: { top: Math.max(90, h * 0.12), bottom: h * 0.1, left: w * 0.1, right: w * 0.1 } });
    if (!cam) return;
    const zoom = Math.min(PANEL_MAX_Z, cam.zoom ?? PANEL_MAX_Z);
    for (const pn of panels) pn.map?.jumpTo({ center: cam.center ?? [(W + E) / 2, (S + N) / 2], zoom, bearing: 0 });
  }
  let openPaths: number[][][] = [];
  // the readout under the panels: the patch's size, and the model's years for it as a small bar chart (each year's bar
  // as tall as the share of its pixels last dug that year, the year the map colors a pixel by), the dug panel's year in
  // orchid
  let backHa = "";
  function drawBack() {
    const p = st.open;
    if (!p) return;
    const top = Math.max(1, ...p.lastYears), dugYear = 0;
    const bars = p.lastYears
      .map((v, i) => {
        const y = FIRST_YEAR + i, h = v ? Math.max(2, Math.round((18 * v) / top)) : 0;
        return `<span class="hb${y === dugYear ? " on" : ""}"><i style="height:${h}px"></i><small>${String(y).slice(2)}</small></span>`;
      })
      .join("");
    // the keys' hints commented out for now
    // back.innerHTML = `<b>${backHa}</b><span class="hist" title="the share of the patch last dug each year">${bars}</span><span class="keys">click or <kbd>Esc</kbd> back · <kbd>O</kbd> outline · <kbd>D</kbd> dim</span>`;
    back.innerHTML = `<b>${backHa}</b><span class="hist" title="the share of the patch last dug each year">${bars}</span>`;
  }
  /** The open patch's outer extent (what its outline encloses) as one bitmap over its box, coarser past 2048 across. */
  let openMask: { image: HTMLCanvasElement; bounds: [number, number, number, number] } | null = null;
  const maskOf = (p: Patch) => maskOfRuns([extentRuns(p.runs)])!;
  /** Runs [row, start, end, ...] (one list or several) as one bitmap over them, coarser past 2048 across; null for none. */
  function maskOfRuns(lists: number[][]) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of lists) for (let i = 0; i < r.length; i += 3) (y0 = Math.min(y0, r[i])), (y1 = Math.max(y1, r[i] + 1)), (x0 = Math.min(x0, r[i + 1])), (x1 = Math.max(x1, r[i + 2]));
    if (!(x1 > x0)) return null;
    const f = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 2048)), w = Math.ceil((x1 - x0) / f), h = Math.ceil((y1 - y0) / f);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const img = new ImageData(w, h), d = img.data;
    for (const r of lists)
      for (let i = 0; i < r.length; i += 3) {
        const row = Math.floor((r[i] - y0) / f);
        for (let c = Math.floor((r[i + 1] - x0) / f); c < Math.ceil((r[i + 2] - x0) / f); c++) d.fill(255, 4 * (row * w + c), 4 * (row * w + c) + 4);
      }
    cv.getContext("2d")!.putImageData(img, 0, 0);
    return { image: cv, bounds: [X0 + x0 * RES, Y0 - y1 * RES, X0 + x1 * RES, Y0 - y0 * RES] as [number, number, number, number] };
  }
  function drawPanels() {
    if (!st.open || !s2) return;
    panels.forEach((pn, i) => {
      if (!pn.year || !pn.map || !pn.overlay) return;
      const line = new PathLayer({ id: "patch", data: openPaths, getPath: (r: number[][]) => r as never, getColor: lineRgb(), getWidth: 2.5, widthUnits: "pixels", jointRounded: true, capRounded: true, updateTriggers: { getColor: lineCol } });
      // the mask first, then the imagery dimmed outside it (each scene's layer given the mask from its first tile)
      // the imagery around the patch dimmed by spot.k (D steps it; 0 the imagery as it is)
      const mask = openMask && new SpotMaskLayer({ id: "spot-mask", image: openMask.image, bounds: openMask.bounds, operation: "mask", extensions: [DISCARD_CLEAR], _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT } as never);
      const ext = mask ? { extensions: [SPOT], maskId: "spot-mask", maskByInstance: false } : {};
      const img = pn.wait ? [] : pn.pass ? s2!.layerForPass(pn.year, pn.pass, `t${i}`, ext) : s2!.layerFor(pn.year, `t${i}`, ext);
      pn.overlay.setProps({ layers: [...(mask ? [mask] : []), ...img, ...(st.panelLines ? [line] : [])] as never });
      if (pn.wait) {
        pn.label.innerHTML = `<b>Dug</b><span>finding the pass that shows it…</span>`;
        return;
      }
      const d = pn.pass?.date ?? s2!.dateAt(pn.year), stt = pn.pass ? "clear" : s2!.status(pn.year);
      const day = d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` + (stt === "cloudy" ? ", cloudy" : "") : stt === "cloudy" ? "no scene" : "finding…";
      pn.label.innerHTML = `<b>${pn.year}</b><span>${pn.role}<br>Sentinel-2 · ${day}</span>`;
    });
    drawBack();
  }
  function openPatch(p: Patch) {
    st.open = p;
    openPaths = outerOutline(p.runs).map(([a, b, c, d]) => [[a, b], [c, d]]);
    openMask = maskOf(p);
    // its size, to see where a cutoff for small patches would sit: hectares from its 10 m pixels at its latitude
    const ha = (p.n * (RES * 111320) ** 2 * Math.cos((((p.box[1] + p.box[3]) / 2) * Math.PI) / 180)) / 1e4;
    backHa = `${ha < 10 ? ha.toFixed(1) : ha.toFixed(0)} ha`;
    drawBack();
    // the first year and the latest, side by side
    const ys: [number, string][] = [[S2_YEARS[0], "before"], [S2_YEARS[S2_YEARS.length - 1], "after"]];
    s2?.want(ys.map((y) => y[0]));
    tri.classList.add("on");
    panels.forEach((pn, i) => {
      pn.year = ys[i]?.[0] ?? 0;
      pn.role = ys[i]?.[1] ?? "";
      pn.pass = null;
      pn.wait = false;
      pn.el.classList.toggle("off", !pn.year);
      // the last open patch's imagery off until this one's is drawn
      if (!pn.year) pn.overlay?.setProps({ layers: [] });
    });
    panels.forEach((pn, i) => pn.year && bootPanel(i));
    for (const pn of panels) pn.map?.resize();
    frame();
    drawPanels();
  }
  function closePatch() {
    st.open = null;
    tri.classList.remove("on");
    for (const pn of panels) pn.overlay?.setProps({ layers: [] });
  }
  tri.addEventListener("click", closePatch);

  /** Reads the view: the chunks in it scored (those read before come from the worker's and the disk's kept scores). */
  function read() {
    if (map.getZoom() < MIN_ZOOM) return drawS2Card();
    const b = map.getBounds();
    st.area = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    st.readId++;
    draw();
    patchesSoon();
  }

  // ---- the loading bar: the chunks in view on hand
  let progT = 0;
  function progressSoon() {
    clearTimeout(progT);
    progT = window.setTimeout(progress, 150);
  }
  function progress() {
    if (!codes || map.getZoom() < MIN_ZOOM) {
      load.classList.remove("on");
      loadTag.classList.remove("on");
      return;
    }
    const w = codes.work();
    const on = w.reading > 0;
    load.classList.toggle("on", on);
    loadTag.classList.toggle("on", on);
    if (!on) return;
    const d = w.readDone, n = w.readDone + w.reading;
    (load.firstChild as HTMLElement).style.width = ((100 * d) / Math.max(1, n)).toFixed(1) + "%";
    loadTag.innerHTML = `Scoring chunks: ${d} of ${n}, every year 2017 to 2025` + (n > 30 ? ` <span>zoom in to load faster</span>` : "");
    progressSoon();
  }

  // ---- the pointer: a hand over a patch, and a click opens it in the panels (2017 and 2025 side by side): commented
  // out, the map dims around the patches (D) and flips the year (B) instead
  // map.on("mousemove", (e) => {
  //   map.getCanvas().style.cursor = patchAt(e.lngLat.lng, e.lngLat.lat) ? "pointer" : "";
  // });
  // map.on("click", (e) => {
  //   const p = patchAt(e.lngLat.lng, e.lngLat.lat);
  //   if (p) openPatch(p);
  // });
  void openPatch;

  // ---- search, as aef-earthwork-web searches: Photon as you type; when it is slow or finds nothing, Enter asks
  // Nominatim (whose usage policy allows no search-as-you-type and at most one request a second, so it runs on Enter
  // only)
  type Hit = { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> & { extent?: number[] } };
  const PHOTON = "https://photon.komoot.io/api/", NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const PHOTON_MS = 6000, PHOTON_ENTER_MS = 2500;
  let gcHits: Hit[] = [], gcSel = -1, gcTimer = 0, gcSeq = 0, gcBusy: string | null = null, gcAbort: AbortController | null = null, nomLast = 0;
  const hitName = (f: Hit) => {
    const p = f.properties as Record<string, string>;
    return [p.name, p.street && !p.name ? p.street : null, p.city && p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(", ");
  };
  const hitKind = (f: Hit) => {
    const p = f.properties as Record<string, string>;
    return [p.osm_value, p.type].filter((x) => x && x !== "yes").join(", ");
  };
  const gcHide = () => {
    hits.style.display = "none";
    hits.replaceChildren();
    gcSel = -1;
  };
  const gcShow = () => {
    hits.replaceChildren();
    if (!gcHits.length) return gcHide();
    gcHits.forEach((f, i) => {
      const r = E("div", "hit" + (i === gcSel ? " sel" : ""));
      r.textContent = hitName(f);
      const k = E("small");
      k.textContent = hitKind(f);
      r.appendChild(k);
      r.onmousedown = (e) => {
        e.preventDefault();
        gcFly(f);
      };
      r.onmouseenter = () => {
        gcSel = i;
        gcShow();
      };
      hits.appendChild(r);
    });
    hits.style.display = "block";
  };
  // one gray line in the list in place of hits: searching, or why there are none
  const gcStatus = (t: string) => {
    hits.replaceChildren();
    gcSel = -1;
    const r = E("div", "hit wait");
    r.textContent = t;
    hits.appendChild(r);
    hits.style.display = "block";
  };
  const photon = async (t: string, ms: number): Promise<Hit[]> => {
    const params = new URLSearchParams({ q: t, limit: "6", lang: "en" });
    const c = map.getCenter();
    params.set("lon", c.lng.toFixed(4));
    params.set("lat", c.lat.toFixed(4));
    gcAbort?.abort();
    const ac = (gcAbort = new AbortController()), tm = setTimeout(() => ac.abort(), ms);
    try {
      const d = await (await fetch(PHOTON + "?" + params.toString(), { signal: ac.signal })).json();
      return (d.features || []).filter((f: Hit) => f.geometry && f.geometry.coordinates);
    } finally {
      clearTimeout(tm);
    }
  };
  // Nominatim's results in Photon's shape (extent is [west, north, east, south]), so the list and the fly-to read both
  // alike
  const nominatim = async (t: string): Promise<Hit[]> => {
    const wait = nomLast + 1100 - Date.now();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    nomLast = Date.now();
    const params = new URLSearchParams({ q: t, format: "jsonv2", addressdetails: "1", limit: "6", "accept-language": "en" });
    const b = map.getBounds();
    params.set("viewbox", [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((v) => v.toFixed(4)).join(","));
    const d = await (await fetch(NOMINATIM + "?" + params.toString())).json();
    return (d || []).map((h: Record<string, unknown> & { address?: Record<string, string>; boundingbox?: string[] }) => {
      const a = h.address || {}, bb = (h.boundingbox || []).map(Number);
      return {
        geometry: { coordinates: [Number(h.lon), Number(h.lat)] },
        properties: {
          name: h.name || String(h.display_name || "").split(",")[0],
          city: a.city || a.town || a.village,
          state: a.state,
          country: a.country,
          osm_value: h.type,
          type: "via Nominatim",
          extent: bb.length === 4 ? [bb[2], bb[1], bb[3], bb[0]] : undefined,
        },
      };
    });
  };
  // enter: Enter was pressed, so Photon gets a shorter wait and Nominatim follows when it fails
  const gcAsk = async (enter = false) => {
    const t = q.value.trim();
    if (t.length < 2) {
      gcHits = [];
      gcBusy = null;
      return gcHide();
    }
    const s = ++gcSeq;
    // Enter while Photon is still on this same query: it has been waited on already
    const skipPhoton = enter && gcBusy === t;
    if (skipPhoton) {
      gcAbort?.abort();
      gcBusy = null;
    }
    gcStatus("searching\u2026");
    let found: Hit[] = [], why = "";
    if (!skipPhoton) {
      gcBusy = t;
      try {
        found = await photon(t, enter ? PHOTON_ENTER_MS : PHOTON_MS);
      } catch (e) {
        why = (e as Error).name === "AbortError" ? "slow" : "down";
      }
      if (s !== gcSeq) return;
      gcBusy = null;
    }
    if (!found.length && enter) {
      gcStatus("searching Nominatim\u2026");
      try {
        found = await nominatim(t);
      } catch {
        why = "down";
      }
      if (s !== gcSeq) return;
    }
    gcHits = found;
    gcSel = found.length ? 0 : -1;
    if (found.length) gcShow();
    else if (enter) gcStatus(why ? "search is not answering, try again in a moment" : "no match");
    else gcStatus(why === "slow" ? "Photon is slow: press Enter to search Nominatim" : why ? "Photon is not answering: press Enter to search Nominatim" : "no match: press Enter to search Nominatim");
  };
  // to the place's extent, no farther out than the view is read by itself
  const gcFly = (f: Hit) => {
    const [lon, lat] = f.geometry.coordinates;
    const ext = f.properties.extent;
    let zoom = 13.5;
    if (ext && ext.length === 4) {
      const span = Math.max(Math.abs(ext[2] - ext[0]), Math.abs(ext[1] - ext[3]) * 2, 0.01);
      zoom = Math.log2((360 * ((mapEl.clientWidth || 1200) / 512)) / span) - 0.3;
    }
    zoom = Math.max(AUTO_Z, Math.min(16, zoom));
    q.value = hitName(f);
    gcHits = [];
    gcHide();
    q.blur();
    map.flyTo({ center: [lon, lat], zoom, duration: 2200, essential: true });
  };
  q.addEventListener("input", () => {
    clearTimeout(gcTimer);
    gcTimer = window.setTimeout(gcAsk, 250);
  });
  q.addEventListener("focus", () => gcHits.length && gcShow());
  q.addEventListener("blur", () => setTimeout(gcHide, 120));
  q.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" && gcHits.length) {
      gcSel = (gcSel + 1) % gcHits.length;
      gcShow();
      e.preventDefault();
    } else if (e.key === "ArrowUp" && gcHits.length) {
      gcSel = (gcSel - 1 + gcHits.length) % gcHits.length;
      gcShow();
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (gcHits.length) gcFly(gcHits[Math.max(0, gcSel)]);
      else {
        clearTimeout(gcTimer);
        gcAsk(true).then(() => gcHits.length && gcFly(gcHits[0]));
      }
    } else if (e.key === "Escape") {
      gcHide();
      q.blur();
    }
  });


  // ---- K: the map (no cards; paired, both halves) as a PNG at SNAP_X times its size on screen, written by the kernel
  // to exports/
  const SNAP_X = 4;
  let snapping = false;
  // deck.gl sizes its drawing from the canvas's CSS size changing, which a new pixel ratio alone does not do: without
  // this it draws at the screen's ratio into a corner of the bigger canvas
  const deckFollow = (m: maplibregl.Map, ov: InstanceType<typeof MapboxOverlay>) => {
    const ctx = (ov as unknown as { _deck?: { device?: { canvasContext?: { setDrawingBufferSize(w: number, h: number): void } } } })._deck?.device?.canvasContext;
    const c = m.getCanvas();
    ctx?.setDrawingBufferSize(c.width, c.height);
  };
  /** A map drawn again at SNAP_X with every tile in, copied in the frame it was drawn (the buffer clears after it). */
  async function grab(m: maplibregl.Map) {
    await new Promise<void>((r) => {
      m.once("idle", () => r());
      m.triggerRepaint();
    });
    return new Promise<HTMLCanvasElement>((r) => {
      m.once("render", () => {
        const c = m.getCanvas();
        const out = document.createElement("canvas");
        out.width = c.width;
        out.height = c.height;
        out.getContext("2d")!.drawImage(c, 0, 0);
        r(out);
      });
      m.triggerRepaint();
    });
  }
  /** The export scaled for a LinkedIn post (as aef-explorer's fit_linkedin.py): ratio kept, long side 2048, stepped
   * down 128 at a time until the PNG is under 5 MB; halved in steps first so the downscale stays sharp. */
  async function forLinkedIn(src: HTMLCanvasElement) {
    for (let long = 2048; ; long -= 128) {
      const k = Math.min(1, long / Math.max(src.width, src.height));
      const w = Math.round(src.width * k), h = Math.round(src.height * k);
      let c = src;
      while (c.width / 2 >= w) {
        const half = document.createElement("canvas");
        half.width = Math.round(c.width / 2);
        half.height = Math.round(c.height / 2);
        const g = half.getContext("2d")!;
        g.imageSmoothingQuality = "high";
        g.drawImage(c, 0, 0, half.width, half.height);
        c = half;
      }
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const g = out.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      g.drawImage(c, 0, 0, w, h);
      const b = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (!b) throw new Error("the canvas gave no PNG");
      if (b.size <= 5 * 1024 * 1024 || long <= 1080) return { png: b, size: `${w}x${h}` };
    }
  }
  // the PNG carries no cards: each image's year and day drawn at its top left, text with a soft shadow, no box
  // (LinkedIn's rule)
  const FONT = "'Instrument Sans', system-ui, sans-serif";
  function drawYear(g: CanvasRenderingContext2D, x0: number, y0: number, k: number, year: number, role: string, d: string) {
    g.save();
    g.shadowColor = "rgba(0,0,0,.9)";
    g.shadowBlur = 5 * k;
    g.textBaseline = "top";
    g.font = `600 ${34 * k}px ${FONT}`;
    g.fillStyle = "#e6e9ec";
    g.fillText(String(year), x0, y0);
    g.font = `600 ${14 * k}px ${FONT}`;
    g.fillStyle = "#f2f4f6";
    let y = y0 + 40 * k;
    if (role) {
      g.fillText(role[0].toUpperCase() + role.slice(1), x0, y);
      y += 18 * k;
    }
    g.fillText("Sentinel-2" + (d ? ` · ${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : ""), x0, y);
    g.restore();
  }
  async function snap() {
    if (snapping) return;
    snapping = true;
    note(`Exporting a ${SNAP_X}x PNG...`);
    // the panels open: each side by side with the divider between them, as on screen; else the map
    const open = st.open ? panels.filter((p) => p.year && p.map && p.overlay) : [];
    const maps: [maplibregl.Map, InstanceType<typeof MapboxOverlay>, number, string, string][] = open.length
      ? open.map((p) => [p.map!, p.overlay!, p.year, p.role, p.pass?.date ?? s2?.dateAt(p.year) ?? ""])
      : [[map, overlay, st.s2Year, "", s2?.dateAt(st.s2Year) ?? ""]];
    try {
      for (const [m, ov] of maps) {
        m.setPixelRatio(SNAP_X);
        deckFollow(m, ov);
      }
      const shots = await Promise.all(maps.map(([m]) => grab(m)));
      // the ratio drawn, lower than SNAP_X where maxCanvasSize held the canvas back
      const x = shots[0].width / maps[0][0].getContainer().clientWidth;
      const line = shots.length > 1 ? Math.round(2 * x) : 0;
      const out = document.createElement("canvas");
      out.width = shots.reduce((w, c) => w + c.width, 0) + line * (shots.length - 1);
      out.height = Math.max(...shots.map((c) => c.height));
      const g = out.getContext("2d")!;
      let at = 0;
      const pad = 14 * x;
      shots.forEach((c, i) => {
        g.drawImage(c, at, 0);
        drawYear(g, at + pad, pad, x, maps[i][2], maps[i][3], maps[i][4]);
        at += c.width;
        if (i < shots.length - 1) {
          g.fillStyle = "rgba(255,255,255,.35)";
          g.fillRect(at, 0, line, out.height);
          at += line;
        }
      });
      const png = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (!png) throw new Error("the canvas gave no PNG");
      const small = await forLinkedIn(out);
      const c = open.length ? open[0].map!.getCenter() : map.getCenter(), z = open.length ? open[0].map!.getZoom() : map.getZoom();
      const name = `z${z.toFixed(1)}_${c.lat.toFixed(4)}_${c.lng.toFixed(4)}` + (open.length ? `_patch-${open.map((p) => p.year).join("-")}` : `_s2-${st.s2Year}`) + `_${+x.toFixed(1)}x`;
      model.set("snap_name", name);
      model.set("snap_small", new DataView(await small.png.arrayBuffer()));
      model.set("snap_small_size", small.size);
      model.set("snap", new DataView(await png.arrayBuffer()));
      model.save_changes();
    } catch (err) {
      note(`Export failed: ${(err as Error).message}`);
    } finally {
      // back to the screen's own ratio
      for (const [m, ov] of maps) {
        m.setPixelRatio(null as never);
        deckFollow(m, ov);
      }
      snapping = false;
    }
  }
  model.on("change:snap_status", () => note(String(model.get("snap_status") || "")));

  // ---- keys
  let pivotTo = 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target === q) return;
    const k = e.key;
    if (k === "k" || k === "K") snap();
    else if (k === "o" || k === "O") {
      // the outline on or off: the patch's in the panels while they are open, else every patch's on the map
      const on = st.open ? (st.panelLines = !st.panelLines) : (st.lines = !st.lines);
      if (st.open) drawPanels();
      else draw();
      note(on ? "Outlines on" : "Outlines off");
    }
    else if (k === "Escape") {
      if (st.open) closePatch();
      else if (st.fit) {
        st.fit = false;
        sizes();
      }
    }
    else if (k === "c" || k === "C") {
      // the outline's color, on the map and in the panels
      lineCol = (lineCol + 1) % LINE_COLS.length;
      root.style.setProperty("--line-col", `rgb(${lineRgb().slice(0, 3).join(",")})`);
      draw();
      if (st.open) drawPanels();
      note(`Outline: ${LINE_COLS[lineCol].name} (C)`);
    } else if ((k === "d" || k === "D") && st.open) {
      // how dim around the patch in the panels: half, a quarter, none, full
      spot.k = SPOT_STEPS[(SPOT_STEPS.indexOf(spot.k) + 1) % SPOT_STEPS.length];
      for (const pn of panels) pn.map?.triggerRepaint();
      note(spot.k ? `Around the patch: dimmed ${spot.k === 1 ? "fully" : spot.k === 0.5 ? "half" : "a quarter"} (D)` : "Around the patch: not dimmed (D)");
    } else if (k === "d" || k === "D") {
      // the map dimmed by half outside every patch, or not
      mapSpot.k = mapSpot.k ? 0 : 0.5;
      draw();
      map.triggerRepaint();
      note(mapSpot.k ? "Outside the patches: dimmed half (D)" : "Outside the patches: not dimmed (D)");
    }
    // J, dark or gray around the patch: commented out
    // else if (k === "j" || k === "J") {
    //   spot.gray = !spot.gray;
    //   for (const pn of panels) pn.map?.triggerRepaint();
    //   note(spot.gray ? "Around the patch: gray (J for dark)" : "Around the patch: dark (J for gray)");
    // }
    else if (k === "f" || k === "F") fullScreen();
    else if (k === "x" || k === "X") {
      st.fit = !st.fit;
      sizes();
    } else if (st.open) return;
    // the rest move the map or its imagery: not while the panels are open
    // R, the reveal (the latest year inside every patch, the year shown around them): commented out, the map dims
    // around the patches (D) and B goes to the latest year instead
    // else if (k === "r" || k === "R") {
    //   st.reveal = !st.reveal;
    //   drawS2Card();
    //   draw();
    //   note(st.reveal ? `Reveal: ${REVEAL_YEAR} inside the patches (R)` : "Reveal off (R)");
    // }
    else if (k === "[" || k === "]") stepS2(k === "]" ? 1 : -1);
    else if (k === "b" || k === "B") {
      // from any year to the latest, then back and forth between the first and the latest
      const last = S2_YEARS.length - 1, i = S2_YEARS.indexOf(st.s2Year);
      stepS2((i === last ? 0 : last) - i);
    } else if ((k === "n" || k === "N") && s2) {
      // the year's next look: another of its clear passes
      s2.next(st.s2Year);
      drawS2Card();
      draw();
    } else if (k === "/") q.focus();
    else if (e.shiftKey && (k === "ArrowLeft" || k === "ArrowRight")) {
      // Shift and an arrow: the map pivots about its center, 15 degrees a press
      pivotTo = (map.isMoving() ? pivotTo : map.getBearing()) + (k === "ArrowRight" ? 15 : -15);
      map.easeTo({ bearing: pivotTo, duration: 250 });
    } else if (k === "ArrowLeft") map.panBy([-120, 0]);
    else if (k === "ArrowRight") map.panBy([120, 0]);
    else if (k === "ArrowUp") map.panBy([0, -120]);
    else if (k === "ArrowDown") map.panBy([0, 120]);
    else if (k === "+" || k === "=") map.zoomIn();
    else if (k === "-" || k === "_") map.zoomOut();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  map.on("moveend", progressSoon);
  map.on("moveend", () => {
    s2?.discover(st.s2Year);
    s2?.want([REVEAL_YEAR]);
    drawS2Card();
    draw();
  });
  // close enough in, a view that reaches past the area read is read once the map has settled
  let autoT = 0;
  map.on("moveend", () => {
    clearTimeout(autoT);
    if (map.getZoom() < AUTO_Z || !ready) return;
    const b = map.getBounds(), a = st.area;
    if (a && b.getWest() >= a[0] && b.getEast() <= a[2] && b.getSouth() >= a[1] && b.getNorth() <= a[3]) return;
    autoT = window.setTimeout(read, 500);
  });
  map.on("zoom", () => {
    const ze = s2Card.querySelector(".z");
    if (ze) ze.textContent = map.getZoom().toFixed(1);
  });

  map.on("load", async () => {
    s2 = createS2(map, () => {
      drawS2Card();
      draw();
      if (st.open) drawPanels();
    });
    s2.discover(st.s2Year);
    s2.want([REVEAL_YEAR]);
    drawS2Card();
    codes = await createCodesLayer(world as unknown as WorldModel, await decoderP, () => draw());
    ready = true;
    // the first view reads at once
    read();
  });

  sizes();
  return () => {
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFs);
    document.documentElement.classList.remove(FIT_CLS);
    try {
      for (const p of panels) p.map?.remove();
      map.remove();
    } catch {
      // gone already
    }
  };
}

export default { render };
