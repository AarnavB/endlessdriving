# NYC world foundation

## Current implementation

This branch adds a WGS84 geodesy layer, a viewport-scoped NYC Open Data client, a 512 m chunk streamer, building-footprint extrusion, street-width road surfaces, and corresponding Rapier static collision meshes. The existing player vehicle, suspension, steering, drivetrain, transmission, reverse, braking, car catalogue, camera, audio, and HUD code remains separate from the city data layer.

The initial world anchor is near 8th Avenue in Midtown Manhattan. Public building and street features are queried only for the active chunk neighbourhood. Data stays in memory while chunks are active; their Three.js geometry and Rapier bodies are disposed when chunks leave the streaming window.

This is a first geospatial integration milestone, not a complete five-borough reconstruction. The shared ENU coordinate system and chunk addressing can address the broad NYC extent, but only chunks near the player are fetched and rendered. The AI traffic pool still follows the pre-existing scalar RoadPath. It does not yet route through the city centreline graph or obey a city traffic-signal network.

## Geographic frame

- Horizontal datum: WGS84 longitude/latitude from NYC Open Data GeoJSON.
- Local simulation frame: WGS84 ECEF converted to a local East-North-Up tangent frame, in metres.
- Local axes: +X east, +Y up, +Z north.
- Building roof heights and ground elevations are interpreted as feet and converted using 0.3048 metres per foot.
- The chunk grid is globally aligned in the local tangent frame at 512 m per side.
- The broad five-borough envelope is a rectangular discovery extent, not a replacement for official borough boundary polygons.

## Data sources

### NYC Building Footprints — dataset 5zhs-2jue

Public dataset: https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue

The NYC Office of Technology and Innovation layer describes approximately 1.08 million building footprints and is updated weekly. Available fields include footprint geometry, identifiers, construction year, feature code, geometry source, ground elevation, and roof height. Accuracy varies by geometry source and record. The system uses actual footprints and available roof heights for massing; missing height values use a visibly approximate 9 m blockout.

### NYC Street Centerline — dataset inkn-q76z

Public dataset: https://data.cityofnewyork.us/City-Government/NYC-Street-Centerline-CSCL-/inkn-q76z

The NYC Office of Technology and Innovation centreline dataset describes street-bed axes and includes traffic direction, road type, bicycle-lane metadata, and paved street width. Published paved width is interpreted in feet. The initial build renders roadbed-width surfaces; it does not yet claim exact lane-by-lane geometry.

### Street Sign Work Orders — dataset qt6m-xctn

Public dataset: https://data.cityofnewyork.us/Transportation/Street-Sign-Work-Orders/qt6m-xctn

This dataset describes completed current and historical sign installation work orders. It is not treated as a live point-accurate inventory of every sign currently installed, so this milestone does not place purportedly verified signs from those work-order records.

## Google Photorealistic 3D Tiles

The optional live Google layer uses the NASA-AMMOS 3D Tiles renderer and its Google Cloud authentication plugin. It is a visualization layer only. It is never queried for road geometry, building footprints, collision, object detection, asset generation, or offline storage.

A dynamic attribution overlay updates from the renderer's currently visible tile credits and includes the text Google Maps. Google recommends the official unmodified logo wherever possible; this build uses the documented text attribution fallback within the compact game overlay. The official logo should replace the text fallback when the production HUD can reserve the required logo size and clear space.

Google Maps Platform setup:

1. Create a Google Cloud project with billing enabled.
2. Enable the Map Tiles API and Photorealistic 3D Tiles access for that project.
3. Create a browser API key restricted to the game's production and local development origins, and restrict the key to the Map Tiles API.
4. Set VITE_GOOGLE_MAPS_API_KEY in the Vercel project environment and in a local .env file. Do not commit the key.
5. Redeploy after setting the variable.

Google coverage, resolution, network access, API quotas, and billing affect what appears in the browser. Without the variable, the independent NYC Open Data world still loads. Google's terms restrict extraction, machine interpretation, offline use, and storage beyond what the applicable agreement expressly permits. Never use Google tile meshes for collision or derive independent game assets from them.

## Data limitations and outstanding work

- Source footprints provide building massing, not complete facade, window, rooftop-equipment, or storefront geometry. Detailed architecture and landmark models still require separately licensed or original assets.
- Centreline data describes roadbed axes and widths; exact lane counts, boundaries, turn pockets, stop lines, and many markings need further authoritative transportation datasets or explicitly labelled estimates.
- Sign work orders are not a guaranteed complete active sign inventory.
- The reviewed signal 311/study-request layers are not an authoritative citywide signal-location inventory. No verified signal placement is fabricated.
- AI traffic still follows the legacy scalar RoadPath. A routable road graph, junction turns, signal phases, lane-change logic, pedestrian simulation, and borough-aware density remain future work.
- Terrain/elevation is not yet a continuous city-wide DEM. Roadbed collision is currently level; grades, bridge decks, tunnels, and underpasses need dedicated source data and verification.
- The five-borough extent is addressable, but a complete borough-by-borough coverage run, detailed landmarks/storefronts, and full city-scale regression remain outstanding.

## Commands

- npm run build
- npm run test:drivetrain
- npm run test:nyc-geo

The drivetrain regression suite is retained unchanged. The geospatial regression checks cover ENU round-tripping, distance consistency, chunk-boundary arithmetic, and geographic chunk bounds.
