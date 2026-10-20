# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "marimo",
#     "anywidget>=0.9",
#     "traitlets",
#     "duckdb>=1.5.5",
#     "pyarrow>=25.0.0",
#     "shapely>=2.0",
# ]
# ///

"""Overture building footprints by the year their ground was dug (quarters inside a year: off for now).

One map on a dark basemap, read and drawn in the browser (seasons-widget/, built into seasons-widget/dist/widget.js
with `npm run build`). The ground is colored by one source at a time:

  Ours  the aggregate earthwork model (AlphaEarth and TESSERA joined, the weights and scoring of aef-tessera-earthwork's
        web map, in its chunk worker) on each pair of consecutive years 2017 to 2025; a pixel's year is the latest
        year it was over the model's cutoff
  WSF   the WSF Tracker's half-year each 10 m pixel first read as built-up, booked to its calendar year
        (commented out for now: not read, and not on the card)

Quarters are off for now: measured against real Sentinel-2 (embeddings-vis scripts/quarter_check.py) the rule
below matched the real quarter 50% of the time, where calling every dig Q1 matched 62%. QUARTERS in
seasons-widget/src/widget.ts turns them back on. When on, a click on a year in the card opens it by quarter (ours)
or by half-year (WSF). Ours' quarter comes from the decoder (embeddings-vis: a small net that turns a year's AlphaEarth
and TESSERA back into Sentinel-2 color on any day of that year): each quarter of the year is decoded beside the same
quarter of the year before, and the quarter is the first where the two part by at least half their largest
difference. Quarters, not seasons, so they mean the same in either hemisphere. Hovering a footprint gives what each
source says about it, with the quarter mix of its pixels.

Enter reads the view (from zoom 12): every chunk is scored in a worker and kept on disk, so a place read before
comes back at once. The kernel reads the area's footprints from Overture's GeoParquet (the files found through the
Portolan catalog, or Overture's own STAC when the catalog is behind) and sends them to the map as GeoArrow. In the
map each footprint is joined to the 10 m pixels under it: a footprint with a year is filled in that year's color (a
year opened: its quarter's), the rest are faint outlines, and the ground's own colors show only where digging was
found with no Overture building on it or around it.

Run:  uvx marimo run --sandbox --watch aef-tessera-overture.py
"""

import marimo

__generated_with = "0.16.0"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    import pathlib
    import urllib.request

    import asyncio
    import time
    import traceback

    import anywidget
    import duckdb
    import numpy as np
    import pyarrow as pa
    import shapely
    import traitlets

    return (
        anywidget,
        asyncio,
        duckdb,
        json,
        np,
        pa,
        pathlib,
        shapely,
        time,
        traceback,
        traitlets,
        urllib,
    )


@app.cell
def _(json, urllib):
    HOME = {"lon": -112.40, "lat": 33.44, "zoom": 13.5}  # Goodyear, Arizona

    def overture_release():
        """The newest Overture release its STAC lists (its footprint tiles are kept for a few releases only)."""
        with urllib.request.urlopen("https://stac.overturemaps.org/catalog.json", timeout=20) as r:
            root = json.load(r)
        return sorted({l["href"].rstrip("/").split("/")[-2] for l in root["links"] if l.get("rel") == "child"})[-1]

    RELEASE = overture_release()
    return HOME, RELEASE


@app.cell
def _(anywidget, pathlib, traitlets):
    class SeasonsMap(anywidget.AnyWidget):
        """The map, read and scored in the browser; `config` (JSON: home, release). Below zoom 14 the footprints of the
        area read come from the kernel: the browser asks with `foot_ask` (JSON: the area), the kernel answers with
        `foot` (Arrow IPC: a geoarrow.polygon per footprint part, `fid` its footprint) and `foot_status`."""

        _esm = pathlib.Path(__file__).parent / "seasons-widget" / "dist" / "widget.js"
        config = traitlets.Unicode("{}").tag(sync=True)
        foot_ask = traitlets.Unicode("").tag(sync=True)
        foot = traitlets.Bytes(b"").tag(sync=True)
        foot_status = traitlets.Unicode("").tag(sync=True)

    return (SeasonsMap,)


