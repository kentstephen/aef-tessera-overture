import { RES, X0, Y0 } from "./aef";

/**
 * Patches of dug ground and their outlines, as aef-tessera-earthwork's year map draws them (its earthwork.ts on the
 * year-map branch: segmentAt with `joined`, PATCH_GAP, runsFrom and traceOutline, copied): every pixel found dug joined
 * to its neighbors by side or corner, or across a gap of PATCH_GAP pixels, whatever its year; the outline only the
 * outer edge, holes filled, with the runs along a row or a column merged into long edges.
 */

/**
 * Found ground this many pixels apart or less still joins into one patch (a building and its graded lot with a road or
 * a curb between them): 1, ten meters, one pixel not found between them.
 */
export const PATCH_GAP = 1;

type Run = [number, number];
/** A row's columns (unsorted) as runs [start, end), row by row. */
function runsFrom(xsOf: Map<number, number[]>) {
  const runsOf = new Map<number, Run[]>();
  for (const [y, xs] of xsOf) {
    xs.sort((u, v) => u - v);
    const rs: Run[] = [];
    for (const x of xs) {
      const r = rs[rs.length - 1];
      if (r && r[1] === x) r[1] = x + 1;
      else rs.push([x, x + 1]);
    }
    runsOf.set(y, rs);
  }
  return runsOf;
}

/**
 * The outer outline of pixels given row by row as runs [start, end) of the whole grid's columns, holes filled: edges
 * [lon, lat, lon, lat] (runs along a row or a column merged), and the rows' runs with their holes filled.
 */
function traceOutline(runsOf: Map<number, Run[]>) {
  const gapsOf = new Map<number, { s: number; e: number; id: number }[]>();
  const parent = [0]; // gap ids from 1; 0 is the outside
  for (const [y, rs] of runsOf) {
    const gs = [];
    for (let i = 1; i < rs.length; i++) gs.push({ s: rs[i - 1][1], e: rs[i][0], id: parent.push(parent.length) - 1 });
    gapsOf.set(y, gs);
  }
  // a gap is a hole unless it reaches the outside through the gaps above and below it (by side, the segment being
  // joined by corner too); holes are filled, so only the outer edge is drawn
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => void (parent[find(i)] = find(j));
  for (const [y, gs] of gapsOf)
    for (const ny of [y - 1, y + 1]) {
      const rn = runsOf.get(ny), gn = gapsOf.get(ny) ?? [];
      let j = 0;
      for (const g of gs) {
        if (!rn || g.s < rn[0][0] || g.e > rn[rn.length - 1][1]) join(g.id, 0);
        while (j < gn.length && gn[j].e <= g.s) j++;
        for (let k = j; k < gn.length && gn[k].s < g.e; k++) join(g.id, gn[k].id);
      }
    }
  const filled = new Map<number, Run[]>();
  for (const [y, rs] of runsOf) {
    const gs = gapsOf.get(y)!, f: Run[] = [[rs[0][0], rs[0][1]]];
    for (let i = 1; i < rs.length; i++) {
      if (find(gs[i - 1].id) !== find(0)) f[f.length - 1][1] = rs[i][1];
      else f.push([rs[i][0], rs[i][1]]);
    }
    filled.set(y, f);
  }
  // the parts of runs a not covered by runs b
  const minus = (a: Run[], b: Run[] | undefined, f: (s: number, e: number) => void) => {
    let j = 0;
    for (const [s0, e] of a) {
      let s = s0;
      while (b && j < b.length && b[j][1] <= s) j++;
      for (let k = j; b && k < b.length && b[k][0] < e; k++) {
        if (b[k][0] > s) f(s, b[k][0]);
        s = Math.max(s, b[k][1]);
      }
      if (s < e) f(s, e);
    }
  };
  // the outline: a row's top (or bottom) where the row beyond does not cover it, and each run's two ends, a column
  // line's runs merged. A column line l is the left of column l; the side's sign keeps a left and a right on the
  // same line apart where they meet only at a corner
  const cols = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, line: number, at: number) => {
    const a = m.get(line);
    if (a) a.push(at);
    else m.set(line, [at]);
  };
  const lonOf = (gx: number) => X0 + gx * RES, latOf = (gy: number) => Y0 - gy * RES;
  const edges: [number, number, number, number][] = [];
  for (const [y, f] of filled) {
    minus(f, filled.get(y - 1), (a, b) => edges.push([lonOf(a), latOf(y), lonOf(b), latOf(y)]));
    minus(f, filled.get(y + 1), (a, b) => edges.push([lonOf(a), latOf(y + 1), lonOf(b), latOf(y + 1)]));
    for (const [s, e] of f) {
      push(cols, s * 2, y);
      push(cols, e * 2 + 1, y);
    }
  }
  const runs = (m: Map<number, number[]>, f: (line: number, a: number, b: number) => void) => {
    for (const [l, a] of m) {
      a.sort((u, v) => u - v);
      let s = a[0], e = a[0];
      for (let i = 1; i <= a.length; i++) {
        if (i < a.length && a[i] === e + 1) e = a[i];
        else {
          f(l >> 1, s, e + 1);
          if (i < a.length) s = e = a[i];
        }
      }
    }
  };
  runs(cols, (l, a, b) => edges.push([lonOf(l), latOf(a), lonOf(l), latOf(b)]));
  return { edges, filled };
}

/**
 * The outlines of everything the year map found (any year up to `upTo`) in the chunks over a box, joined across years
 * and holes filled, as edges [lon, lat, lon, lat]; chunks not in hand count as nothing found. Null over more than

/**
 * The patch under a pixel: every pixel `dug` says is dug joined to it by side or corner, or across a gap of PATCH_GAP
 * pixels, whatever its year. Its outer outline (holes filled) as edges [lon, lat, lon, lat]; null off dug ground, or
 * over `max` pixels.
 */
export function patchAt(px: number, py: number, dug: (gx: number, gy: number) => boolean, max = 50_000) {
  if (!dug(px, py)) return null;
  // a pixel's key in the whole grid (4,007,520 columns < 2^22)
  const W = 4194304, key = (gx: number, gy: number) => gy * W + gx;
  const inSeg = new Set<number>([key(px, py)]);
  const qx = [px], qy = [py];
  const reach = PATCH_GAP + 1;
  for (let q = 0; q < qx.length; q++) {
    const x = qx[q], y = qy[q];
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (inSeg.has(k) || !dug(nx, ny)) continue;
        if (inSeg.size >= max) return null;
        inSeg.add(k);
        qx.push(nx);
        qy.push(ny);
      }
  }
  // the patch's pixels row by row
  const xsOf = new Map<number, number[]>();
  let first = Infinity;
  for (let q = 0; q < qx.length; q++) {
    const a = xsOf.get(qy[q]);
    if (a) a.push(qx[q]);
    else xsOf.set(qy[q], [qx[q]]);
    first = Math.min(first, key(qx[q], qy[q]));
  }
  return { edges: traceOutline(runsFrom(xsOf)).edges, n: qx.length, first };
}
