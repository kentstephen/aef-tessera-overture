import * as arrow from "apache-arrow";

import { RES, X0, Y0, YEAR_ORIGIN } from "./aef";

/**
 * The Overture footprints of the area read (the kernel's GeoArrow: a geoarrow.polygon a row, its exterior ring only)
 * joined to the 10 m pixels under them. Each row's pixels are the AlphaEarth pixels whose centers fall inside it (the
 * one under its middle when none does). From them, each footprint's year: the one most of its dug pixels were last
 * dug in.
 */

export type FootJoin = {
  rows: number;
  /** each row's pixels: px[start[r] .. start[r + 1]), py the same */
  start: Int32Array;
  px: Int32Array;
  py: Int32Array;
};

/** The polygon column's raw arrays: polygon -> ring offsets, ring -> coordinate offsets, the coordinates (x, y). */
function polygonArrays(batch: arrow.RecordBatch) {
  const poly = batch.getChild("geometry")!.data[0];
  const ring = poly.children[0];
  const xy = ring.children[0].children[0];
  return {
    geomOff: poly.valueOffsets as Int32Array,
    ringOff: ring.valueOffsets as Int32Array,
    coords: xy.values as Float64Array,
    base: poly.offset,
  };
}

/** A row's exterior ring as [lon, lat] pairs. */
export function ringOf(batch: arrow.RecordBatch, row: number): number[][] {
  const { geomOff, ringOff, coords, base } = polygonArrays(batch);
  const r = geomOff[base + row];
  const out: number[][] = [];
  for (let k = ringOff[r]; k < ringOff[r + 1]; k++) out.push([coords[2 * k], coords[2 * k + 1]]);
  return out;
}

export function joinPixels(batch: arrow.RecordBatch): FootJoin {
  const { geomOff, ringOff, coords, base } = polygonArrays(batch);
  const rows = batch.numRows;
  const start = new Int32Array(rows + 1);
  const pxs: number[] = [], pys: number[] = [];
  for (let row = 0; row < rows; row++) {
    start[row] = pxs.length;
    const r = geomOff[base + row], k0 = ringOff[r], k1 = ringOff[r + 1];
    let W = Infinity, S = Infinity, E = -Infinity, N = -Infinity;
    for (let k = k0; k < k1; k++) {
      const x = coords[2 * k], y = coords[2 * k + 1];
      if (x < W) W = x;
      if (x > E) E = x;
      if (y < S) S = y;
      if (y > N) N = y;
    }
    if (!isFinite(W)) continue;
    const p0 = Math.floor((W - X0) / RES), p1 = Math.floor((E - X0) / RES), q0 = Math.floor((Y0 - N) / RES), q1 = Math.floor((Y0 - S) / RES);
    let found = false;
    for (let py = q0; py <= q1; py++) {
      const cy = Y0 - (py + 0.5) * RES;
      for (let px = p0; px <= p1; px++) {
        const cx = X0 + (px + 0.5) * RES;
        // the pixel's center in the ring (even-odd)
        let inside = false;
        for (let k = k0, j = k1 - 1; k < k1; j = k++) {
          const xi = coords[2 * k], yi = coords[2 * k + 1], xj = coords[2 * j], yj = coords[2 * j + 1];
          if (yi > cy !== yj > cy && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) {
          pxs.push(px);
          pys.push(py);
          found = true;
        }
      }
    }
    if (!found) {
      pxs.push(Math.floor(((W + E) / 2 - X0) / RES));
      pys.push(Math.floor((Y0 - (S + N) / 2) / RES));
    }
  }
  start[rows] = pxs.length;
  const px = Int32Array.from(pxs), py = Int32Array.from(pys);
  return { rows, start, px, py };
}

type At = (px: number, py: number) => { ours: number; bits: number; season: (idx: number) => number | undefined } | null;

/**
 * Each footprint's fill (RGBA, a row each; alpha 0 for none): all years, the year most of its dug pixels were last
 * dug in; a year opened, the quarter most of its pixels dug that year changed in (gray where not made out). A footprint
 * with no pixel on hand yet, or none dug, is not filled.
 */
export function joinColors(j: FootJoin, at: At, year: number | null, yearRgb: (y: number) => number[], quarterRgb: number[][], unclear: number[]): Uint8Array {
  const out = new Uint8Array(4 * j.rows);
  const yOpen = year != null ? year - YEAR_ORIGIN : -1, bit = yOpen > 0 ? 1 << (yOpen - 1) : 0;
  const cnt = new Int32Array(16);
  for (let r = 0; r < j.rows; r++) {
    cnt.fill(0);
    let any = false;
    for (let i = j.start[r]; i < j.start[r + 1]; i++) {
      const c = at(j.px[i], j.py[i]);
      if (!c) continue;
      if (yOpen > 0) {
        if (!(c.bits & bit)) continue;
        const s = c.season(yOpen);
        if (s === undefined) continue;
        cnt[s >= 1 && s <= 4 ? s : 5]++;
        any = true;
      } else if (c.ours) {
        cnt[c.ours]++;
        any = true;
      }
    }
    if (!any) continue;
    let best = 0;
    for (let k = 1; k < 16; k++) if (cnt[k] > cnt[best]) best = k;
    const rgb = yOpen > 0 ? (best >= 1 && best <= 4 ? quarterRgb[best - 1] : unclear) : yearRgb(YEAR_ORIGIN + best);
    out[4 * r] = rgb[0];
    out[4 * r + 1] = rgb[1];
    out[4 * r + 2] = rgb[2];
    out[4 * r + 3] = 255;
  }
  return out;
}

/** RGBA a row as the GeoArrow layers take a color column. */
export function colorData(rgba: Uint8Array, rows: number) {
  const child = arrow.makeData({ type: new arrow.Uint8(), length: rows * 4, nullCount: 0, data: rgba });
  return arrow.makeData({ type: new arrow.FixedSizeList(4, new arrow.Field("rgba", new arrow.Uint8(), false)), length: rows, nullCount: 0, child });
}
