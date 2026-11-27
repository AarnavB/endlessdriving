# NYC GIS world — Stage 3 implementation record

**Status:** GIS road, building and terrain data are integrated into the active game runtime and the automated regression pipeline passes. **Stage 3 is not yet fully accepted:** bridge, tunnel and ramp elevations are not yet linked to a validated 3D source, and browser-based driving/performance verification remains outstanding.

## Active runtime architecture

The active gameplay world is no longer the orthogonal Manhattan-inspired prototype described in earlier revisions of this document.

- `Game.create()` initializes `NYCStreetNetworkLoader`, `NYCBuildingFootprintLoader` and `NYCTerrainLoader`, loads the initial checksummed GIS tiles, and constructs `NYCGISRoadGraph`. A GIS startup or validation failure is surfaced to the caller; the game does **not** silently start the old procedural street grid.
- `NYCGISRoadGraph` is the active road topology. It builds directed edges from the baked NYC CSCL graph, retaining source traffic direction, source feature references, level codes, road classifications, widths, lane counts and speed metadata.
- `NYCCityChunkManager` streams 512 m chunks around the player. The current stream radius is one chunk in each direction (a maximum 3 × 3 active neighbourhood). It composes terrain, road surfaces, markings, sidewalks, official building footprints, props and static Rapier collision.
- `TrafficSystem` receives the active graph and uses it for traffic route/lane progression. The legacy orthogonal `CityRoadGraph` and earlier road-grid implementations remain in the codebase for compatibility and non-GIS tests, not as a fallback selected by game startup.
- The existing vehicle, drivetrain, transmission, steering, suspension, audio, camera, HUD and settings systems remain in place.

## Baked datasets and verified coverage

The current retained GIS artifact was produced by re-indexing the previously validated source bake. This rebuilt the directed road graph and building spatial index without downloading the 1.08 million building records again. The workflow retains a full-bake fallback if the source artifact is unavailable.

| Dataset | Latest verified output |
|---|---:|
| NYC CSCL source features | 122,331 |
| Retained normalized CSCL features | 113,484 |
| Directed graph nodes | 78,625 |
| Retained graph audit edges | 117,390 |
| Directionally drivable graph edges | 117,386 |
| Unknown-direction audit edges (excluded from runtime tiles) | 4 |
| Sub-metre edges rejected before runtime tiling | 6 |
| Road tiles | 3,238 |
| Unique retained building footprints | 1,081,964 |
| Building tiles | 3,109 |
| Footprints extending beyond their centroid-owner tile | 60,076 |
| NYC 2017 DEM tiles | 225 |
| Valid DEM samples | 13,055,468 |
| DEM NoData samples | 1,690,132 |

The road and building runtime regressions verify coverage probes in Manhattan, The Bronx, Brooklyn, Queens and Staten Island. The latest building coverage counts are Manhattan 45,000; The Bronx 104,070; Brooklyn 329,848; Queens 460,680; and Staten Island 142,366.

The road graph keeps four source records with unknown traffic direction in the audit data, but they are not copied into the runtime tile index. Six source paths at or below the runtime's one-metre minimum are excluded before graph/tile generation; associated orphan nodes are removed. The graph test checks that every directionally drivable graph edge appears in the checksummed runtime tiles, and no unknown-direction audit edge does.

## Terrain and vertical datum

The terrain source is NYC's 2017 topobathymetric DEM. The baked runtime grid is Float32, transformed from the source horizontal CRS (NAD83 / New York Long Island State Plane, EPSG:2263) to the raster tile's geographic output frame (EPSG:4326). The manifest records the source vertical datum as NAVD88 / Geoid 12B, the metre conversion and the runtime vertical origin.

The latest DEM integrity test verifies 225 tiles, 13,055,468 valid pixels, 1,690,132 NoData pixels and a runtime origin elevation of approximately 10.893222 m.

`sampleNYCTerrainRaster()` performs finite-sample bilinear interpolation. If all contributing interpolation samples are NoData, it may use the nearest finite pixel only when it is within 20 m; otherwise it returns `null`. It does not turn NoData into an invented zero elevation. At-grade road nodes/edges and the GIS terrain/building sampling path reject missing or non-finite elevations instead of silently flattening them.

The Hudson River bathymetry/water surface remains an authored waterfront approximation; it is not claimed to be a surveyed extension of the land DEM.

## Building footprints, terrain placement and collision

