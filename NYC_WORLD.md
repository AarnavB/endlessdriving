# NYC-inspired urban world

## Runtime architecture

The gameplay world is now a deterministic, fictionalised orthogonal city rather than a visual layer wrapped around the former endless highway.

- `CityRoadGraph` is the authoritative topology for generated intersections, directed segments, road profiles, lane poses and route lookup.
- `NYCCityChunkManager` renders and collides the same graph-derived road grid. The active world is streamed in 512 m chunks around the player; the 3 x 3 neighbourhood is the bounded active radius.
- `TrafficSystem` owns a bounded pool of ten graph-aware AI vehicles. Vehicles progress from edge to edge, maintain lane assignments, use protected axis phases plus exclusive direction-specific left-turn phases, queue at red approaches, follow nearby traffic and blend their position through turns.
- `Game` uses graph lane poses for player spawning, heading and reset alignment. Its global-to-local world rebasing still shifts the player, traffic and streamed chunks together.
- The existing Rapier vehicle controller, suspension, steering, drivetrain, transmission, reverse, braking, audio, vehicle catalogue, camera, HUD and settings remain the vehicle/gameplay implementation.

The former `RoadPath` and `RoadChunkManager` remain in the repository for historical compatibility but are no longer used by `Game` or the active `TrafficSystem`. The legacy highway is not a gameplay fallback.

## Fictional city generation

The graph uses an ENU-style simulation frame in metres (+X east, +Y up, +Z north) with deterministic 160 m block spacing. The grid is deliberately fictional and is not an operational copy of Manhattan's actual road map.

Road profiles include wider avenues, connecting streets, narrower one-way alleys and bridge-class corridors. The generated chunks include connected asphalt surfaces, lane dividers, double-yellow centre lines, pedestrian crossings, raised sidewalks, visible low curbs, block ground, collision-enabled buildings, upper-floor facade windows, instanced ground-floor retail glazing, metal frame bands, restrained sign fasciae, clustered rooftop plant/antenna details, streetlights and trees. Building footprints follow a deterministic four-parcel block layout; height bands transition from a high-rise core to commercial, residential and occasional low industrial districts. Shapes, heights and facade palettes are generated from stable integer hashes, so revisiting a chunk rebuilds the same content.

The road graph currently models a flat urban network. Bridge-class corridors are differentiated by width and speed profile, but surveyed bridge decks, tunnels, DEM-derived terrain and variable road grades are not yet implemented. Pedestrian visuals are crossings and sidewalks; autonomous pedestrian simulation is not included. Signal phases and placements are generic simulated game logic, not copied real-world signal programs.

## Vehicle interaction improvements (branch update)

- `N` toggles neutral from any forward ratio or the reverse-engagement state. Manual mode restores the last selected forward ratio; automatic mode chooses a speed/load-appropriate ratio from the vehicle's torque curve and refuses a re-engagement that would exceed the calibrated redline. The keyboard and clickable HUD selector use the same toggle path.
- Left/Right Shift now provide a clutch pedal axis (held = disengaged; released = engaged). A progressive bite curve controls clutch torque capacity; with a gear engaged, the crankshaft follows driveline RPM as the clutch locks. Near idle, the configured idle torque can produce actual wheel-force creep. This is a simplified single-plate clutch model, not a temperature/wear or multi-plate simulation.
- Closed-throttle overrun torque is transmitted as negative force through the selected driveline ratio; the former coast-brake wheel impulse has been removed. Neutral and an open clutch isolate this overrun torque.
- Space continues to command the rear-wheel handbrake using the Rapier wheel controller's per-wheel brake impulse. The HUD exposes active state.
- Digital speed/RPM readouts were shifted down and right inside the existing analogue gauge faces.
- The current audio synthesis interpolates vehicle-specific cylinder and exhaust character, with a boost/load-dependent whistle and transient for configured twin-turbo vehicles. It does not substitute recorded samples.

## Streaming and physics

- Chunk generation is deterministic and scheduled with the player-centre chunk first, then neighbours by distance.
- Requests are de-duplicated while pending; chunks outside the active radius are removed.
- Geometry, Rapier rigid bodies and attached colliders are disposed together.
- Static road, sidewalk, curb and building colliders are created from independent game geometry. The visible base ground is also collision-backed, so block interiors do not become physics voids.
- The chunk manager and traffic pool preserve the global graph origin while local transforms are rebased to keep the physics world near the player.

The current streamer builds chunks on the main thread through asynchronous task scheduling. It bounds active world memory and rendering scope, but it is not yet a worker-thread meshing system.

## Google Photorealistic 3D Tiles

The optional Google Photorealistic 3D Tiles layer remains visualization-only. It is not used to extract geometry, create collision, reconstruct buildings, analyse tile imagery or generate persistent assets. The game world initializes without an API key.

Set `VITE_GOOGLE_MAPS_API_KEY` in the local environment or Vercel project settings. Never commit the key. Google tile requests remain subject to coverage, connectivity, quotas and billing.

The renderer's active tile credits are dynamically aggregated, counted, sorted by occurrence and displayed in the attribution strip with the text “Google Maps”. This is the compact text-attribution fallback; the official unmodified Google Maps logo asset has not yet been packaged in this branch. For a production build with sufficient space, replace the text fallback with the official outlined logo from Google's Map Tiles API attribution asset package, observing its aspect ratio, contrast and clear-space requirements. Google data attribution must remain complete and visible alongside the logo.

Google prohibits extracting or interpreting tile content to create game geometry. The independently generated fictional city is separate from the optional visualization layer.

## Remaining limitations

- The road grid is an intentionally stylised city network, not an exact street-level map or a full five-borough recreation.
- Bridge profiles do not yet have raised deck/approach geometry; tunnels, underpasses and real terrain grades are not modelled.
- Player steering remains physics-driven. The road network provides connected surfaces and graph-aware reset/spawn alignment but does not force the player to follow a route.
- Traffic uses lane following, speed matching, intersection signals and turn transitions. It does not yet perform multi-lane overtaking, pedestrians, emergency vehicles or lane-specific turn pockets.
- Facades are deterministic procedural massing with instanced windows, basic ground-floor retail glazing/sign fasciae and rooftop details. They are not bespoke architectural reproductions, realistic text signage, or licensed commercial storefront assets.
- Physical traffic signal heads and left-turn arrows are streamed around the player and read the same axis/protected-left phases as AI traffic. Regulatory road signs, pedestrian signal heads, signal poles/overhead gantries on every road, and lane-specific protected-turn pockets are not yet implemented.
- Engine audio remains Web Audio synthesis. Vehicle-specific cylinder/induction/exhaust parameters and turbo lift-off transients improve differentiation, but the catalogue does not yet use licensed/recorded engine sample libraries or per-vehicle recorded gearshift/exhaust samples.
- Vehicle bodies are generated from per-car proportions and styling profiles with custom body/cabin/wheel/detail geometry. They are not yet production-grade, reference-accurate licensed vehicle models.
- The renderer currently uses Three.js PBR materials, ACES tone mapping, sRGB output, exponential fog, a hemisphere/directional light setup and preset-based shadow/AA scaling. A dedicated screen-space AO/reflection pipeline and high-end environment-map workflow have not yet been added.
- The integration regression exercises the graph, streaming, AI traffic, signal lifecycle and Rapier support in a headless world. Full browser playtesting is still required for final camera/visual tuning and long-session performance profiling.

## Validation commands

- `npm run build`
- `npm run test:drivetrain`
- `npm run test:nyc-geo`
- `npm run test:city-routing`
- `npm run test:world` (geospatial and city-routing regression suites)
