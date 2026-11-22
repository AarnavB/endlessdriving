# Endless Driving — technical plan

## Technical architecture

The browser client is split into six cooperating layers:

1. **Application shell (`main.ts`)** — loads persisted settings, initializes the game, and reports WebGL/physics startup failures in the UI.
2. **Game runtime (`game/`)** — owns the Three.js renderer, Rapier world, fixed-step physics update, input state, camera rig, day/night state, and performance sampling.
3. **Vehicle system (`vehicles/`)** — keeps the Rapier rigid-body chassis separate from the rendered vehicle model. A force-based handling layer applies propulsion, braking/reverse, lateral grip, steering yaw, and handbrake drag. This is a prototype vehicle controller, not a full four-wheel suspension/tire simulation.
4. **World system (`world/`)** — builds a deterministic prototype street grid, instanced building blocks, road markings, sidewalks, lighting, trees, and a Times Square-inspired feature. Generated buildings expose matching Rapier obstacle colliders.
5. **Audio system (`audio/`)** — uses Web Audio oscillators, filters, gain envelopes, and filtered noise for RPM-sensitive engine tone and speed-sensitive wind. The Phase 1 sound is synthesized, not recorded engine audio.
6. **Traffic system (`game/TrafficSystem.ts`)** — maintains a bounded pool of kinematic Rapier traffic vehicles, advances them in the fixed-step simulation, and recycles them ahead of the player.
7. **Presentation (`ui/` + `styles.css`)** — owns menus, analogue gauges, transmission selector, distance/score HUD, settings, keyboard reference, and localStorage preferences/statistics. The visual shell is HTML/CSS; Three.js owns the 3D canvas.

### Runtime flow

`InputManager` samples held keys and one-shot gear actions → `VehicleController` applies forces and updates drivetrain state → `TrafficSystem` advances its pooled kinematic vehicles → `Rapier.World.step()` resolves chassis, traffic and building collisions → the player car and traffic visuals synchronize to the physics transforms → the post-step odometer samples actual displacement → audio and HUD consume telemetry → Three.js renders the frame.

The simulation is deliberately kept independent of the UI. The current traffic pool is intentionally limited to the main north/south avenue; intersection routing and chunk streaming remain separate future systems.

## Project structure

```text
endless-driving/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── README.md
├── PROJECT_PLAN.md
└── src/
    ├── main.ts
    ├── types.ts
    ├── styles.css
    ├── game/
    │   ├── Game.ts
    │   ├── InputManager.ts
    │   ├── TrafficSystem.ts
    │   └── CameraRig.ts
    ├── world/
    │   └── CityWorld.ts
    ├── vehicles/
    │   ├── VehicleController.ts
    │   └── vehicleVisual.ts
    ├── audio/
    │   └── EngineAudio.ts
    └── ui/
        ├── UIController.ts
        ├── InstrumentCluster.css
        └── PhysicsDebugOverlay.ts
```

## Development stages and dependencies

| Stage | Deliverable | Depends on |
|---|---|---|
| **1 — Playable foundation** | Vite app, renderer, Rapier world, one controllable vehicle, fixed-step keyboard input, camera rig, synthesized audio, starter city blockout, analogue gauges, neutral drivetrain, basic pooled traffic and local distance records | Core stack only |
| **2 — Vehicle systems** | Data-driven car/motorcycle roster, garage previews, vehicle-specific handling curves, customization, deeper drivetrain simulation and layered sample audio | Stage 1 vehicle and audio interfaces |
| **3 — New York environment** | Recognizable district layouts, named landmarks and bridges, richer building/road assets, waterfronts and park districts | Stage 1 world/road conventions; asset pipeline if used |
| **4 — Endless world** | Deterministic chunk coordinate system, road ports at chunk boundaries, streaming and unloading, origin rebasing, persistence of generated seed/state | Stage 1 world separation + Stage 3 road conventions |
| **5 — Immersion** | Intersection-aware traffic routing, lane changes and traffic lights, pedestrian ambience, weather/wet-road treatment, richer audio events and lighting polish | Stages 2–4 |
| **6 — Interface and optimization** | Full garage/menus, robust settings, cloud/leaderboard statistics, LOD tiers, culling/instancing audit, adaptive quality and profiling | Stages 1–5 feature APIs |

## Current Phase 1 implementation boundary

Implemented in the source tree: the renderer/runtime, Rapier car chassis and building obstacle collision, fixed-step keyboard driving, automatic/manual/neutral transmission states, analogue speedometer and tachometer, RPM-responsive synthesized engine tone, synthesized wind, day/night lighting, a bounded Manhattan-like blockout, six pooled kinematic traffic cars on the main avenue, moving mini-map marker, post-physics distance/score/best-distance HUD, milestone notifications, pause/settings/control/about screens, F3 diagnostics, and local settings/statistics persistence.

Not yet implemented: motorcycle or multiple vehicle roster, true wheel suspension/tire model, real recorded engine samples, intersection-aware traffic routing, lane changes, traffic lights, pedestrians, detailed faithful NYC landmarks, chunk streaming/infinite roads, weather, cloud statistics/leaderboards, key remapping, advanced post-processing (SSR/AO), adaptive resolution, VSync control, and controller/gamepad support. Traffic currently follows straight lanes on one avenue, and the map still has a defined edge.
