import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import "./mesh-sampler";

import { MapLibreOverlay as MapboxOverlay } from "@deck.gl/maplibre";
import { GeoArrowPolygonLayer } from "@geoarrow/deck.gl-layers";
import * as arrow from "apache-arrow";
import * as maplibregl from "maplibre-gl";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";
import { Protocol } from "pmtiles";

import { MIN_ZOOM, YEAR_ORIGIN } from "./aef";
import { createCodesLayer, HALF_COL, type Look, pixelCenter, pixelOf, SEASON_COL, UNCLEAR, Y0_RAMP, YEAR_COL } from "./codes-layer";
import decoderBin from "./decoder_month.bin?url";
import { colorData, type FootJoin, joinColors, joinPixels, ringOf as footRing } from "./foot";
import { createS2, S2_YEARS } from "./eg-s2";
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
// a footprint's outline: faint, so the filled ones carry the map and the rest only say a building is there
// (halfway between the first cyan outlines, 79 214 255 at 217, and a faint gray, 230 233 236 at 80)
const FOOT_LINE: [number, number, number, number] = [154, 223, 245, 150];
const FIT_CLS = "sm-fit-on";

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

  const st = { look: { src: "ours", year: null } as Look, fit: true, folded: false, area: null as [number, number, number, number] | null, readId: 0, labels: true, picking: true, s2On: false, holding: false, s2Year: S2_YEARS[S2_YEARS.length - 1] };
  const E = (t: string, c?: string, h?: string) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (h != null) e.innerHTML = h;
    return e;
  };
  const root = E("div", "sm"), mapEl = E("div", "map");
  const load = E("div", "load", "<i></i>"), loadTag = E("div", "loadtag");
  root.append(mapEl, load, loadTag);
  el.appendChild(root);

  // ---- the card
  const card = E("div", "card");
  const hd = E("div", "hd");
  const hdT = E("div", "ht");
  const fold = E("button", "fold", "&#9662;") as HTMLButtonElement;
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
  body.append(chips, hint, zoomRow);
  card.append(hd, body);
  root.appendChild(card);

  // ---- search (Photon, over OpenStreetMap)
  const sBox = E("div", "search"), q = E("input") as HTMLInputElement, hits = E("div", "hits");
  q.placeholder = "Search a place  ( / )";
  q.spellcheck = false;
  sBox.append(q, hits);
  root.appendChild(sBox);
  const tip = E("div", "tip");
  const toast = E("div", "toast");
  const s2Tag = E("div", "s2tag");
  root.append(tip, toast, s2Tag);
  let toastT = 0;
  const note = (t: string) => {
    toast.textContent = t;
    toast.classList.add("on");
    clearTimeout(toastT);
    toastT = window.setTimeout(() => toast.classList.remove("on"), 1600);
  };

  // ---- the map
  const map = new maplibregl.Map({
    container: mapEl,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [cfg.home.lon, cfg.home.lat],
    zoom: cfg.home.zoom,
    hash: true,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false,
  });
  // the credits folded into their i until it is clicked (maplibre opens a compact one on a wide map)
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "Overture Maps (ODbL) · WSF Tracker, DLR and MindEarth (CC BY 3.0 IGO) · AlphaEarth Foundations, Google DeepMind (CC BY 4.0) · TESSERA v1.1, University of Cambridge",
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
  new ResizeObserver(() => map.resize()).observe(root);

  // ---- the footprints of the area read, as GeoArrow (a polygon a row; `fid` the footprint), joined to the pixels
  let footBatch: arrow.RecordBatch | null = null;
  let join: FootJoin | null = null;
  let fill: ReturnType<typeof colorData> | null = null;
  let fillN = 0;
  function loadFoot() {
    const b = model.get("foot") as DataView | ArrayBuffer | Uint8Array | null;
    if (!b || !(b as ArrayBuffer).byteLength || !codes) return;
    const bytes = b instanceof DataView ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b instanceof Uint8Array ? b : new Uint8Array(b);
    footBatch = arrow.tableFromIPC(bytes).batches[0] ?? null;
    join = footBatch ? joinPixels(footBatch) : null;
    fill = null;
    codes.setFootMask(join ? join.mask : null);
    recolor();
  }
  model.on("change:foot", loadFoot);
  model.on("change:foot_status", () => note(String(model.get("foot_status") || "")));
  const ringOf = (row: number): number[][] => footRing(footBatch!, row);

  // each footprint's fill from the pixels under it, again as chunks and quarters come in (a few times a second at most)
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
    fill = colorData(joinColors(join, at, st.look.year, (y) => YEAR_RGB[y - Y0_RAMP] ?? [0, 0, 0], QUARTER_RGB, UNCLEAR_RGB), join.rows);
    fillN++;
    render();
  }

  // ---- the data layer
  let codes: Awaited<ReturnType<typeof createCodesLayer>> | null = null;
  let s2: ReturnType<typeof createS2> | null = null;
  function setS2(on: boolean, hold = false) {
    if (hold) st.holding = on;
    else st.s2On = on;
    if (s2Shown()) s2?.discover(st.s2Year);
    drawS2Tag();
    render();
  }
  function stepS2(d: number) {
    const i = Math.max(0, Math.min(S2_YEARS.length - 1, S2_YEARS.indexOf(st.s2Year) + d));
    if (S2_YEARS[i] === st.s2Year) return;
    st.s2Year = S2_YEARS[i];
    s2?.discover(st.s2Year);
    drawS2Tag();
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
  // the imagery shown: while space is held, or switched on with P
  const s2Shown = () => st.holding || st.s2On;
  function drawS2Tag() {
    s2Tag.classList.toggle("on", s2Shown());
    s2Tag.innerHTML = `Sentinel-2 <b>${st.s2Year}</b> <span>Earth Genome yearly mosaic · scroll or [ ] for the year</span>`;
  }
  function render() {
    if (!ready || !codes) return;
    const layers: unknown[] = [];
    // the imagery under everything of ours: our raster and the buildings' fills step aside while it shows, the
    // outlines stay on it
    if (s2) layers.push(...s2.layers(st.s2Year, s2Shown(), "foot"));
    if (!st.area) {
      overlay.setProps({ layers: layers as never });
      return;
    }
    layers.push(
      codes.layer({
        minZoom: MIN_ZOOM,
        area: st.area,
        readId: st.readId,
        visible: !s2Shown(),
        beforeId: "foot",
        onTile: () => {
          progressSoon();
          joinSoon();
        },
      }),
    );
    if (footBatch)
      layers.push(
        // the buildings: filled in their year's color (a year opened: their quarter's) where the join gives one, a
        // faint outline each; over the raster, under the labels
        new GeoArrowPolygonLayer({
          id: "foot-poly",
          data: footBatch,
          getPolygon: footBatch.getChild("geometry")!.data[0] as never,
          filled: !s2Shown(),
          stroked: true,
          getFillColor: (fill ?? [0, 0, 0, 0]) as never,
          getLineColor: FOOT_LINE,
          // in meters, held between a hair and one pixel: zoomed out the outlines thin instead of adding up to a glare
          getLineWidth: 1.25,
          lineWidthUnits: "meters",
          lineWidthMinPixels: 0.25,
          lineWidthMaxPixels: 1,
          // triangulated here, not in a worker fetched from a CDN
          earcutWorkerUrl: null,
          pickable: true,
          updateTriggers: { getFillColor: fillN },
          // read by the MapLibre overlay
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
      hdT.innerHTML = "<b>Footprints by year</b>";
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
    zoomRow.innerHTML =
      `Zoom ${z.toFixed(1)} · reads from zoom ${MIN_ZOOM} · <kbd>Enter</kbd> reads this view` +
      (z < MIN_ZOOM ? ` <span class="warn">zoom in to read</span>` : "") +
      `<div class="keys"><kbd>Space</kbd> or <kbd>P</kbd> Sentinel-2 · <kbd>L</kbd> labels · <kbd>Q</kbd> picking · <kbd>H</kbd> fold · <kbd>/</kbd> search</div>`;
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
    const [W, S, E2, N] = st.area;
    (map.getSource("area") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[W, N], [E2, N], [E2, S], [W, S], [W, N]] },
    });
    outline();
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
    fold.innerHTML = on ? "&#9656;" : "&#9662;";
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
    if (!pts.length) return `<b>Footprint</b><br><span class="dim">not read here yet</span>`;
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
        // quarters off: the year alone
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
    // return `<b>Footprint</b><br>Ours (dug or graded): ${ours}<br>WSF (built-up): ${wsfText(ks.length ? Math.min(...ks) : 0)}`;
    return `<b>Footprint</b><br>Dug or graded: ${ours}`;
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
    let x = lastPoint.x + 14, y = lastPoint.y + 14;
    if (x + tw > r.width - 8) x = lastPoint.x - tw - 14;
    if (y + th > r.height - 8) y = lastPoint.y - th - 14;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  map.on("mousemove", (e) => {
    lastPoint = e.point;
    if (!st.picking) return;
    if (!codes || !map.getLayer("foot")) return;
    if (footBatch) {
      const info = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 2, layerIds: ["foot-poly"] });
      if (info && info.index >= 0) {
        const key = `a:${info.index}`;
        hoverKey = key;
        showTip(footHtml([ringOf(info.index)], key));
        return;
      }
    }
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
  mapEl.addEventListener("mouseleave", () => {
    hoverKey = "";
    showTip("");
  });

  // ---- search
  type Hit = { name: string; sub: string; center: [number, number] };
  let found: Hit[] = [], sel = 0, sT = 0;
  const showHits = () => {
    hits.replaceChildren();
    found.forEach((h, i) => {
      const r = E("div", "hit" + (i === sel ? " sel" : ""));
      r.textContent = h.name;
      const s = E("small");
      s.textContent = h.sub;
      r.appendChild(s);
      r.onmousedown = (ev) => {
        ev.preventDefault();
        go(h);
      };
      hits.appendChild(r);
    });
    hits.style.display = found.length ? "block" : "none";
  };
  q.oninput = () => {
    clearTimeout(sT);
    sT = window.setTimeout(async () => {
      const t = q.value.trim();
      if (t.length < 2) {
        found = [];
        showHits();
        return;
      }
      try {
        const c = map.getCenter();
        const j = await (await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(t)}&limit=6&lat=${c.lat}&lon=${c.lng}`)).json();
        found = (j.features || []).map((f: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }) => ({
          name: f.properties.name || f.properties.city || "",
          sub: [f.properties.city, f.properties.state, f.properties.country].filter((v) => v && v !== f.properties.name).join(", "),
          center: f.geometry.coordinates,
        }));
        sel = 0;
        showHits();
      } catch {
        // a search let go for the next one
      }
    }, 250);
  };
  const go = (h: Hit) => {
    found = [];
    showHits();
    q.blur();
    map.flyTo({ center: h.center, zoom: 13.5 });
  };
  q.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, Math.min(found.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      showHits();
    } else if (e.key === "Enter" && found[sel]) go(found[sel]);
    else if (e.key === "Escape") {
      q.value = "";
      found = [];
      showHits();
      q.blur();
    }
  };
  q.onblur = () => window.setTimeout(() => (hits.style.display = "none"), 150);

  // ---- keys
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target === q) return;
    const k = e.key;
    if (e.code === "Space") {
      if (!e.repeat) setS2(true, true);
    } else if (k === "p" || k === "P") setS2(!st.s2On);
    else if ((k === "[" || k === "]") && s2Shown()) stepS2(k === "]" ? 1 : -1);
    else if (k === "Enter") read();
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
    else if (k === "x" || k === "X") {
      st.fit = !st.fit;
      sizes();
    } else if (k === "f" || k === "F") fullScreen();
    else if (k === "/") q.focus();
    else if (k === "Escape") {
      if (st.look.year != null) setLook({ ...st.look, year: null });
      else if (st.fit) {
        st.fit = false;
        sizes();
      }
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
    if (e.code === "Space" && st.holding) setS2(false, true);
  };
  window.addEventListener("keyup", onKeyUp);
  const onBlur = () => st.holding && setS2(false, true);
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
    if (s2Shown()) {
      s2?.discover(st.s2Year);
      render();
    }
  });
  // the read's outline only once the view reaches past it (never on the view Enter was pressed on)
  function outline() {
    if (!map.getLayer("area") || !st.area) return;
    const b = map.getBounds(), [W, S, E2, N] = st.area, tol = (E2 - W) * 0.002;
    const inside = b.getWest() >= W - tol && b.getEast() <= E2 + tol && b.getSouth() >= S - tol && b.getNorth() <= N + tol;
    map.setLayoutProperty("area", "visibility", inside ? "none" : "visible");
  }
  map.on("move", outline);
  map.on("zoom", drawZoom);


  map.on("load", async () => {
    // the basemap's own buildings off; the data over its roads, under its labels
    for (const l of map.getStyle().layers) if (/building/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
    const ls = map.getStyle().layers;
    const lastNon = ls.reduce((a, l, i) => (l.type !== "symbol" ? i : a), -1);
    const below = ls.slice(lastNon + 1).find((l) => l.type === "symbol")?.id;
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
    map.addSource("area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "area", type: "line", source: "area", paint: { "line-color": "rgba(230,233,236,0.45)", "line-width": 1, "line-dasharray": [3, 3] } }, below);
    s2 = createS2(map, () => render());
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
      map.remove();
    } catch {
      // gone already
    }
  };
}

export default { render };
