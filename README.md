# AlphaEarth and TESSERA earthwork over Overture buildings

A marimo notebook with one map: the Overture building footprints filled by the year their ground was dug or graded,
and, elsewhere, the dug ground that has no building on it yet. The years come from satellite embeddings alone
(AlphaEarth Foundations and TESSERA), scored by the aggregate earthwork model; the footprints from Overture's
GeoParquet; Sentinel-2 from Earth Genome's yearly mosaics, behind the map on a key.

## What the map shows

- **Buildings by year.** Each Overture footprint is joined to the 10 m pixels under it. Where the model found the
  ground dug in a pair of years (2017 to 2018 through 2024 to 2025), the footprint is filled in the color of the year
  most of its pixels were last dug in, 2018 (violet) to 2025 (yellow). Footprints with no year are outlines.
- **Where to look.** The raster of dug ground shows only where there is no Overture building on it or within about
  30 m: graded land, pads and sites nothing has been built or mapped on yet. Inside built neighborhoods it steps
  aside and the buildings carry the color.
- **Sentinel-2.** Hold space (scroll or `[` `]` to step the year) or press `P` for Earth Genome's yearly Sentinel-2
  mosaics, 2022 to 2025. The raster and the footprints step aside: the imagery alone.

The model is aef-tessera-earthwork's aggregate (one logistic regression on AlphaEarth and TESSERA joined, opened
where either embedding changed; `models/earthwork_world.json`), scored per pixel in a web worker exactly as that
project's web map does, and kept on disk in the browser so a place read before comes back at once.

## Run

```sh
uvx marimo run --sandbox --watch aef-tessera-overture.py
```

The map fills the window. Search a place (`/`) and zoom in: from zoom 13.5 the view reads by itself once the map
settles; from 12 to 13.5 press `Enter` (a view there can be a hundred chunks). Reading scores the view in the
browser; the footprints are read by the notebook's kernel and sent as GeoArrow.

Keys: `Enter` reads the view, hold space or `P` Sentinel-2, `L` labels, `Q` picking and the tooltip, `H` folds the
card, `/` search, `X` notebook view, `F` full screen, `Esc` back.

## How it is built

- `aef-tessera-overture.py`: the notebook. The kernel finds the Overture building files that meet the area read
  through the [Portolan catalog of Overture](https://nlebovits.github.io/overture-portolan) (or Overture's own
  STAC when the catalog points at a release Overture has since removed), reads them with DuckDB, and sends the
  footprints as GeoArrow polygons.
- `seasons-widget/`: the map, a TypeScript anywidget built into one file, `dist/widget.js` (`npm ci && npm run
  build` after a change). MapLibre and deck.gl; AlphaEarth and TESSERA read as Zarr with zarrita
  (deck.gl-zarr), the score per chunk in a worker; the footprints drawn with `@geoarrow/deck.gl-layers`; the
  Sentinel-2 COGs with deck.gl-geotiff.
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
| Sentinel-2 yearly and temporal mosaics ([earthgenome](https://source.coop/earthgenome/sentinel2-yearly-mosaics)) | Earth Genome, from Copernicus Sentinel data | CC BY 4.0 |
| Basemap | CARTO, OpenStreetMap contributors | ODbL |