- Building footprints come from the NYC building-footprint source. The bake stores polygon-derived bounds for each footprint and aggregate footprint bounds for each centroid-owner tile.
- The runtime loader selects owner tiles by aggregate footprint bounds, then filters/deduplicates footprints against the requested chunk's bounds. It therefore finds footprints that cross into a chunk even when their centroid belongs to another tile.
- The latest artifact identifies 60,076 footprints whose extents cross their centroid-owner tile. All 1,081,964 retained building records remain represented in the 3,109-tile index.
- Building polygons are extruded from their source footprint and clipped to each streamed chunk before the chunk geometry is emitted. Clipped footprint vertices are lifted using the DEM sample at each vertex, preserving building extrusion height over sloping terrain. A missing DEM elevation is an explicit error, not a zero-height fallback.
- The same generated building geometry is used for the visible Three.js mesh and its Rapier trimesh collider, so the clipped collision surface follows the clipped rendered geometry.

Source roof heights are retained where available; missing heights use the existing feature-code median/fallback provenance recorded by the bake. The runtime still uses a simplified extrusion rather than a detailed architectural model.

## Streaming, collision and resource lifetime

- Road, building and terrain loaders use checksummed tile manifests, bounded LRU caches and in-flight request de-duplication.
- Chunk requests are de-duplicated while pending; the player-centre chunk is prioritized and chunks outside the active streaming neighbourhood are removed.
- Roads, sidewalks, terrain, building meshes and elevated-road surfaces create their corresponding static Rapier collision geometry as part of chunk construction.
- Chunk teardown removes the chunk's fixed rigid body (and attached colliders) and disposes chunk-owned Three.js geometries. The chunk manager also releases its shared materials/textures/geometries during teardown.
- World-origin rebasing shifts active chunk groups and their Rapier bodies together. The graph and its source geometry remain in the global ENU metre frame.
- The streaming implementation is asynchronous and bounded, but meshing still occurs on the main thread; it is not a worker-thread or GPU-driven streaming pipeline.

## Known critical limitation: grade-separated road elevations

The CSCL line geometry currently used by the bake is two-dimensional. CSCL level codes preserve grade-separated topology, but they do not provide the absolute deck/soffit elevation needed to place every bridge, tunnel and ramp vertically. In `NYCGISRoadGraph`, at-grade geometry is sampled against the DEM; non-at-grade source geometry still lacks a validated absolute vertical profile. Consequently, bridge/tunnel/ramp topology is represented, but their deck/soffit heights and resulting rendered/collision surfaces are **not yet proven aligned to surveyed elevations**.

NYC's 2022 planimetric sources provide candidate inputs for this work:

- [NYC Planimetric Database: Elevation Points](https://data.cityofnewyork.us/Transportation/NYC-Planimetric-Database-Elevation-Points/9uxf-ng6q) contains Point Z elevation records. The capture rules classify spot elevations as feature code 300000 and bridge elevations as sub-feature code 300020.
- [NYC Planimetric Database: Transportation Structures](https://data.cityofnewyork.us/City-Government/NYC-Planimetric-Database-Transportation-Structures/h9sf-7bej) contains transportation-structure polygons, including bridge feature code 2300.
- The [NYC planimetric capture rules](https://github.com/CityOfNewYork/nyc-planimetrics/blob/main/Capture_Rules.md) say bridge-elevation points are captured at the beginning, middle and end of visible bridges/overpasses, with additional points at 200 ft spacing; the elevation field is in feet above sea level and the planimetric vertical datum is NAVD88.

These sources do **not** document that their `SOURCE_ID` values are equivalent to CSCL `PHYSICALID` or CSCL feature IDs. No such identifier equality is assumed here. A future integration must use a separately tested spatial association that also checks bridge-structure containment, a unique compatible CSCL candidate, grade/class consistency, sample spacing and vertical continuity; ambiguous matches must be rejected rather than assigned by nearest-point proximity alone. Until that is implemented and baked, surveyed bridge/tunnel/ramp vertical alignment remains outstanding.

## Other visual/gameplay validation limits

- The waterfront coastline and riverbed presentation include authored approximations and are not a surveyed shoreline reconstruction.
- The headless test suite verifies data integrity, graph directionality, spatial indexing, chunk/collision construction contracts and physics regressions; it does not replace a full in-browser drive through every borough, bridge, tunnel, ramp and chunk boundary.
- No browser visual inspection, representative-device FPS/GPU profiling or long-session memory measurement is claimed by the automated CI results.
- The active world is GIS-backed, but this document does not claim that every bridge, tunnel, facade or waterfront structure is civil-engineering-grade or visually complete.

## Validation commands

The current CI workflow runs:

```sh
npm ci
npm run build:app
npm run test:drivetrain
npm run test:nyc-geo
npm run test:city-urban
npm run test:city-routing
npm run test:nyc-road-data
npm run test:nyc-road-graph
npm run test:nyc-building-geometry
npm run test:nyc-terrain-sampling
npm run test:nyc-terrain
npm run test:nyc-runtime
npm run test:world
```

The latest successful NYC workflow also validates/restores the retained GIS bake, checksums the runtime datasets and uploads the refreshed artifact. A passing headless suite establishes automated regression coverage; it does not establish browser visual or performance acceptance.
