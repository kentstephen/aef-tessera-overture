# Dug ground outlined on Sentinel-2, a patch's years on a click

A marimo notebook with one map: a year of Sentinel-2 from Element 84's Earth Search, and over it, in orchid, the
outline of every patch of ground found dug or graded between 2017 and 2025. The digging comes from satellite
embeddings alone (AlphaEarth Foundations and TESSERA), scored by the aggregate earthwork model. (The branch
`earth-search` has the map this one grew from: Overture footprints, the year raster, the pair.)

## What the map shows

- **Sentinel-2.** One clear pass for the view, 2025 to start; `[` `]` step the year, 2017 to 2025, `B` jumps to 2025
  and then between 2017 and 2025, `N` steps to the year's next clear pass. The card shows the year and the pass's day.
- **Patches.** From zoom 12 the view is read by itself once the map settles. Every pixel the model found dug in any
  pair of years is joined to its neighbors where they touch by side or corner, whatever its year, as
  aef-tessera-earthwork's year map joins them but with no gap (it also joins across one pixel: `PATCH_GAP`) (`patchesIn` in `seasons-widget/src/patch.ts`); each patch is outlined on
  its outer edge, holes filled, not filled in. Every patch is drawn, however small (no size cutoff yet).
- **A patch's years.** A click on a patch fills the window with it three times side by side, framed the same in each:
  before (the year before any of it was dug, 2017 at the earliest), dug, and 2025. The dug panel is picked for the most
  change: of the clear passes (up to three a year) in the years any of it was dug, short of 2025 unless it was dug only
  then, the one whose ground inside the patch is most unlike both the before and the 2025 image, less the same measured
  on the ground around it, so a change everywhere (season, haze) cancels and the patch's own change counts (a pass with
  cloud, shadow or snow over more than 5% of the patch passed over); the best so far shows as each year is checked. The frame fits the patch with room around it and comes no closer than zoom 14.2,
  so the 10 m pixels stay small. Each panel shows that year's pass chosen for the map's view, so a place already looked
  at comes back at once; each panel's imagery shows as it arrives. While you look around, every year's pass is read ahead for the view (the year shown first, then the rest, one tile at a time, dropped when the view moves on) into one cache of decoded tiles shared by the map and the panels (600 MB at most, the least lately used let go), and each year's clear passes the dug panel chooses from are found ahead too, so a patch's before and 2025 panels usually draw at once. The patch is outlined in orchid on the panels; `O` takes the outline off. (Dimming the imagery around the patch, as aef-tessera-earthwork's spotlight does, is in the code, commented out.) The patch's size is at the bottom. A click anywhere,
  or `Esc`, goes back.
- **Export.** `K` writes a 4x PNG to `exports/` (the panels side by side while they are open, else the map), each
  image's year and day drawn at its top left, and a copy sized for a LinkedIn post in `exports/for_linkedin/` (long
  side 2048, under 5 MB).

The model is aef-tessera-earthwork's aggregate (one logistic regression on AlphaEarth and TESSERA joined, opened
where either embedding changed; `models/earthwork_world.json`), scored per pixel in a web worker exactly as that
project's web map does, and kept on disk in the browser so a place read before comes back at once.

## Sentinel-2: how a year's scene is chosen

A year shows one acquisition (one satellite pass, one day), never a mix of days, drawn from its true-color image (TCI)
as it is. All of the choosing is in `seasons-widget/src/es-s2.ts`; change it there and run `npm run build` in
`seasons-widget/`.

**Another look.** `N` steps the year to its next clear pass over the view (the next one checked that passes, looked
for when none is left), wrapping back to the first. A pass is kept while the view stays within a quarter of its size
of where it was chosen; pan farther and the pass on screen is checked again over the new view, and kept if it is
still clear there, else the year is chosen again.

**What makes a pass clear.** In order:

1. Earth Search is asked for the year's L2A scenes over the view (and a quarter around it), clearest first by
   scene-wide cloud, up to `MAX_SCENE_CLOUD` (70%). That limit is loose on purpose: a cloudy tile can be clear where
   you are looking.
2. By metadata: the hemisphere's winter is skipped (`MONTH_WINTER_N`, December to February, north of 23.5°;
   `MONTH_WINTER_S`, June to August, south of it; nothing inside the tropics), and so is any scene under a sun lower
   than `MIN_SUN` (15°: dark, long shadows).
