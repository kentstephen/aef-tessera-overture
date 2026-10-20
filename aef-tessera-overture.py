# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "marimo",
#     "anywidget>=0.9",
#     "traitlets",
# ]
# ///

"""Patches of dug ground outlined on Sentinel-2, and each patch's years side by side on a click.

One map, read and drawn in the browser (seasons-widget/, built into seasons-widget/dist/widget.js with `npm run
build`): a year of Sentinel-2 from Element 84's Earth Search (one clear pass for the view, the hemisphere's winter
skipped), and over it, in orchid, the outline of every patch of ground the aggregate earthwork model (AlphaEarth and
TESSERA joined, aef-tessera-earthwork's weights and scoring) found dug in any pair of years 2017 to 2025, joined as
aef-tessera-earthwork's year map joins them. A click on a patch fills the window with it in the first and the last
year any of it was dug, and 2025; a click anywhere goes back.

The view reads by itself from zoom 12 once the map settles: every chunk is scored in a worker and kept on disk, so a
place read before comes back at once.

Run:  uvx marimo run --sandbox --watch aef-tessera-overture.py
"""

import marimo

__generated_with = "0.16.0"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    import pathlib
    import re
    import time

    import anywidget
    import traitlets

    return anywidget, json, pathlib, re, time, traitlets


@app.cell
def _():
    HOME = {"lon": -112.40, "lat": 33.44, "zoom": 13.5}  # Goodyear, Arizona
    return (HOME,)


@app.cell
def _(anywidget, pathlib, traitlets):
    class SeasonsMap(anywidget.AnyWidget):
        """The map, read and scored in the browser; `config` (JSON: home)."""

        _esm = pathlib.Path(__file__).parent / "seasons-widget" / "dist" / "widget.js"
        config = traitlets.Unicode("{}").tag(sync=True)
        # K in the map: a 4x PNG of the map (or the panels open) and its name (zoom, center), written to exports/, and the same scaled for a
        # LinkedIn post (`snap_small`, its "WxH" in `snap_small_size`) to exports/for_linkedin/; the result in snap_status
        snap = traitlets.Bytes(b"").tag(sync=True)
        snap_name = traitlets.Unicode("").tag(sync=True)
        snap_small = traitlets.Bytes(b"").tag(sync=True)
        snap_small_size = traitlets.Unicode("").tag(sync=True)
        snap_status = traitlets.Unicode("").tag(sync=True)

    return (SeasonsMap,)


@app.cell
def _(HOME, SeasonsMap, json):
    view = SeasonsMap(config=json.dumps({"home": HOME}))
    HOLD = {}
    view
    return HOLD, view


@app.cell
def _(HOLD, pathlib, re, time, view):
    # ---- K in the map: its 4x PNG saved to exports/ beside the notebook
    def on_snap(change):
        data = change["new"]
        if not data:
            return
        try:
            out = pathlib.Path(__file__).parent / "exports"
            out.mkdir(exist_ok=True)
            name = re.sub(r"[^A-Za-z0-9._-]", "", view.snap_name or "map")
            path = out / f"{time.strftime('%Y%m%d-%H%M%S')}_{name}.png"
            path.write_bytes(bytes(data))
            msg = f"Saved exports/{path.name} ({len(data) / 1e6:.1f} MB)"
            if view.snap_small:
                small = out / "for_linkedin"
                small.mkdir(exist_ok=True)
                size = re.sub(r"[^0-9x]", "", view.snap_small_size or "")
                spath = small / f"{path.stem}-{size}.png"
                spath.write_bytes(bytes(view.snap_small))
                msg += f" and for_linkedin/{spath.name}"
            view.snap_status = msg
        except Exception as exc:
            view.snap_status = f"Export failed: {type(exc).__name__}: {exc}"
        finally:
            view.snap = b""
            view.snap_small = b""

    if HOLD.get("h_snap") is not None:
        try:
            view.unobserve(HOLD["h_snap"], names="snap")
        except ValueError:
            pass
    view.observe(on_snap, names="snap")
    HOLD["h_snap"] = on_snap
    return


if __name__ == "__main__":
    app.run()
