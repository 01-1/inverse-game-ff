# Assets

All 3D models in this project are **CC0** (Creative Commons Zero, public domain).
CC0 requires no attribution, but provenance is recorded here anyway.

## Source

All models are from **Kenney** (https://kenney.nl), released under CC0 1.0
(http://creativecommons.org/publicdomain/zero/1.0/).

| Kit | Page | Version |
| --- | ---- | ------- |
| City Kit Commercial | https://kenney.nl/assets/city-kit-commercial | 2.1 |
| City Kit Suburban | https://kenney.nl/assets/city-kit-suburban | 20 |
| Car Kit | https://kenney.nl/assets/car-kit | (latest) |

The upstream `License.txt` from City Kit Commercial is kept verbatim at
`public/assets/models/KENNEY-LICENSE.txt` (identical CC0 terms apply to all three kits).

## What we ship

Only a curated subset of each kit is vendored (the rest of every kit is
discarded to keep the repo small — total shipped models are ~3.5 MB). Files
live in `public/assets/models/` as `.glb`, loaded at runtime with three.js
`GLTFLoader`.

| In-game role | Model file(s) | Kenney source model |
| --- | --- | --- |
| Logistics depot | `depot.glb` | commercial `building-n` |
| Warehouse (W1/W3/W5/W7) | `warehouse-a.glb`, `warehouse-b.glb` | commercial `low-detail-building-wide-a/b` |
| Data Annex (datacenter) | `datacenter.glb` | commercial `building-skyscraper-c` |
| Shops | `shop-a.glb`, `shop-b.glb`, `shop-c.glb` | commercial `building-a/c/e` |
| Civic buildings | `civic-a.glb`, `civic-b.glb` | commercial `building-g/j` |
| Housing | `house-a..e.glb` | suburban `building-type-a/e/h/l/p` |
| Plaza dressing | `tree-large.glb`, `tree-small.glb`, `planter.glb` | suburban trees + planter |
| Ambient traffic | `car-sedan/suv/hatchback/taxi/van.glb` | car kit sedans/SUV/etc. |
| Delivery trucks | `truck.glb`, `truck-delivery.glb`, `truck-flat.glb` | car kit trucks |

Sensor stations are drawn as a procedural low-poly mast (no kit equivalent gives
the right "instrument tower" silhouette). Roads are procedural boxes with a
generated dashed-centerline texture, so their material can still be tinted by
per-day congestion.

## Re-downloading

The kits were fetched from the canonical zip URLs scraped off each kit's
kenney.nl page, e.g.:

```
curl -sL -o city-kit-commercial.zip \
  "$(curl -sL https://kenney.nl/assets/city-kit-commercial \
     | grep -oiE 'https://kenney.nl/media/pages/assets/[^" ]*\.zip' | head -1)"
```

Unzip, then copy the GLBs listed above out of `Models/GLB format/` into
`public/assets/models/`.
