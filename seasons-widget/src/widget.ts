import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import "./mesh-sampler";

import { MapLibreOverlay as MapboxOverlay } from "@deck.gl/maplibre";
import { COORDINATE_SYSTEM, LayerExtension } from "@deck.gl/core";
import { MaskExtension } from "@deck.gl/extensions";
import { BitmapLayer, LineLayer, PathLayer } from "@deck.gl/layers";
import { GeoArrowPathLayer, GeoArrowPolygonLayer } from "@geoarrow/deck.gl-layers";
import * as arrow from "apache-arrow";
import * as maplibregl from "maplibre-gl";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";
import { Protocol } from "pmtiles";

import { MIN_ZOOM, RES, X0, Y0, YEAR_ORIGIN } from "./aef";
import { createCodesLayer, HALF_COL, type Look, pixelCenter, pixelOf, SEASON_COL, UNCLEAR, Y0_RAMP, YEAR_COL } from "./codes-layer";
import decoderBin from "./decoder_month.bin?url";
import { colorData, type FootJoin, joinColors, joinPixels, ringOf as footRing } from "./foot";
// Earth Genome's yearly mosaics (eg-s2.ts) swapped for single scenes from Earth Search
import { createS2, S2_YEARS } from "./es-s2";
import { outerShape, type Patch, patchAt, patchesIn } from "./patch";
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

// quarters of the calendar year, not seasons: they mean the same in either hemisphere
// quarters off for now: measured against real Sentinel-2 they were no better than a guess (embeddings-vis
// scripts/quarter_check.py: the rule shown matched 50%, always Q1 62%). The years stay; the code stays for the work ahead
const QUARTERS = false;
const SEASONS = [["Q1", "Jan-Mar"], ["Q2", "Apr-Jun"], ["Q3", "Jul-Sep"], ["Q4", "Oct-Dec"]];
// the Overture outlines: one color, apart from every color of the ramp
const FOOT = "#4fd6ff";
// a footprint with digging under it: light orchid, solid. A hue the ramp (blue to green to yellow) never takes, and
// light: with protanopia it reads as a pale lavender, lighter than every blue of the ramp and apart from its greens,
// its yellow and the silver (the farthest from all of them of the bright colors that are not red)
const DUG_LINE: [number, number, number, number] = [240, 165, 255, 255];
// a footprint with no digging under it: a neutral gray with no hue to mix up with any year of the ramp (seen normally
// or with protanopia), light enough to hold an edge on the dark basemap
const FOOT_LINE: [number, number, number, number] = [184, 184, 184, 210];
// a footprint with no year, on the Sentinel-2 imagery: solid, so it reads on bright ground
const S2_LINE = [79, 214, 255];
// the fold chevron, as aef-earthwork-web's cards
const CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>';
// from this zoom the view reads by itself once the map settles; below it nothing is read
const AUTO_Z = MIN_ZOOM;
const FIT_CLS = "sm-fit-on";

// ---- the patches as windows (from the reveal branch): Sentinel-2 drawn only inside every patch's extent, deck.gl's
// mask extension with the extents as one bitmap
const WINDOW = new MaskExtension();
// the mask: a bitmap of the extents, its clear pixels dropped so only the patches count
class DiscardClear extends LayerExtension {
  getShaders() {
    return { inject: { "fs:DECKGL_FILTER_COLOR": "if (color.a < 0.5) discard;" } };
  }
}
DiscardClear.extensionName = "DiscardClear";
const DISCARD_CLEAR = new DiscardClear();
// a BitmapLayer gives deck no bounds (its positions are not kept), so its mask was never drawn: its own bounds here
class WindowMaskLayer extends BitmapLayer {
  getBounds() {
    const [w, s, e, n] = this.props.bounds as number[];
    return [[w, s], [e, n]] as [number[], number[]];
  }
}
WindowMaskLayer.layerName = "WindowMaskLayer";

// ---- the spotlight in the pair (from the reveal branch, itself aef-tessera-earthwork's year map ui.js): the left's
// imagery darkened outside the patch clicked, deck.gl's mask extension with that patch's extent as the mask
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MASK_MOD = (MaskExtension.prototype as any).getShaders.call({ getAttributeManager: () => ({ attributes: {} }), props: {}, state: {} }).modules[0];
const { "fs:#main-start": _maskDiscard, ...maskInject } = MASK_MOD.inject;
const SPOT_FILL = { name: "spotFill", fs: "layout(std140) uniform spotFillUniforms {\n  float k;\n} spotFill;\n", uniformTypes: { k: "f32" } };
const SPOT_MOD = {
  ...MASK_MOD,
  inject: {
    ...maskInject,
    "fs:#main-end": `
  if (mask.enabled && spotFill.k > 0.0 && !mask_isInBounds(mask_texCoords)) fragColor.rgb = mix(fragColor.rgb, fragColor.rgb * 0.3, spotFill.k);
`,
  },
};
/** how dim outside the patch (1: to 30% of its brightness) */
const spot = { k: 1 };
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
    this.setShaderModuleProps({ spotFill: { k: spot.k } });
  }
}
SpotExtension.extensionName = "SpotExtension";
const SPOT = new SpotExtension();

let protocolAdded = false;
// maplibre's worker from the bundle itself, as a blob: the widget is one file with nothing beside it
maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([maplibreWorker], { type: "text/javascript" })));