3. Scenes are grouped into passes by datatake (a scene processed twice counts once).
4. Each pass's scene classification band (SCL) is read over the view, on a `GRID` × `GRID` (48 × 48) grid of
   points from a coarse overview. A pass is clear when it has data over at least `MIN_COVER` (97%) of the view and
   at most `MAX_BAD` (2%) of what it covers is in a `BAD` class: 1 defective, 3 cloud shadow, 8 and 9 cloud, 10
   cirrus, 11 snow.
5. Passes are checked `BATCH` (3) at a time, clearest by metadata first, and the least cloudy clear one of the first
   batch that has one is shown. At most `MAX_CHECKED` (24) are checked per look. When none is clear, the least cloudy
   checked is shown and the card says "cloudy".

| To change | Constant |
| --- | --- |
| how much cloud, shadow, cirrus or snow is allowed over the view | `MAX_BAD` |
| which SCL classes count against a pass (drop 11 to allow snow) | `BAD` |
| how much of the view a pass must cover | `MIN_COVER` |
| which months are skipped as winter | `MONTH_WINTER_N`, `MONTH_WINTER_S` |
| how low a sun is allowed | `MIN_SUN` |
| how cloudy a whole tile may be to be considered at all | `MAX_SCENE_CLOUD` |
| how many passes are checked before giving up | `MAX_CHECKED` |
| how far the view can move before the year is chosen again | `grow(v, 0.25)` in `choose` |
| how many years stay loaded for instant blinking | `WARM` |
| which years there are | `S2_YEARS` |

2017 is thin: fewer scenes, from an older processing whose SCL is unreliable in cities (much of a city called "dark
area" or "unclassified"), so a 2017 pass often lands just over `MAX_BAD` and shows as cloudy when it is clear.

## Run

```sh
uvx marimo run --sandbox --watch aef-tessera-overture.py
```

The map fills the window. Search a place (`/`) and zoom in: from zoom 12 the view reads by itself once the map
settles (below it nothing is read). Reading scores the view in the
browser.

Keys: `[` `]` the imagery's year, `B` 2017 or 2025, `N` a new look (another clear pass), `O` outlines on or off (the panels' own while they are open), `/` search, `K` export, `Shift` `←` `→`
pivot, `X` notebook view, `F` full screen, `Esc` back from the panels.

## How it is built

- `aef-tessera-overture.py`: the notebook: the widget, and the kernel saving the PNGs `K` sends.
- `seasons-widget/`: the map, a TypeScript anywidget built into one file, `dist/widget.js` (`npm ci && npm run
  build` after a change). MapLibre and deck.gl; AlphaEarth and TESSERA read as Zarr with zarrita
  (deck.gl-zarr), the score per chunk in a worker; the
  Sentinel-2 L2A scenes found through Earth Search's STAC and their TCI COGs read with deck.gl-geotiff.
- `models/`: the earthwork model's weights and the decoder (below).

## Quarters inside a year: off for now

The widget can also say which quarter of the year the ground was dug in, from a small decoder that turns a year's
AlphaEarth and TESSERA back into Sentinel-2 color on any day of that year. Measured against real Sentinel-2 at
Goodyear, Arizona and Wildwood, Florida (about 240,000 dug pixels), the quarter it gave matched the real one 50% of
the time, where calling every dig Q1 matched 62%; the best of three rules (the quarter of the largest change)
matched 42% against 30% for a constant guess. A yearly embedding holds little of when in the year the ground
changed, so the quarters are switched off (`QUARTERS` in `seasons-widget/src/widget.ts`) until there is a better
way to read them.

## Data and credits

| Data | Producer | Licence |
| --- | --- | --- |
| AlphaEarth Foundations Satellite Embedding, annual 2017 to 2025 ([tge-labs/aef-mosaic](https://source.coop/tge-labs/aef-mosaic)) | Google and Google DeepMind | CC BY 4.0 |
| TESSERA v1.1 embeddings ([tessera on Source Cooperative](https://source.coop/tessera/tessera)) | University of Cambridge | see the dataset |
| Sentinel-2 L2A ([Earth Search](https://earth-search.aws.element84.com/v1), AWS Open Data `sentinel-cogs`) | Copernicus Sentinel data, cataloged by Element 84 | Copernicus open access |
| Basemap | CARTO, OpenStreetMap contributors | ODbL |
