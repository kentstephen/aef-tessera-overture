# AlphaEarth and TESSERA earthwork over Overture buildings

A marimo notebook with one map: the Overture building footprints filled by the year their ground was dug or graded,
and, elsewhere, the dug ground that has no building on it yet. The years come from satellite embeddings alone
(AlphaEarth Foundations and TESSERA), scored by the aggregate earthwork model; the footprints from Overture's
GeoParquet; Sentinel-2 scenes from Element 84's Earth Search, beside the map or behind it on a key.

## What the map shows

- **Digging.** The raster is where the model found the ground dug in a pair of years (2017 to 2018 through 2024 to
  2025), colored by the year it was last dug, 2018 (blue) to 2025 (yellow). It shows wherever it is found, buildings
  or not.
- **Buildings.** Overture footprints lie under the raster. Each is joined to the 10 m pixels under it and filled in
  its year's color (the year most of its dug pixels were last dug in): a building's year is the pixels under it read
  together, the raster over it is the digging itself. Each building's outline is drawn over the raster, amber where
  digging is under it and silver where not.
- **Sentinel-2.** `P` pairs the map with Sentinel-2: a second map on the left, moving with the map on the right.
  Hold space for the imagery over the map itself, the raster and the footprints stepped aside (scroll steps the
  year). `[` `]` step the year, 2017 to 2025; `B` jumps to 2025, then between 2017 and 2025. A year shows one
  acquisition (one pass, one day), never a mix of days, drawn from its true-color image (TCI) as it is, with no
  masking or blending. The pass is chosen for the view: each candidate's scene classification (SCL) is read over the
  view, and the first pass with data over all of it and at most 2% cloud, cloud shadow, cirrus or snow there is
  taken (none: the least cloudy, and the card says so). Winter is skipped by hemisphere (December to February north of
  the tropics, June to August south of them) along with scenes under a sun below 15 degrees. The pass stays while the
  view stays near where it was chosen, and the last few years shown stay loaded, so blinking between years swaps two
  finished images. `N` steps to the year's next clear pass; the card shows the day. Paired, the footprint under the
  pointer on either half is outlined in gold on the imagery; a click pins it there while the years are stepped, and
  with one pinned any click lets it go.
- **Export.** `K` writes a 4x PNG of the map to `exports/` (paired, both halves side by side), with the legend drawn
  at its top left (paired, the right half's) and the imagery's year and day at the left half's, and a copy sized for
  a LinkedIn post in `exports/for_linkedin/` (long side 2048, under 5 MB).

The model is aef-tessera-earthwork's aggregate (one logistic regression on AlphaEarth and TESSERA joined, opened
where either embedding changed; `models/earthwork_world.json`), scored per pixel in a web worker exactly as that
project's web map does, and kept on disk in the browser so a place read before comes back at once.

## Run

```sh
uvx marimo run --sandbox --watch aef-tessera-overture.py
```

The map fills the window. Search a place (`/`) and zoom in: from zoom 12 the view reads by itself once the map
settles (below it nothing is read). Reading scores the view in the
browser; the footprints are read by the notebook's kernel and sent as GeoArrow.

Keys: `P` pair with Sentinel-2, hold space Sentinel-2 over the map, `[` `]` its year, `B` 2017 or 2025, `N` another
clear pass, `L` labels, `Q` picking and the tooltip, `/` search (the magnifier in the year card), `K` export, `Shift` `←`
`→` pivot, `X` notebook view, `F` full screen, `Esc` back.

## How it is built

- `aef-tessera-overture.py`: the notebook. The kernel finds the Overture building files that meet the area read
  through the [Portolan catalog of Overture](https://nlebovits.github.io/overture-portolan) (or Overture's own
  STAC when the catalog points at a release Overture has since removed), reads them with DuckDB, and sends the
  footprints as GeoArrow polygons.
- `seasons-widget/`: the map, a TypeScript anywidget built into one file, `dist/widget.js` (`npm ci && npm run
  build` after a change). MapLibre and deck.gl; AlphaEarth and TESSERA read as Zarr with zarrita
  (deck.gl-zarr), the score per chunk in a worker; the footprints drawn with `@geoarrow/deck.gl-layers`; the
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
| Overture Maps buildings | Overture Maps Foundation | ODbL |
| Sentinel-2 L2A ([Earth Search](https://earth-search.aws.element84.com/v1), AWS Open Data `sentinel-cogs`) | Copernicus Sentinel data, cataloged by Element 84 | Copernicus open access |
| Basemap | CARTO, OpenStreetMap contributors | ODbL |