function render({ model, el }: { model: Model; el: HTMLElement }) {
  const cfg = JSON.parse(String(model.get("config") || "{}")) as { home: { lon: number; lat: number; zoom: number }; release: string };
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
  if (!protocolAdded) {
    maplibregl.addProtocol("pmtiles", new Protocol().tile);
    protocolAdded = true;
  }

  const st = { look: { src: "ours", year: null } as Look, fit: true, folded: false, area: null as [number, number, number, number] | null, readId: 0, labels: true, picking: true, pair: false, holding: false, s2Year: S2_YEARS[S2_YEARS.length - 1], lines: false, winMain: true, winPair: false };
  const E = (t: string, c?: string, h?: string) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (h != null) e.innerHTML = h;
    return e;
  };
  const root = E("div", "sm clean"), mapEl = E("div", "map"), mapEl2 = E("div", "map2");
  const load = E("div", "load", "<i></i>"), loadTag = E("div", "loadtag glass");
  root.append(mapEl2, mapEl, load, loadTag);
  el.appendChild(root);

  // ---- the card
  const card = E("div", "card glass");
  const hd = E("div", "hd");
  const hdT = E("div", "ht");
  // the chevron turns a quarter when the card is folded (the CSS)
  const fold = E("button", "cb", CHEV) as HTMLButtonElement;
  fold.title = "fold the card (H)";
  hd.append(hdT, fold);
  const body = E("div", "body");
  const rSrc = E("div", "row");
  const seg = E("div", "seg");
  const bOurs = E("button", "", "Ours") as HTMLButtonElement, bWsf = E("button", "", "WSF") as HTMLButtonElement;
  bOurs.title = "the aggregate earthwork model (AlphaEarth and TESSERA): when the ground was dug or graded";
  bWsf.title = "the WSF Tracker: when the ground first read as built-up";
  seg.append(bOurs, bWsf);
  rSrc.append(E("span", "lab", "Color by"), seg, E("kbd", "", "C"));
  const chips = E("div", "chips");
  const hint = E("div", "hint");
  const zoomRow = E("div", "zoom");
  // WSF commented out for now: the card colors by ours only
  // body.append(rSrc, chips, hint, zoomRow);
  // the text under the years hides behind a chevron of its own, leaving the years alone
  const notes = E("div", "notes");
  notes.append(hint, zoomRow);
  const less = E("button", "less", CHEV) as HTMLButtonElement;
  const setLess = (on: boolean) => {
    card.classList.toggle("short", on);
    less.title = on ? "show the notes" : "hide the notes, the years alone";
  };
  less.onclick = () => setLess(!card.classList.contains("short"));
  setLess(false);
  body.append(chips, notes, less);
  // the card: the years as one thin stepped line, the first and last at its ends, and no notes or keys
  const legend = E("div", "legend");
  const lline = E("div", "lline");
  YEAR_COL.forEach((col) => {
    const i = E("i");
    i.style.background = col;
    lline.appendChild(i);
  });
  legend.append(E("span", "", String(Y0_RAMP)), lline, E("span", "", String(Y0_RAMP + YEAR_COL.length - 1)));
  card.append(hd, legend, body);
  root.appendChild(card);
  const tip = E("div", "tip");
  const toast = E("div", "toast glass");
  // top left, as in aef-earthwork-web: the search, and under it the Sentinel-2 card while the imagery shows
  const top = E("div", "top");
  const sBox = E("div", "search glass", '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>');
  const q = E("input") as HTMLInputElement, hits = E("div", "hits");
  q.type = "search";
  q.placeholder = "Search";
  q.title = "a place (/)";
  q.autocomplete = "off";
  q.spellcheck = false;
  sBox.append(q, E("kbd", "", "/"), hits);
  const s2Card = E("div", "s2card glass");
  top.append(sBox, s2Card);
  root.append(tip, toast, top);
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
    // deck.gl draws into this canvas (interleaved), so its footprint edges are smoothed only if the canvas is
    canvasContextAttributes: { antialias: true },
    // room for the 4x export (K); maplibre's own cap is 4096. Past this the export comes out smaller (its name says)
    maxCanvasSize: [8192, 8192],
  });
  // the credits folded into their i until it is clicked (maplibre opens a compact one on a wide map)
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "Overture Maps (ODbL) · WSF Tracker, DLR and MindEarth (CC BY 3.0 IGO) · AlphaEarth Foundations, Google DeepMind (CC BY 4.0) · TESSERA v1.1, University of Cambridge · Sentinel-2: Copernicus, via Element 84 Earth Search",
    }),
    "bottom-right",
  );
  const foldCredits = () => root.querySelectorAll(".maplibregl-ctrl-attrib.maplibregl-compact-show").forEach((e) => e.classList.remove("maplibregl-compact-show"));
  map.once("load", foldCredits);
  map.once("idle", foldCredits);
  map.keyboard.disable();
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);

  function sizes() {
    root.classList.toggle("fit", st.fit);
    document.documentElement.classList.toggle(FIT_CLS, st.fit);
    setTimeout(() => {
      try {
        map.resize();
      } catch {
        // the map is gone
      }
    }, 30);
  }
  const fsOn = () => !!document.fullscreenElement;
  const fullScreen = () => (fsOn() ? document.exitFullscreen() : root.requestFullscreen?.());
  const onFs = () => setTimeout(() => map.resize(), 60);
  document.addEventListener("fullscreenchange", onFs);
  // the map's own box: it halves when the pair opens
  new ResizeObserver(() => map.resize()).observe(mapEl);

  // ---- the footprints of the area read, as GeoArrow (a polygon a row; `fid` the footprint), joined to the pixels
  let footBatch: arrow.RecordBatch | null = null;
  let join: FootJoin | null = null;
  // on the imagery: each footprint's outline, its year's color where it has one, solid light blue where not
  let line: ReturnType<typeof colorData> | null = null;
  // on the map: orchid where digging is under it, silver where not
  let mapLine: ReturnType<typeof colorData> | null = null;
  // the arrays behind them, to tell a change; and a count for each, read by its layer's update trigger
  let lineRgba: Uint8Array | null = null, mapLineRgba: Uint8Array | null = null;
  let lineN = 0, mapLineN = 0;
  // on the map with the patches as windows: silver, and none where the footprint touches a patch (the imagery shows
  // that ground instead)
  let winLine: ReturnType<typeof colorData> | null = null, winLineRgba: Uint8Array | null = null, winLineN = 0;
  // the basemap layer our raster, the footprints and their fade go under: its first road, so the streets stay over both
  let groundId = "foot";
  function loadFoot() {
    const b = model.get("foot") as DataView | ArrayBuffer | Uint8Array | null;
    if (!b || !(b as ArrayBuffer).byteLength || !codes) return;
    const bytes = b instanceof DataView ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b instanceof Uint8Array ? b : new Uint8Array(b);
    footBatch = arrow.tableFromIPC(bytes).batches[0] ?? null;
    // the rows are new: a footprint hovered or pinned by its old row is let go
    if (hoverHi?.key.startsWith("a:")) hoverHi = null;
    if (pinHi?.key.startsWith("a:")) pinHi = null;
    setL2();
    join = footBatch ? joinPixels(footBatch) : null;
    line = mapLine = lineRgba = mapLineRgba = winLine = winLineRgba = null;
    recolor();
  }
  model.on("change:foot", loadFoot);
  model.on("change:foot_status", () => note(String(model.get("foot_status") || "")));
  const ringOf = (row: number): number[][] => footRing(footBatch!, row);

  // each footprint's year from the pixels under it (its outline's color), again as chunks and quarters come in (a few
  // times a second at most)
  const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const YEAR_RGB = YEAR_COL.map(hexRgb), QUARTER_RGB = SEASON_COL.map(hexRgb), UNCLEAR_RGB = hexRgb(UNCLEAR);
  let joinT = 0;
  function joinSoon() {
    clearTimeout(joinT);
    joinT = window.setTimeout(recolor, 300);
  }
  function recolor() {
    if (!codes || !join) return render();
    const at = codes.at;
    const rgba = joinColors(join, at, st.look.year, (y) => YEAR_RGB[y - Y0_RAMP] ?? [0, 0, 0], QUARTER_RGB, UNCLEAR_RGB);
    const ln = new Uint8Array(rgba.length), ml = new Uint8Array(rgba.length), wl = new Uint8Array(rgba.length);
    for (let r = 0; r < join.rows; r++) {
      const o = 4 * r, has = rgba[o + 3] > 0;
      ml.set(has ? DUG_LINE : FOOT_LINE, o);
      if (!inPatch(r)) wl.set(FOOT_LINE, o);
      ln[o] = has ? rgba[o] : S2_LINE[0];
      ln[o + 1] = has ? rgba[o + 1] : S2_LINE[1];
      ln[o + 2] = has ? rgba[o + 2] : S2_LINE[2];
      ln[o + 3] = 255;
    }
    // a color array swapped (and its layer's colors laid out again) only when it changed: tiles come in a few times a
    // second, and most leave every building as it was
    let changed = false;
    if (!line || !same(lineRgba, ln)) {
      lineRgba = ln;
      line = colorData(ln, join.rows);
      lineN++;
      changed = true;
    }
    if (!mapLine || !same(mapLineRgba, ml)) {
      mapLineRgba = ml;
      mapLine = colorData(ml, join.rows);
      mapLineN++;
      changed = true;
    }
    if (!winLine || !same(winLineRgba, wl)) {
      winLineRgba = wl;
      winLine = colorData(wl, join.rows);
      winLineN++;
      changed = true;
    }
    if (changed) render();
  }
  const same = (a: Uint8Array | null, b: Uint8Array) => {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  // ---- the data layer
  let codes: Awaited<ReturnType<typeof createCodesLayer>> | null = null;
  let s2: ReturnType<typeof createS2> | null = null;
  /** Space held: the imagery alone on the map (in the pair it is already on the left). */
  function setS2(on: boolean) {
    if (on && st.pair) return;
    st.holding = on;
    root.classList.toggle("yrs", rasterShown());
    if (imgShown()) s2?.discover(st.s2Year);
    drawS2Card();
    render();
  }

  // ---- the pair (P), as aef-earthwork-web pairs its map: a second map on the left showing Sentinel-2, the map as it
  // was on the right, either moving the other. Both halves are the same size under one camera, so a point is the same
  // place on both and the right reads exactly as one map would
  let map2: maplibregl.Map | null = null;
  let overlay2: InstanceType<typeof MapboxOverlay> | null = null;
  let syncing = false;
  const camOf = (m: maplibregl.Map) => ({ center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
  function boot2() {
    if (map2) return;
    const m2 = (map2 = new maplibregl.Map({ container: mapEl2, style: STYLE, ...camOf(map), maxPitch: 0, dragRotate: false, attributionControl: false, maxCanvasSize: [8192, 8192] }));
    m2.keyboard.disable();
    overlay2 = new MapboxOverlay({ interleaved: true, layers: [] });
    m2.addControl(overlay2 as unknown as maplibregl.IControl);
    // the imagery alone: every basemap layer but its background hidden, so no road or name lands over it
    m2.on("load", () => {
      for (const l of m2.getStyle().layers) if (l.type !== "background") m2.setLayoutProperty(l.id, "visibility", "none");
      render();
    });
    const follow = (a: maplibregl.Map, b: maplibregl.Map) =>
      a.on("move", () => {
        if (syncing || !st.pair) return;
        syncing = true;
        b.jumpTo(camOf(a));
        syncing = false;
      });
    follow(map, m2);
    follow(m2, map);
    // the halves share one camera and size: the pointer on the left picks the footprint at the same point on the right
    // hover outlines a footprint; a patch of dug ground only on a click
    m2.on("mousemove", (e) => {
      const row = footAt(e.point);
      setHi(row >= 0 ? footHi(row) : null);
    });
    m2.on("click", (e) => pin(e.point));
    mapEl2.addEventListener("mouseleave", () => setHi(null));
    new ResizeObserver(() => m2.resize()).observe(mapEl2);
  }
  function setPair(on: boolean) {
    if (on === st.pair) return;
    if (on) st.holding = false;
    st.pair = on;
    root.classList.toggle("pair", on);
    root.classList.toggle("yrs", rasterShown());
    if (on) {
      boot2();
      map2!.jumpTo(camOf(map));
    }
    if (imgShown()) s2?.discover(st.s2Year);
    drawS2Card();
    render();
  }
  function stepS2(d: number) {
    const i = Math.max(0, Math.min(S2_YEARS.length - 1, S2_YEARS.indexOf(st.s2Year) + d));
    if (S2_YEARS[i] === st.s2Year) return;
    st.s2Year = S2_YEARS[i];
    s2?.discover(st.s2Year);
    drawS2Card();
    render();
  }
  let ready = false;
  const decoderP = fetch(decoderBin)
    .then((r) => r.arrayBuffer())
    .then((b) => ({ w: new Float32Array(b), layers: (decoderMeta as { net: { layers: unknown[] } }).net.layers }));
  function update() {
    joinSoon();
    render();
  }

  // ---- the patches of dug ground in the area read (as the reveal branch finds them), found again as chunks come in (a
  // few times a second at most): the windows the year's imagery shows through
  let patches: Patch[] = [];
  // every patch's outline as segments: their ends, and how many
  let segSrc = new Float64Array(0), segTgt = new Float64Array(0), segN = 0, segV = 0;
  // every patch's extent (what its outline encloses, holes filled) by row: [start, end, ...], to tell a footprint on one
  let extRows = new Map<number, number[]>();
  // the same by patch: [start, end, patch, ...] by row, and each patch's extent runs, to find the patch clicked
  let extOwner = new Map<number, number[]>();
  let extOf: number[][] = [];
  let patchT = 0;
  function patchesSoon() {
    clearTimeout(patchT);
    patchT = window.setTimeout(findPatches, 400);
  }
  // each patch's outline and extent kept by its first run and size, so a patch unchanged as chunks come in is not
  // closed again
  let outlines = new Map<string, { edges: number[][]; ext: number[] }>();
  // every patch's extent as one bitmap over them (coarser past 2048 across): the windows' mask
  let winMask: { image: HTMLCanvasElement; bounds: [number, number, number, number] } | null = null;
  function findPatches() {
    if (!codes || !st.area) return;
    patches = patchesIn(st.area, codes.chunk);
    const kept = new Map<string, { edges: number[][]; ext: number[] }>();
    const edges: number[] = [];
    extRows = new Map();
    extOwner = new Map();
    extOf = [];
    for (const [i, p] of patches.entries()) {
      const key = `${p.runs[0]}:${p.runs[1]}:${p.n}`;
      const out = outlines.get(key) ?? outerShape(p.runs);
      kept.set(key, out);
      for (const e of out.edges) edges.push(e[0], e[1], e[2], e[3]);
      const x = out.ext;
      for (let k = 0; k < x.length; k += 3) {
        const r = extRows.get(x[k]);
        if (r) r.push(x[k + 1], x[k + 2]);
        else extRows.set(x[k], [x[k + 1], x[k + 2]]);
        const o = extOwner.get(x[k]);
        if (o) o.push(x[k + 1], x[k + 2], i);
        else extOwner.set(x[k], [x[k + 1], x[k + 2], i]);
      }
      extOf.push(x);
    }
    outlines = kept;
    winMask = maskOfRuns([...kept.values()].map((o) => o.ext));
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
    // the footprints on a patch step aside (recolor draws again only when a color changed; the mask always needs it)
    recolor();
    render();
  }
  /** Whether any of a footprint's pixels lies in a patch's extent. */
  function inPatch(row: number) {
    if (!join) return false;
    for (let i = join.start[row]; i < join.start[row + 1]; i++) {
      const r = extRows.get(join.py[i]);
      if (!r) continue;
      const x = join.px[i];
      for (let k = 0; k < r.length; k += 2) if (x >= r[k] && x < r[k + 1]) return true;
    }
    return false;
  }
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
  // the imagery over the map itself: while space is held (our raster and the footprints step aside)
  const s2Shown = () => st.holding;
  // the patches as windows: the map, its footprints, and the year's imagery inside every patch (the view unless space
  // is held or the map is paired)
  // S switches it, apart on the map alone (starting on) and on the pair's right (starting off, the year raster)
  const winShown = () => !st.holding && (st.pair ? st.winPair : st.winMain);
  // the year raster: on the pair's right always (under the imagery while S has it on), alone on the map while S has the
  // imagery off
  const rasterShown = () => !st.holding && (st.pair || !st.winMain);
  // the imagery anywhere: held, on the pair's left, or through the patches
  const imgShown = () => true;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function drawS2Card() {
    // as aef-earthwork-web's: the year, what it is, the zoom at the right; its keys under it. Always there, the year
    // grayed while the imagery is not showing
    const showImg = imgShown();
    // the day of the year's pass; while one is being chosen, the one still on screen
    const c = map.getCenter(), d = s2?.dateAt(st.s2Year, c.lng, c.lat) ?? "", stt = s2?.status(st.s2Year) ?? "finding";
    const day = !showImg ? "true color" : d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` + (stt === "cloudy" ? ", cloudy" : "") : stt === "cloudy" ? "no scene" : "finding\u2026";
    const ends = `${String(S2_YEARS[0]).slice(2)}/${String(S2_YEARS[S2_YEARS.length - 1]).slice(2)}`;
    s2Card.innerHTML =
      `<div class="s2hd"><b>${st.s2Year}</b><span>Sentinel-2<br>${day}</span><span class="zw">z<br><i class="z">${map.getZoom().toFixed(1)}</i></span></div>` +
      `<div class="keys">${
        showImg
          ? `<span>${st.holding ? "Scroll or " : ""}<kbd>[</kbd><kbd>]</kbd> year</span><span><kbd>B</kbd> ${ends}</span><span><kbd>N</kbd> next</span>`
          : `<span><kbd>Space</kbd> or <kbd>P</kbd> to see it</span>`
      }</div>`;
    s2Card.classList.toggle("showing", showImg);
  }
  // the pair's left map: its imagery, and over it in orchid what is pinned by a click, else the footprint hovered, on
  // either half. A click pins a footprint, or where no footprint is, the patch of dug ground under it
  let l2: unknown[] = [];
  /** A thing outlined on the imagery: its key and its outline as paths. */
  type Hi = { key: string; paths: number[][][] };
  let hoverHi: Hi | null = null, pinHi: Hi | null = null;
  function setL2() {
    if (!overlay2) return;
    const h = pinHi ?? hoverHi;
    const hi = st.pair && h
      ? [new PathLayer({ id: "hi", data: h.paths, getPath: (r: number[][]) => r as never, getColor: DUG_LINE, getWidth: 2.5, widthUnits: "pixels", jointRounded: true, capRounded: true })]
      : [];
    // the patch clicked as the mask, first, so the imagery after it is dimmed outside it
    const mask = st.pair && spotMask ? [new WindowMaskLayer({ id: "spot-mask", image: spotMask.image, bounds: spotMask.bounds, operation: "mask", extensions: [DISCARD_CLEAR], _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT } as never)] : [];
    overlay2.setProps({ layers: [...mask, ...l2, ...hi] as never });
  }
  // the patch clicked on the right (or the same point on the left): the left's imagery dimmed around it, no outline
  let spotMask: { image: HTMLCanvasElement; bounds: [number, number, number, number] } | null = null;
  // the patch clicked, by its extent's first run (kept as chunks come in and the patches are found again)
  let spotKey = "";
  /** The patch under a point, by its extent (holes filled): its index, or -1. */
  function patchIdxAt(pt: { x: number; y: number }) {
    const ll = map.unproject([pt.x, pt.y]);
    const [x, y] = pixelOf(ll.lng, ll.lat), r = extOwner.get(y);
    if (r) for (let k = 0; k < r.length; k += 3) if (x >= r[k] && x < r[k + 1]) return r[k + 2];
    return -1;
  }
  /** A click on a patch dims the left around it; on the same patch again, or off every patch, the dim goes. */
  function spotAt(pt: { x: number; y: number }) {
    const i = patchIdxAt(pt), key = i >= 0 ? extOf[i].slice(0, 3).join(":") : "";
    if (!key || key === spotKey) {
      spotMask = null;
      spotKey = "";
    } else {
      spotMask = maskOfRuns([extOf[i]]);
      spotKey = key;
    }
    setL2();
  }
  function setHi(h: Hi | null) {
    if ((h?.key ?? "") === (hoverHi?.key ?? "")) return;
    hoverHi = h;
    if (st.pair && !pinHi) setL2();
  }
  /** The footprint's row at a point (the halves share one camera and size, so a point on either is the same place). */
  const footAt = (pt: { x: number; y: number }) => {
    const info = st.picking && footBatch ? overlay.pickObject({ x: pt.x, y: pt.y, radius: 2, layerIds: ["foot-poly"] }) : null;
    return info && info.index >= 0 ? info.index : -1;
  };
  const footHi = (row: number): Hi => ({ key: `a:${row}`, paths: [ringOf(row)] });
  /**
   * The patch of dug ground at a point, as aef-tessera-earthwork's year map joins one (patch.ts): every pixel dug, in
   * any year (a year opened: dug that year), joined to it by side or corner or across a one pixel gap, inside the area
   * read; its outer outline, holes filled.
   */
  function patchHi(lng: number, lat: number): Hi | null {
    if (!codes || !st.area) return null;
    const yOpen = st.look.year != null ? st.look.year - YEAR_ORIGIN : -1, bit = yOpen > 0 ? 1 << (yOpen - 1) : 0;
    const [W, S, E, N] = st.area;
    const [ax0, ay0] = pixelOf(W, N), [ax1, ay1] = pixelOf(E, S);
    const dug = (x: number, y: number) => {
      if (x < ax0 || x > ax1 || y < ay0 || y > ay1) return false;
      const c = codes!.at(x, y);
      return !!c && (yOpen > 0 ? (c.bits & bit) !== 0 : c.ours > 0);
    };
    const [x0, y0] = pixelOf(lng, lat);
    const p = patchAt(x0, y0, dug);
    return p && { key: `p:${yOpen}:${p.first}`, paths: p.edges.map(([a, b, c, d]) => [[a, b], [c, d]]) };
  }
  /** What is under a point: a footprint, else a patch of dug ground, else nothing. */
  function hiAt(pt: { x: number; y: number }): Hi | null {
    if (!st.picking) return null;
    const row = footAt(pt);
    if (row >= 0) return footHi(row);
    const ll = map.unproject([pt.x, pt.y]);
    return patchHi(ll.lng, ll.lat);
  }
  /** A click pins what is under it, so the years can be stepped with it held; with one pinned, any click lets go. */
  function pin(pt: { x: number; y: number }) {
    // paired, a click is the spotlight: the left dims around the patch under it
    if (st.pair) return spotAt(pt);
    pinHi = pinHi ? null : hiAt(pt);
    if (st.pair) setL2();
  }
  function render() {
    if (!ready || !codes) return;
    const layers: unknown[] = [];
    // the imagery under everything of ours: while it shows, our raster and the footprints step aside, the imagery alone
    // paired, the imagery is the left map's alone
    // over everything of the basemap's (no beforeId: drawn last), so no Carto label, road or line lands on the imagery
    if (s2 && st.holding) layers.push(...s2.layers(st.s2Year, true));
    // through the patches: the mask first (every patch's extent), then the year's imagery inside it alone, over the
    // basemap's roads and under its labels. The mask goes in the same slot: deck draws each slot apart in MapLibre, and a
    // mask from another slot comes out empty. Hidden until there are patches (with no mask layer it would cover the view)
    if (s2 && winShown()) {
      if (winMask) layers.push(new WindowMaskLayer({ id: "win-mask", image: winMask.image, bounds: winMask.bounds, operation: "mask", extensions: [DISCARD_CLEAR], _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT, beforeId: "foot" } as never));
      layers.push(...s2.layers(st.s2Year, !!winMask, "foot", "w", { extensions: [WINDOW], maskId: "win-mask", maskByInstance: false }));
    }
    if (map2 && overlay2) {
      // each scene's layer given the spotlight's mask (with no mask layer, nothing is dimmed)
      l2 = st.pair && s2 ? s2.layers(st.s2Year, true, undefined, "l", { extensions: [SPOT], maskId: "spot-mask", maskByInstance: false }) : [];
      setL2();
      if (!map2.isStyleLoaded()) map2.once("idle", setL2);
    }
    if (!st.area) {
      overlay.setProps({ layers: layers as never });
      return;
    }
    // the digging raster over the buildings: it shows wherever the model found ground dug, buildings or not. A
    // building's year is the pixels under it read together; the raster is the digging itself. Buildings are outlines
    // only, over the raster
    const footProps = footBatch && {
      data: footBatch,
      getPolygon: footBatch.getChild("geometry")!.data[0] as never,
      // the imagery alone while it shows: no footprints over it
      visible: !s2Shown(),
      // triangulated here, not in a worker fetched from a CDN
      earcutWorkerUrl: null,
    };
    if (footBatch)
      layers.push(
        // the buildings as the pointer's target: not drawn (filled clear), so the whole footprint picks, not only its
        // outline
        new GeoArrowPolygonLayer({
          ...footProps,
          id: "foot-poly",
          filled: true,
          stroked: false,
          getFillColor: [0, 0, 0, 0],
          pickable: true,
          beforeId: groundId,
        } as never),
      );
    layers.push(
      codes.layer({
        minZoom: MIN_ZOOM,
        area: st.area,
        readId: st.readId,
        // elsewhere it only gives the patches
        visible: rasterShown(),
        beforeId: groundId,
        onTile: () => {
          progressSoon();
          joinSoon();
          patchesSoon();
        },
      }),
    );
    if (footBatch)
      layers.push(
        // an outline each (orchid where digging is under the building, silver where not), over everything of ours and
        // the roads, under the labels
        // the outlines as paths over the same column (a polygon's rings are laid out as a multilinestring's lines), so
        // they are never triangulated, as a polygon layer would even unfilled
        new GeoArrowPathLayer({
          id: "foot-line",
          data: footBatch,
          getPath: footBatch.getChild("geometry")!.data[0] as never,
          visible: !s2Shown(),
          // on the imagery the outlines carry the years: solid, a pixel and a half; on the map, orchid where digging
          // is under the building, silver where not
          // through the patches, silver, none on a patch
          // (on the pair's right the joined buildings stay over the imagery, orchid)
          getColor: (s2Shown() ? (line ?? FOOT_LINE) : winShown() && !st.pair ? (winLine ?? FOOT_LINE) : (mapLine ?? FOOT_LINE)) as never,
          // in meters, so zoomed in they thicken up to four pixels; zoomed out they hold at their floor (a pixel and a
          // half on the imagery, half a pixel on the map, where they thin instead of adding up to a glare)
          getWidth: s2Shown() ? 3 : 2,
          widthUnits: "meters",
          widthMinPixels: s2Shown() ? 1.5 : 0.5,
          widthMaxPixels: 4,
          _pathType: "loop",
          updateTriggers: { getColor: [lineN, mapLineN, winLineN, s2Shown(), winShown(), st.pair] },
          // read by the MapLibre overlay
          beforeId: "foot",
        } as never),
      );
    // the patches' outlines (O), over the imagery
    if (segN && st.lines && winShown())
      layers.push(
        new LineLayer({
          id: "patches",
          data: { length: segN, attributes: { getSourcePosition: { value: segSrc, size: 2 }, getTargetPosition: { value: segTgt, size: 2 } } } as never,
          getColor: DUG_LINE,
          getWidth: 1.5,
          widthUnits: "pixels",
          updateTriggers: { getSourcePosition: segV, getTargetPosition: segV },
          beforeId: "foot",
        } as never),
      );
    overlay.setProps({ layers: layers as never });
    // deck.gl slots the layer under the footprints only while MapLibre calls its style loaded, which it does not while
    // any source's tiles are still coming: set again once the map is idle, so it lands under them, not over everything
    if (!map.isStyleLoaded()) map.once("idle", () => overlay.setProps({ layers: layers as never }));
    progressSoon();
  }

  // ---- the card's contents
  function drawCard() {
    const l = st.look;
    bOurs.classList.toggle("on", l.src === "ours");
    bWsf.classList.toggle("on", l.src === "wsf");
    chips.replaceChildren();
    body.querySelector(".years")?.remove();
    if (l.year == null) {
      hdT.innerHTML = "<b>Dug by year</b>";
      chips.style.gridTemplateColumns = "repeat(4, 1fr)";
      YEAR_COL.forEach((col, i) => {
        const y = Y0_RAMP + i, b = E("button", "chip", String(y)) as HTMLButtonElement;
        b.style.background = col;
        b.style.color = i < 4 ? "#fff" : "#111";
        // 2016 and 2017 commented out with WSF: the ramp starts at 2018
        // b.disabled = l.src === "ours" && y < 2018;
        // b.title = b.disabled ? "the first pair of years is 2017 to 2018" : `open ${y} by ${l.src === "ours" ? "quarter" : "half-year"}`;
        if (QUARTERS) {
          b.title = `open ${y} by ${l.src === "ours" ? "quarter" : "half-year"}`;
          b.onclick = () => setLook({ ...st.look, year: y });
        } else {
          b.title = String(y);
          b.style.cursor = "default";
        }
        chips.appendChild(b);
      });
      hint.textContent = l.src === "ours" ? "Buildings filled by the year their ground was dug or graded. Elsewhere the color is dug ground with no building on it: where to look." + (QUARTERS ? " Click a year to open it by quarter." : "") : "The ground colored by the year it first read as built-up. Click a year to open it by half-year.";
    } else {
      hdT.innerHTML = `<span class="crumb">All years</span><span class="sep">&rsaquo;</span><b>${l.year}</b>`;
      (hdT.querySelector(".crumb") as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        setLook({ ...st.look, year: null });
      };
      // every year, the one open outlined: another opens in its place, the open one (or All years) goes back
      const years = E("div", "years");
      const back = E("button", "allyears", "All") as HTMLButtonElement;
      back.title = "back to every year (Esc)";
      back.onclick = () => setLook({ ...st.look, year: null });
      years.appendChild(back);
      YEAR_COL.forEach((col, i) => {
        const y = Y0_RAMP + i, b = E("button", "yr" + (y === l.year ? " on" : ""), String(y).slice(2)) as HTMLButtonElement;
        b.style.background = col;
        b.style.color = i < 4 ? "#fff" : "#111";
        // b.disabled = l.src === "ours" && y < 2018;
        b.title = y === l.year ? "back to every year" : `open ${y}`;
        b.onclick = () => setLook({ ...st.look, year: y === l.year ? null : y });
        years.appendChild(b);
      });
      chips.before(years);
      const parts = l.src === "ours" ? SEASONS.map(([n, m], i) => [n, m, SEASON_COL[i]]) : [["First half", "Jan-Jun", HALF_COL[0]], ["Second half", "Jul-Dec", HALF_COL[1]]];
      chips.style.gridTemplateColumns = `repeat(${parts.length}, 1fr)`;
      parts.forEach(([n, m, col], i) => {
        const b = E("div", "chip", `${n}<small>${m}</small>`);
        b.style.background = col;
        b.style.color = i === 0 && l.src === "ours" ? "#fff" : "#111";
        b.style.cursor = "default";
        chips.appendChild(b);
      });
      hint.innerHTML =
        l.src === "ours"
          ? `${l.year}'s buildings and dug ground by the quarter it changed, from the decoder. <span style="color:${UNCLEAR}">Gray</span>: no quarter made out. <kbd>[</kbd> <kbd>]</kbd> step the year, <kbd>Esc</kbd> all years.`
          : `${l.year}'s built-up ground by WSF's half-year. <kbd>[</kbd> <kbd>]</kbd> step the year, <kbd>Esc</kbd> all years.`;
    }
    drawZoom();
  }
  function drawZoom() {
    const z = map.getZoom();
    const ze = s2Card.querySelector(".z");
    if (ze) ze.textContent = z.toFixed(1);
    zoomRow.innerHTML =
      `Zoom ${z.toFixed(1)} · reads by itself from zoom ${AUTO_Z}` +
      (z < AUTO_Z ? ` <span class="warn">zoom in to read</span>` : "") +
      `<div class="keys"><span><kbd>Space</kbd> Sentinel-2</span><span><kbd>P</kbd> pair</span><span><kbd>L</kbd> labels</span><span><kbd>Q</kbd> picking</span><span><kbd>H</kbd> fold</span><span><kbd>K</kbd> PNG</span><span><kbd>Shift</kbd><kbd>&larr;</kbd><kbd>&rarr;</kbd> pivot</span></div>`;
  }
  /** Reads the view: the chunks in it scored (those read before come from the worker's and the disk's kept scores). */
  function read() {
    if (map.getZoom() < MIN_ZOOM) {
      drawZoom();
      return;
    }
    const b = map.getBounds();
    st.area = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    st.readId++;
    model.set("foot_ask", JSON.stringify({ area: st.area, t: Date.now() }));
    model.save_changes();
    update();
  }
  function setLook(l: Look) {
    if (l.src === "ours" && l.year != null && l.year < 2018) l = { ...l, year: null };
    st.look = l;
    drawCard();
    codes?.setLook(l);
    progressSoon();
  }
  bOurs.onclick = () => setLook({ ...st.look, src: "ours" });
  bWsf.onclick = () => setLook({ ...st.look, src: "wsf" });
  const setFold = (on: boolean) => {
    st.folded = on;
    card.classList.toggle("folded", on);
    fold.title = on ? "open the card (H)" : "fold the card (H)";
  };
  hd.onclick = () => setFold(!st.folded);

  // ---- the loading bar: the chunks in view on hand
  let progT = 0;
  function progressSoon() {
    clearTimeout(progT);
    progT = window.setTimeout(progress, 150);
  }
  function progress() {
    drawZoom();
    if (!codes || map.getZoom() < MIN_ZOOM) {
      load.classList.remove("on");
      loadTag.classList.remove("on");
      return;
    }
    const w = codes.work();
    const reading = w.reading > 0, decoding = !reading && w.decoding > 0;
    const on = reading || decoding;
    load.classList.toggle("on", on);
    loadTag.classList.toggle("on", on);
    if (!on) return;
    const [d, n] = reading ? [w.readDone, w.readDone + w.reading] : [w.decodeDone, w.decodeDone + w.decoding];
    (load.firstChild as HTMLElement).style.width = ((100 * d) / Math.max(1, n)).toFixed(1) + "%";
    loadTag.innerHTML = reading
      ? `Scoring chunks: ${d} of ${n}, every year 2017 to 2025` + (n > 30 ? ` <span>zoom in to load faster</span>` : "")
      : `Decoding ${st.look.year}'s quarters: ${d} of ${n} chunks`;
    // the work goes on without the map moving: look again
    progressSoon();
  }

  // ---- hover: what each source says about the footprint, or the ground, under the pointer
  type Ring = number[][];
  const inRing = (x: number, y: number, ring: Ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const wsfText = (k: number) => (k >= 2 ? `${2016 + ((k - 1) >> 1)}, ${k % 2 === 0 ? "second half" : "first half"}` : k === 1 ? "built by mid 2016" : "not built-up");
  function mixHtml(m: number[]) {
    const tot = m.reduce((a, b) => a + b, 0);
    if (!tot) return "";
    const parts = [0, 1, 2, 3].map((i) => [m[i], SEASON_COL[i], SEASONS[i][0]] as [number, string, string]).concat([[m[4], UNCLEAR, "unclear"]]).filter((x) => x[0] > 0);
    return (
      `<div class="bar">${parts.map(([n, c]) => `<span style="width:${(100 * n) / tot}%;background:${c}"></span>`).join("")}</div>` +
      `<div class="mix">${parts.map(([n, c, l]) => `<span><i style="background:${c}"></i>${l} ${Math.round((100 * n) / tot)}%</span>`).join("")}</div>`
    );
  }
  let hoverKey = "";
  function footHtml(rings: Ring[], key: string): string {
    if (!codes) return "";
    let W = Infinity, S = Infinity, E2 = -Infinity, N = -Infinity;
    for (const r of rings) for (const [x, y] of r) (W = Math.min(W, x)), (E2 = Math.max(E2, x)), (S = Math.min(S, y)), (N = Math.max(N, y));
    const [p0, q0] = pixelOf(W, N), [p1, q1] = pixelOf(E2, S);
    let pts: { ours: number; bits: number; wsf: number; season: (i: number) => number | undefined; tile: unknown }[] = [];
    for (let py = q0; py <= q1; py++)
      for (let px = p0; px <= p1; px++) {
        const [x, y] = pixelCenter(px, py);
        if (!rings.some((r) => inRing(x, y, r))) continue;
        const c = codes.at(px, py);
        if (c) pts.push(c);
      }
    if (!pts.length) {
      const [px, py] = pixelOf((W + E2) / 2, (S + N) / 2);
      const c = codes.at(px, py);
      if (c) pts = [c];
    }
    if (!pts.length) return `<b>Overture</b><br><span class="dim">not read here yet</span>`;
    // a year opened: its pixels dug that year; else the year most of its pixels were last dug
    const yOpen = st.look.year != null ? st.look.year - YEAR_ORIGIN : -1, bit = yOpen > 0 ? 1 << (yOpen - 1) : 0;
    const lit = yOpen > 0 ? pts.filter((p) => p.bits & bit) : pts.filter((p) => p.ours > 0);
    let ours = yOpen > 0 ? `not dug in ${st.look.year}` : "no digging found";
    if (lit.length) {
      const cnt = new Map<number, number>();
      for (const p of lit) cnt.set(p.ours, (cnt.get(p.ours) ?? 0) + 1);
      const idx = yOpen > 0 ? yOpen : [...cnt].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      ours = String(YEAR_ORIGIN + idx);
      const mine = yOpen > 0 ? lit : lit.filter((p) => p.ours === idx);
      const m = [0, 0, 0, 0, 0];
      let missing = false;
      for (const p of mine) {
        const s = p.season(idx);
        if (s === undefined) missing = true;
        else m[s >= 1 && s <= 4 ? s - 1 : 4]++;
      }
      if (!QUARTERS) {
        // quarters off: every year its pixels were last dug in, earliest first
        if (yOpen <= 0) ours = [...cnt.keys()].sort((a, b) => a - b).map((i) => YEAR_ORIGIN + i).join(", ");
      } else if (missing) {
        ours += ` <span class="dim">decoding the quarters...</span>`;
        const tiles = [...new Set(mine.map((p) => p.tile))] as Parameters<NonNullable<typeof codes>["seasonsReady"]>[0];
        codes.seasonsReady(tiles, idx).then(() => {
          if (hoverKey === key) showTip(footHtml(rings, key));
        });
      } else ours += mixHtml(m);
    }
    // WSF commented out for now
    // const ks = pts.map((p) => p.wsf).filter((k) => k >= 1);
    // return `<b>Overture</b><br>Ours (dug or graded): ${ours}<br>WSF (built-up): ${wsfText(ks.length ? Math.min(...ks) : 0)}`;
    return `<b>Overture</b><br>Dug or graded: ${ours}`;
  }
  let lastPoint = { x: 0, y: 0 };
  function showTip(html: string) {
    if (!html) {
      tip.style.display = "none";
      return;
    }
    tip.innerHTML = html;
    tip.style.display = "block";
    const r = root.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    // the pointer is in the map's own box, which the pair moves to the right half
    const px = lastPoint.x + mapEl.offsetLeft, py = lastPoint.y + mapEl.offsetTop;
    let x = px + 14, y = py + 14;
    if (x + tw > r.width - 8) x = px - tw - 14;
    if (y + th > r.height - 8) y = py - th - 14;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  map.on("mousemove", (e) => {
    lastPoint = e.point;
    if (!st.picking || !codes || !map.getLayer("foot")) return setHi(null);
    if (footBatch) {
      const info = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 2, layerIds: ["foot-poly"] });
      if (info && info.index >= 0) {
        const key = `a:${info.index}`;
        setHi(footHi(info.index));
        hoverKey = key;
        showTip(footHtml([ringOf(info.index)], key));
        return;
      }
    }
    setHi(null);
    // the building tiles are only the layers' anchor now: their features are not asked
    const f = null as { geometry: { type: string; coordinates: unknown }; id?: unknown } | null;
    if (f) {
      const g = f.geometry as { type: string; coordinates: unknown };
      const rings: Ring[] = g.type === "Polygon" ? [(g.coordinates as Ring[])[0]] : g.type === "MultiPolygon" ? (g.coordinates as Ring[][]).map((p) => p[0]) : [];
      const key = `f:${f.id ?? JSON.stringify(rings[0]?.[0])}`;
      hoverKey = key;
      showTip(footHtml(rings, key));
      return;
    }
    const [px, py] = pixelOf(e.lngLat.lng, e.lngLat.lat);
    const c = codes.at(px, py);
    // WSF commented out for now: only ours' ground answers
    // if (!c || (!c.ours && c.wsf < 2)) {
    const yOpen = st.look.year != null ? st.look.year - YEAR_ORIGIN : -1;
    if (!c || !c.ours || (yOpen > 0 && !(c.bits & (1 << (yOpen - 1))))) {
      hoverKey = "";
      showTip("");
      return;
    }
    const key = `p:${px}:${py}`;
    hoverKey = key;
    let ours = "no digging found";
    if (c.ours) {
      const yi = yOpen > 0 ? yOpen : c.ours;
      const s = c.season(yi);
      ours = String(YEAR_ORIGIN + yi);
      if (!QUARTERS) {
        // quarters off: the year alone
      } else if (s === undefined) {
        // its quarters not decoded yet: asked for, and the tooltip told when they come
        ours += ` <span class="dim">decoding the quarters...</span>`;
        codes.seasonsReady([c.tile] as Parameters<NonNullable<typeof codes>["seasonsReady"]>[0], yi).then(() => {
          if (hoverKey !== key || !codes) return;
          const s2 = codes.at(px, py)?.season(yi);
          showTip(`<b>No footprint</b><br>Dug or graded: ${YEAR_ORIGIN + yi}` + (s2 && s2 >= 1 && s2 <= 4 ? `, ${SEASONS[s2 - 1][0]} (${SEASONS[s2 - 1][1]})` : ", quarter unclear"));
        });
      } else ours += s >= 1 && s <= 4 ? `, ${SEASONS[s - 1][0]} (${SEASONS[s - 1][1]})` : ", quarter unclear";
    }
    showTip(`<b>No footprint</b><br>Dug or graded: ${ours}`);
  });
  map.on("click", (e) => pin(e.point));
  mapEl.addEventListener("mouseleave", () => {
    hoverKey = "";
    showTip("");
    setHi(null);
  });

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
  // the PNG carries no cards: the legend is drawn on it at the map's top left (paired, the right half's), and paired
  // the imagery's year and day at the left half's; text on the map with a soft shadow, no box (LinkedIn's rule)
  const FONT = "'Instrument Sans', system-ui, sans-serif";
  function drawLegend(g: CanvasRenderingContext2D, x0: number, y0: number, k: number) {
    g.save();
    g.shadowColor = "rgba(0,0,0,.75)";
    g.shadowBlur = 6 * k;
    g.textBaseline = "middle";
    const mid = y0 + 10 * k;
    g.font = `600 ${15 * k}px ${FONT}`;
    g.fillStyle = "#e6e9ec";
    g.fillText("Dug by year", x0, mid);
    let x = x0 + g.measureText("Dug by year").width + 14 * k;
    g.font = `500 ${13 * k}px ${FONT}`;
    g.fillStyle = "#c9cfd5";
    const first = String(Y0_RAMP), last = String(Y0_RAMP + YEAR_COL.length - 1);
    g.fillText(first, x, mid);
    x += g.measureText(first).width + 8 * k;
    YEAR_COL.forEach((col) => {
      g.fillStyle = col;
      g.fillRect(x, mid - 7 * k, 20 * k, 14 * k);
      x += 22 * k;
    });
    g.fillStyle = "#c9cfd5";
    g.fillText(last, x + 6 * k, mid);
    g.restore();
  }
  function drawYear(g: CanvasRenderingContext2D, x0: number, y0: number, k: number) {
    const c = map.getCenter(), d = s2?.dateAt(st.s2Year, c.lng, c.lat) ?? "";
    g.save();
    g.shadowColor = "rgba(0,0,0,.75)";
    g.shadowBlur = 6 * k;
    g.textBaseline = "top";
    g.font = `600 ${34 * k}px ${FONT}`;
    g.fillStyle = "#e6e9ec";
    g.fillText(String(st.s2Year), x0, y0);
    g.font = `500 ${13 * k}px ${FONT}`;
    g.fillStyle = "#c9cfd5";
    g.fillText("Sentinel-2" + (d ? ` · ${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : ""), x0, y0 + 40 * k);
    g.restore();
  }
  async function snap() {
    if (snapping) return;
    snapping = true;
    note(`Exporting a ${SNAP_X}x PNG...`);
    // paired, both halves side by side with the divider between them, as on screen
    const maps: [maplibregl.Map, InstanceType<typeof MapboxOverlay>][] = st.pair && map2 && overlay2 ? [[map2, overlay2], [map, overlay]] : [[map, overlay]];
    try {
      for (const [m, ov] of maps) {
        m.setPixelRatio(SNAP_X);
        deckFollow(m, ov);
      }
      const shots = await Promise.all(maps.map(([m]) => grab(m)));
      // the ratio drawn, lower than SNAP_X where maxCanvasSize held the canvas back
      const x = shots[shots.length - 1].width / map.getContainer().clientWidth;
      const line = shots.length > 1 ? Math.round(2 * x) : 0;
      const out = document.createElement("canvas");
      out.width = shots.reduce((w, c) => w + c.width, 0) + line;
      out.height = Math.max(...shots.map((c) => c.height));
      const g = out.getContext("2d")!;
      let at = 0;
      shots.forEach((c, i) => {
        g.drawImage(c, at, 0);
        at += c.width;
        if (i < shots.length - 1) {
          g.fillStyle = "rgba(255,255,255,.35)";
          g.fillRect(at, 0, line, out.height);
          at += line;
        }
      });
      const pad = 14 * x;
      drawLegend(g, (shots.length > 1 ? shots[0].width + line : 0) + pad, pad, x);
      if (shots.length > 1) drawYear(g, pad, pad, x);
      const png = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (!png) throw new Error("the canvas gave no PNG");
      const small = await forLinkedIn(out);
      const c = map.getCenter();
      const name =
        `z${map.getZoom().toFixed(1)}_${c.lat.toFixed(4)}_${c.lng.toFixed(4)}` +
        (st.pair ? `_pair-s2-${st.s2Year}` : s2Shown() ? `_s2-${st.s2Year}` : "") +
        `_${+x.toFixed(1)}x`;
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
    if (e.code === "Space") {
      if (!e.repeat) setS2(true);
    } else if (k === "p" || k === "P") setPair(!st.pair);
    else if ((k === "[" || k === "]") && imgShown()) stepS2(k === "]" ? 1 : -1);
    else if ((k === "b" || k === "B") && imgShown()) {
      // from any year to the latest, then back and forth between the first and the latest
      const last = S2_YEARS.length - 1, i = S2_YEARS.indexOf(st.s2Year);
      stepS2((i === last ? 0 : last) - i);
    }
    else if (k === "l" || k === "L") {
      // the basemap's labels on or off
      st.labels = !st.labels;
      for (const l of map.getStyle().layers) if (l.type === "symbol") map.setLayoutProperty(l.id, "visibility", st.labels ? "visible" : "none");
      note(st.labels ? "Labels on" : "Labels off");
    } else if (k === "q" || k === "Q") {
      // picking and the tooltip on or off
      st.picking = !st.picking;
      if (!st.picking) {
        hoverKey = "";
        showTip("");
      }
      note(st.picking ? "Picking on" : "Picking off");
    }
    else if (QUARTERS && (k === "[" || k === "]") && st.look.year != null) {
      const lo = st.look.src === "ours" ? 2018 : Y0_RAMP, hi = Y0_RAMP + YEAR_COL.length - 1;
      setLook({ ...st.look, year: Math.max(lo, Math.min(hi, st.look.year + (k === "]" ? 1 : -1))) });
    }
    // WSF commented out for now
    // else if (k === "c" || k === "C") setLook({ ...st.look, src: st.look.src === "ours" ? "wsf" : "ours" });
    else if (k === "h" || k === "H") setFold(!st.folded);
    else if (k === "s" || k === "S") {
      // the patches filled by the year's imagery, or by the year raster's colors
      if (st.pair) st.winPair = !st.winPair;
      else st.winMain = !st.winMain;
      root.classList.toggle("yrs", rasterShown());
      render();
    }
    else if (k === "o" || k === "O") {
      // the patches' outlines on or off
      st.lines = !st.lines;
      render();
    }
    else if ((k === "n" || k === "N") && imgShown() && s2) {
      // the year's next look: another of its clear scenes
      s2.next(st.s2Year);
      drawS2Card();
      render();
    }
    else if (k === "x" || k === "X") {
      st.fit = !st.fit;
      sizes();
    } else if (k === "f" || k === "F") fullScreen();
    else if (k === "k" || k === "K") snap();
    else if (k === "/") q.focus();
    else if (k === "Escape") {
      if (st.pair && spotMask) {
        spotMask = null;
        spotKey = "";
        setL2();
      } else if (st.look.year != null) setLook({ ...st.look, year: null });
      else if (st.fit) {
        st.fit = false;
        sizes();
      }
    } else if (e.shiftKey && (k === "ArrowLeft" || k === "ArrowRight")) {
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
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" && st.holding) setS2(false);
  };
  window.addEventListener("keyup", onKeyUp);
  const onBlur = () => st.holding && setS2(false);
  window.addEventListener("blur", onBlur);
  // while the imagery shows, the wheel steps its year instead of zooming
  let wheelAcc = 0, lastStep = 0;
  root.addEventListener(
    "wheel",
    (e) => {
      if (!st.holding) return;
      e.preventDefault();
      e.stopPropagation();
      wheelAcc += e.deltaY;
      const now = performance.now();
      if (Math.abs(wheelAcc) >= 40 && now - lastStep > 140) {
        stepS2(wheelAcc > 0 ? 1 : -1);
        wheelAcc = 0;
        lastStep = now;
      }
    },
    { capture: true, passive: false },
  );
  map.on("moveend", progressSoon);
  map.on("moveend", () => {
    if (imgShown()) {
      s2?.discover(st.s2Year);
      drawS2Card();
      render();
    }
  });
  // close enough in, every move asks the model again once the map has settled: a view that reaches past the area read
  // is read whole (footprints too); one inside it asks only the model's chunks again, so a chunk that came back empty
  // is tried once more (the ones scored before come from the worker's kept scores, so quickly) while the footprints
  // already read stay
  let autoT = 0;
  map.on("moveend", () => {
    clearTimeout(autoT);
    if (map.getZoom() < AUTO_Z || !ready) return;
    const b = map.getBounds(), a = st.area;
    const inside = a && b.getWest() >= a[0] && b.getEast() <= a[2] && b.getSouth() >= a[1] && b.getNorth() <= a[3];
    autoT = window.setTimeout(
      inside
        ? () => {
            st.readId++;
            update();
          }
        : read,
      500,
    );
  });
  map.on("zoom", drawZoom);


  map.on("load", async () => {
    // the basemap's own buildings off; the data over its roads, under its labels
    for (const l of map.getStyle().layers) if (/building/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
    // and its roads below side streets (Carto's "service": parking lot aisles, driveways, alleys; "path" and "track"),
    // on the ground, in tunnels and on bridges: they draw over the raster and would only crowd it
    for (const l of map.getStyle().layers) if (/(^|_)(service|path)(_|$)/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
    const ls = map.getStyle().layers;
    const lastNon = ls.reduce((a, l, i) => (l.type !== "symbol" ? i : a), -1);
    const below = ls.slice(lastNon + 1).find((l) => l.type === "symbol")?.id;
    groundId = ls.find((l) => l.type === "line" && /aeroway|tunnel|road|bridge|rail|transport/.test(l.id))?.id ?? "foot";
    map.addSource("overture", {
      type: "vector",
      url: `pmtiles://https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${cfg.release}/buildings.pmtiles`,
    });
    map.addLayer(
      {
        id: "foot",
        type: "line",
        source: "overture",
        "source-layer": "building",
        // not drawn: the footprints are the kernel's GeoArrow; this layer only holds the deck layers' place in the order
        layout: { visibility: "none" },
        paint: { "line-color": FOOT, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 16, 0.8, 18, 1], "line-opacity": 0.85 },
      },
      below,
    );
    s2 = createS2(map, () => {
      drawS2Card();
      render();
    });
    // the card is always there; the imagery shows through the patches from the start
    s2.discover(st.s2Year);
    drawS2Card();
    codes = await createCodesLayer(world as unknown as WorldModel, await decoderP, () => update());
    loadFoot();
    codes.setLook(st.look);
    ready = true;
    // the first view reads at once
    read();
  });

  drawCard();
  sizes();
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("fullscreenchange", onFs);
    document.documentElement.classList.remove(FIT_CLS);
    try {
      map2?.remove();
      map.remove();
    } catch {
      // gone already
    }
  };
}

export default { render };
