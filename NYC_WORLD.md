# NYC-inspired urban world

## Runtime architecture

The active gameplay world is a deterministic, fictionalised Manhattan-inspired city. It is not a surveyed, street-accurate reconstruction of New York City.

- `CityRoadGraph` is the authoritative topology for intersections, directed road segments, road profiles, lane poses, elevated links, ramps and route lookup.
- `NYCCityChunkManager` builds road surfaces, markings, sidewalks, terrain, building footprints, props, elevated decks and static collision from the graph and shared placement rules. It streams 512 m chunks around the player with a bounded 3 x 3 active neighbourhood.
- `CityUrbanModel` supplies deterministic district profiles, parcel subdivision, park reservations, 2D spatial-hash queries and road-clearance tests used by the chunk manager.
- `TrafficSystem` owns a bounded pool of ten graph-aware AI vehicles. Vehicles progress edge to edge, maintain lane assignments, use protected signal phases, queue at red approaches, follow nearby traffic and blend position through turns.
- `Game` uses graph lane poses for player spawning, heading and reset alignment. Global-to-local world rebasing still shifts the player, traffic and streamed chunks together.
- The existing Rapier vehicle controller, suspension, steering, drivetrain, transmission, reverse, braking, audio, vehicle catalogue, camera, HUD and settings remain the vehicle/gameplay implementation.

The former `RoadPath` and `RoadChunkManager` remain in the repository for historical compatibility but are not used by `Game` or the active `TrafficSystem`.

## Hudson River and waterfront

`NYCWaterfrontLayout.ts` defines a shared curved river polygon in the game's ENU frame (+X east, +Y up, +Z north), including both banks, water width, below-surface riverbed and an inland shoreline-road offset. The road graph rejects ordinary surface edges that cross water; chunk roads, sidewalks, curbs and markings are clipped to land intervals derived from the same banks. Building footprints and roadside props that overlap the water are rejected, and a near-bank parcel strip is reserved as an open view corridor.

`NYCWaterfrontSystem.ts` builds a 6.2 km surface with animated wave normals, Fresnel response and cubemap environment reflections. The render target is explicitly owned and disposed; captures are throttled and only run near the river. The system includes a public promenade, seawall, piers, lights, benches and distant New Jersey skyline massing. Promenade, seawall, piers and pilings receive static Rapier colliders; the far-bank skyline is visual-only because no cross-river road connection is created.

The subsystem is integrated with game-loop rendering, day/night blending, origin rebasing and teardown. The coastline is a deterministic authored approximation, not a surveyed shoreline. The active base street network remains the legacy orthogonal prototype and is not yet replaced by NYC Street Centerline GIS geometry.

## City and district generation

The graph uses an ENU-style simulation frame in metres (+X east, +Y up, +Z north) and deterministic 160 m block spacing. The base road graph remains an orthogonal procedural grid with wider avenues, connecting streets, narrower one-way alleys and special grade-separated links. It is not the real Manhattan street-centreline dataset, and the current playable footprint is not a full five-borough map.

`CityUrbanModel.ts` replaces the former radial height bands and fixed four-building pattern with spatially varying, repeatable district profiles: financial, lower-Manhattan-inspired, Midtown-inspired, residential, west/east waterfront, industrial and outer urban areas. Profiles define different height ranges, lot subdivision counts, footprint proportions, palette families and park probabilities. Stable integer hashes make block layouts reproducible after streaming reloads. These district extents are authored game-design zones in the local simulation frame; they are not official neighbourhood boundaries or geospatially surveyed polygons.

Building placement reserves the graph road and sidewalk envelope, checks nearby footprints in a spatial hash, and rejects candidates intersecting special elevated-road right-of-way bounds. Park blocks remain open and receive a controlled number of trees. The block plan is still deliberately stylised: generated buildings are instanced massing with procedural windows, storefront glazing, sign fasciae and rooftop plant; they are not bespoke or address-accurate architectural assets.

## Road, bridge and underpass geometry

Surface road ribbons and lane markings are generated from graph lane/centreline poses. The existing interchange graph includes separate ground and deck node identities, entrance and exit ramps, an elevated roadway and a ground-level underpass. Ramp endpoints share graph node positions, and the centerline sampler supplies continuous 3D positions and tangents across connected ramp segments. Elevated decks, soffits, barriers, piers and pier caps are rendered and receive static Rapier collision.

Bridge-side barrier instances are aligned to the local road frame and placed at the edges of each elevated segment; the same transforms are used for visible instances and Rapier cuboid colliders. The new regression checks assert both directions of ramp graph connectivity, ramp endpoint-to-node alignment, sampled maximum grade, and that guardrail instances leave a central drivable opening. The underpass regression checks that the ground-level road remains reachable beneath the deck.

This remains a procedural representative interchange, not a civil-engineering model of a named NYC bridge. The current automated suite does not yet drive a player vehicle over every possible bridge/ramp route in both directions, nor does it validate all pier/foundation loads or every possible streamed chunk seam. Full route traversal in the browser is still required.

## Object placement and collision

Environmental placement uses the shared 2D spatial hash and road-clearance queries rather than arbitrary chunk-local coordinates. Streetlight bases are derived from graph road edges and sidewalk offsets. Park vegetation is confined to reserved green-space blocks, and tree trunks and streetlight poles receive static colliders from their visible transforms. Candidate placements are checked against the regular road grid, sampled special elevated-road/ramp geometry, generated building footprints and previously reserved props. Candidate IDs and positions derive from stable grid coordinates and seed values.

Every generated building spec creates a corresponding static Rapier cuboid collider matching its footprint, height and translation. The chunk diagnostics expose the number of building instances and building colliders; generation throws if those counts differ. Chunk disposal removes the shared static rigid body (and its colliders) and disposes chunk-owned geometries. These checks cover generated rectangular footprints; they do not constitute a full continuous collision-mesh coverage proof for every architectural detail.