@app.cell
def _(RELEASE, duckdb, json, np, pa, shapely, urllib):
    # ---- the footprints of an area from Overture's GeoParquet, as GeoArrow
    import concurrent.futures as _cf
    from urllib.parse import urljoin as _urljoin

    FOOT_MAX = 400_000  # footprints at most per area: a city at zoom 12 can hold more
    PORTOLAN = "https://nlebovits.github.io/overture-portolan/buildings/building/collection.json"
    OVERTURE_STAC = f"https://stac.overturemaps.org/{RELEASE}/buildings/building/collection.json"
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET enable_object_cache=true;")

    def get_json(url):
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)

    def file_index():
        """The release's building files and their boxes, from a STAC collection (an item a file): the Portolan
        catalog's when it points at the release being shown, else Overture's own for that release."""
        for url in (PORTOLAN, OVERTURE_STAC):
            try:
                c = get_json(url)
            except Exception:
                continue
            items = [_urljoin(url, l["href"]) for l in c["links"] if l.get("rel") == "item"]

            def one(u):
                it = get_json(u)
                a = it["assets"].get("aws") or it["assets"].get("data") or next(iter(it["assets"].values()))
                href = (a.get("alternate", {}).get("s3", {}) or {}).get("href") or a["href"]
                if href.startswith("https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/"):
                    href = "s3://overturemaps-us-west-2/" + href.split(".amazonaws.com/", 1)[1]
                return (*[float(v) for v in it["bbox"][:4]], href)

            with _cf.ThreadPoolExecutor(16) as ex:
                rows = list(ex.map(one, items))
            # a mirror of an older release (its files gone from Overture's bucket) is passed over
            if rows and f"/release/{RELEASE}/" in rows[0][4]:
                return np.array([r[:4] for r in rows]), [r[4] for r in rows], url
        raise RuntimeError(f"no STAC collection lists the buildings of release {RELEASE}")

    INDEX = {}

    def footprints_arrow(area):
        """Arrow IPC bytes: each footprint (every part of a multipolygon) as a geoarrow.polygon of its exterior ring, its
        footprint's row in `fid`; how many footprints, whether FOOT_MAX cut them short, and how many files were read."""
        if not INDEX:
            INDEX["box"], INDEX["path"], INDEX["from"] = file_index()
        W, S, E, N = area
        bx = INDEX["box"]
        hit = [p for p, b in zip(INDEX["path"], bx) if b[2] >= W and b[0] <= E and b[3] >= S and b[1] <= N]
        if not hit:
            return b"", 0, False, 0
        files = "[" + ",".join(f"'{p}'" for p in hit) + "]"
        rows = con.execute(
            f"SELECT geometry FROM read_parquet({files}) "
            f"WHERE bbox.xmin <= {E} AND bbox.xmax >= {W} AND bbox.ymin <= {N} AND bbox.ymax >= {S} LIMIT {FOOT_MAX + 1}"
        ).fetchall()
        cut = len(rows) > FOOT_MAX
        geoms = shapely.from_wkb([r[0] for r in rows[:FOOT_MAX]])
        geoms = geoms[np.isin(shapely.get_type_id(geoms), (3, 6))]
        # a polygon a row (each part of a multipolygon its own), its exterior ring only: what the map fills and joins
        parts, fid = shapely.get_parts(geoms, return_index=True)
        rings = shapely.get_exterior_ring(parts)
        coords = shapely.get_coordinates(rings)
        ring_off = np.concatenate([[0], np.cumsum(shapely.get_num_coordinates(rings))])
        xy = pa.FixedSizeListArray.from_arrays(pa.array(coords.ravel()), type=pa.list_(pa.field("xy", pa.float64(), nullable=False), 2))
        ring = pa.ListArray.from_arrays(pa.array(ring_off, pa.int32()), xy, type=pa.list_(pa.field("vertices", xy.type, nullable=False)))
        poly = pa.ListArray.from_arrays(pa.array(np.arange(len(rings) + 1), pa.int32()), ring, type=pa.list_(pa.field("rings", ring.type, nullable=False)))
        schema = pa.schema([pa.field("geometry", poly.type, metadata={b"ARROW:extension:name": b"geoarrow.polygon"}), pa.field("fid", pa.int32())])
        batch = pa.record_batch([poly, pa.array(fid, pa.int32())], schema=schema)
        sink = pa.BufferOutputStream()
        with pa.ipc.new_stream(sink, schema) as w:
            w.write_batch(batch)
        return sink.getvalue().to_pybytes(), len(geoms), cut, len(hit)

    return (footprints_arrow,)


@app.cell
def _(HOME, RELEASE, SeasonsMap, json):
    view = SeasonsMap(config=json.dumps({"home": HOME, "release": RELEASE}))
    HOLD = {"busy": False, "pending": None, "loop": None}
    view
    return HOLD, view


@app.cell
def _(HOLD, asyncio, footprints_arrow, json, time, traceback, view):
    # ---- wiring: a read's footprints, off the kernel's thread, one at a time (the newest area waits)
    try:
        HOLD["loop"] = asyncio.get_running_loop()
    except RuntimeError:
        pass

    async def serve(area):
        if HOLD["busy"]:
            HOLD["pending"] = area
            return
        HOLD["busy"] = True
        try:
            while area is not None:
                t = time.time()
                view.foot_status = "Reading the footprints from Overture's GeoParquet..."
                data, n, cut, nf = await asyncio.get_running_loop().run_in_executor(None, footprints_arrow, area)
                if data:
                    view.foot = data
                view.foot_status = f"{n:,} footprints from {nf} GeoParquet file{'s' if nf != 1 else ''} in {time.time() - t:.0f} s" + (" (cut short: zoom in)" if cut else "")
                area, HOLD["pending"] = HOLD["pending"], None
        except Exception as exc:
            tb = traceback.extract_tb(exc.__traceback__)
            view.foot_status = f"footprints failed: {type(exc).__name__}: {exc} (line {tb[-1].lineno if tb else '?'})"
            raise
        finally:
            HOLD["busy"] = False

    def spawn(coro):
        try:
            return asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            return asyncio.run_coroutine_threadsafe(coro, HOLD["loop"]) if HOLD["loop"] else None

    def on_ask(change):
        if change["new"]:
            spawn(serve(json.loads(change["new"])["area"]))

    if HOLD.get("h_ask") is not None:
        try:
            view.unobserve(HOLD["h_ask"], names="foot_ask")
        except ValueError:
            pass
    view.observe(on_ask, names="foot_ask")
    HOLD["h_ask"] = on_ask
    return


if __name__ == "__main__":
    app.run()
