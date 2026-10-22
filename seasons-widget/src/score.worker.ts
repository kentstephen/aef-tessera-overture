import { aefScores, type LayerKind, olmoScores, scorePixel, type WorldModel } from "./earthwork-cpu";

/** The scoring math of chunk.worker.ts's pairScore, run here so several chunks score at once on other cores. */
let model: WorldModel | null = null;
type Job =
  | { type: "init"; model: WorldModel }
  | { type: "aef"; id: number; first: Int8Array; last: Int8Array; plane: number }
  | { type: "olmo"; id: number; first: Int8Array; last: Int8Array; ok: Uint8Array; plane: number }
  | { type: "pair"; id: number; kind: LayerKind; aefFirst: Int8Array; aefLast: Int8Array; tesFirst: Int8Array; tesLast: Int8Array; tesFlags: Uint8Array; plane: number };
self.onmessage = (ev: MessageEvent<Job>) => {
  const m = ev.data;
  if (m.type === "init") {
    model = m.model;
    return;
  }
  let out: Float32Array;
  if (m.type === "aef") out = aefScores(m.first, m.last, m.plane, model!);
  else if (m.type === "olmo") out = olmoScores(m.first, m.last, m.ok, m.plane, model!);
  else {
    out = new Float32Array(m.plane);
    const px = { aefFirst: m.aefFirst, aefLast: m.aefLast, tesFirst: m.tesFirst, tesLast: m.tesLast, tesFlags: m.tesFlags, plane: m.plane, at: 0 };
    for (let at = 0; at < m.plane; at++) {
      px.at = at;
      const v = scorePixel(m.kind, model!, px);
      out[at] = v == null ? -1 : v;
    }
  }
  postMessage({ id: m.id, out }, { transfer: [out.buffer] as ArrayBuffer[] });
};