## Terrain, streaming and physics

- Chunk generation is deterministic and scheduled with the player-centre chunk first, then neighbours by distance.
- Requests are de-duplicated while pending; chunks outside the active radius are removed.
- Geometry, Rapier rigid bodies and attached colliders are disposed together.
- Static terrain, road, sidewalk, curb, elevated-road, bridge-support and building collision is generated alongside the visible environment.
- The chunk manager and traffic pool preserve the global graph origin while local transforms are rebased to keep the physics world near the player.

The current streamer builds chunks on the main thread through asynchronous task scheduling. It bounds active world memory and rendering scope, but it is not yet a worker-thread meshing system or a city-wide offline GIS/mesh pipeline.

## Reconstruction progress and remaining acceptance criteria

Lane-specific highway access, AI lane filtering, right-shoulder ramp placement and guardrail openings shared by visible geometry and Rapier colliders are implemented. The Hudson now has one shared water mask used by graph connectivity, clipped road/sidewalk geometry, riverbed terrain, waterfront buildings and physical shoreline structures.

The complete city replacement remains unfinished. The 160 m orthogonal graph must still be replaced with a baked authoritative NYC street-centreline network. Surveyed elevation data, varied intersection topologies, functioning stop-sign and traffic-light control, end-to-end player traversal, real gameplay screenshots and in-browser performance measurements are outstanding.

## Materials and lighting

The renderer retains Three.js physically based materials, ACES tone mapping and sRGB output. Asphalt uses shared procedural albedo, normal and roughness maps with world-aligned UVs. The updated lighting path creates a restrained procedural equirectangular sky and prefilters it with `PMREMGenerator` for scene-level image-based lighting. It is a lightweight local environment approximation, not a captured HDR environment or a physically solved global-illumination system.

The directional sunlight and hemisphere fill now have a wider intensity separation. The sun target and position track the player so the existing shadow frustum follows the active streamed area. Shadow quality uses a higher map resolution at the high graphics preset and adjusted normal bias/filter radius. A subset of graph-aligned streetlights use low-cost, non-shadow-casting point sources at night; their intensity follows the day/night blend.

These changes improve directional contrast, PBR environment response and shadow stability, but the renderer still lacks a dedicated screen-space ambient-occlusion/reflection pipeline, real-time multi-bounce GI, detailed reflection probes per district, and full photometric streetlight calibration. No claim of photorealistic output is made without browser screenshots and visual tuning.

## Vehicle interaction improvements

- `N` toggles neutral from any forward ratio or the reverse-engagement state. Manual mode restores the last selected forward ratio; automatic mode chooses a speed/load-appropriate ratio from the vehicle's torque curve and refuses a re-engagement that would exceed the calibrated redline. The keyboard and clickable HUD selector use the same toggle path.
- Left/Right Shift provide a clutch pedal axis (held = disengaged; released = engaged). A progressive bite curve controls clutch torque capacity; with a gear engaged, the crankshaft follows driveline RPM as the clutch locks. Near idle, configured idle torque can produce wheel-force creep. This is a simplified single-plate clutch model, not a temperature/wear or multi-plate simulation.
- Closed-throttle overrun torque is transmitted as negative force through the selected driveline ratio; the former coast-brake wheel impulse has been removed. Neutral and an open clutch isolate this overrun torque.
- Space commands the rear-wheel handbrake using Rapier's per-wheel brake impulse. The HUD exposes active state.
- The current audio synthesis interpolates vehicle-specific cylinder and exhaust character, with a boost/load-dependent whistle and transient for configured twin-turbo vehicles. It does not substitute recorded samples.

## NYC Open Data and Google 3D Tiles

`NYCOpenDataClient` contains bounded-query helpers for official NYC Open Data building and street-centreline datasets, but those data are not yet integrated as the authoritative road/building source for gameplay generation. The procedural environment described above should therefore be treated as NYC-inspired, not geographically exact.

The optional Google Photorealistic 3D Tiles layer remains visualization-only. It is not used to extract geometry, create collision, reconstruct buildings, analyse tile imagery or generate persistent assets. The game world initializes without an API key. Set `VITE_GOOGLE_MAPS_API_KEY` locally or in the deployment environment; never commit the key. Requests remain subject to Google coverage, connectivity, quotas, billing and attribution requirements.

## Remaining limitations and validation boundary

- The base street graph is still orthogonal and 160 m-spaced; irregular Lower Manhattan streets, real road names, lane geometry, property parcels and actual five-borough geography are not yet imported from official source data.
- The district profiles are deterministic design zones, not GIS boundaries. Building footprints are parcel-like procedural subdivisions rather than authentic NYC property footprints.
- Bridge graph, deck, ramp and underpass geometry are present, but only a representative set of interchanges is generated. A full live vehicle traversal matrix and exhaustive bridge structural/collision audit remain outstanding.
- Building massing, facade detail and glass response remain procedural and relatively lightweight; realistic bespoke facades, signage text, storefront assets and high-rise architectural profiles remain future work.
- There is no real-time global illumination, baked lightmap pipeline, per-pixel contact AO, SSR, or high-end physically calibrated nighttime lighting.
- The CI tests run headlessly. They do not measure browser FPS, GPU frame time, memory pressure, or physics step cost under representative driving, and they do not replace street-level visual inspection. No browser visual inspection or performance benchmark is claimed for this update.

## Validation commands

- `npm run build`
- `npm run test:drivetrain`
- `npm run test:nyc-geo`
- `npm run test:city-urban`
- `npm run test:city-routing`
- `npm run test:world` (geospatial, urban-placement and city-routing integration regressions)
