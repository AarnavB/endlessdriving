# Endless Driving — technical plan

## Technical architecture

The browser client is split into six cooperating layers:

1. **Application shell (`main.ts`)** — loads persisted settings, initializes the game, and reports WebGL/physics startup failures in the UI.
2. **Game runtime (`game/`)** — owns the Three.js renderer, Rapier world, fixed-step physics update, input state, camera rig, day/night state, and performance sampling.
3. **Vehicle system (`vehicles/`)** — keeps the Rapier rigid-body chassis separate from the rendered vehicle model. A force-based handling layer applies propulsion, braking/reverse, lateral grip, steering yaw, and handbrake drag. This is a prototype vehicle controller, not a full four-wheel suspension/tire simulation.
4. **World system (`world/`)** — builds a deterministic prototype street grid, instanced building blocks, road markings, sidewalks, lighting, trees, and a Times Square-inspired feature. Generated buildings expose matching Rapier obstacle colliders.
5. **Audio system (`audio/`)** — uses Web Audio oscillators, filters, gain envelopes, and filtered noise for RPM-sensitive engine tone and speed-sensitive wind. The Phase 1 sound is synthesized, not recorded engine audio.
6. **Presentation (`ui/` + `styles.css`)** — owns menus, HUD, settings, keyboard reference, and localStorage preference persistence. The visual shell is HTML/CSS; Three.js owns the 3D canvas.

### Runtime flow

`InputManager` samples held keys and one-shot gear actions → `VehicleController` applies forces to the Rapier body → `Rapier.World.step()` resolves the body and building collisions → the rendered car and chase camera synchronize to the physics transform → audio and HUD consume telemetry → Three.js renders the frame.

The simulation is deliberately kept independent of the UI so later vehicle selection, chunk streaming, traffic, and statistics can be added without turning the game loop into one large file.

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
    │   └── CameraRig.ts
    ├── world/
    │   └── CityWorld.ts
    ├── vehicles/
    │   ├── VehicleController.ts
    │   └── vehicleVisual.ts
    ├── audio/
    │   └── EngineAudio.ts
    └── ui/
        └── UIController.ts
```

## Development stages and dependencies

| Stage | Deliverable | Depends on |
|---|---|---|
| **1 — Playable foundation** | Vite app, renderer, Rapier world, one controllable vehicle, keyboard input, cameras, responsive synthesized engine audio, starter city blockout and HUD | Core stack only |
| **2 — Vehicle systems** | Data-driven car/motorcycle roster, garage previews, vehicle-specific handling curves, customization, automatic/manual drivetrain refinements and layered sample audio | Stage 1 vehicle and audio interfaces |
| **3 — New York environment** | Recognizable district layouts, named landmarks and bridges, richer building/road assets, waterfronts and park districts | Stage 1 world/road conventions; asset pipeline if used |
| **4 — Endless world** | Deterministic chunk coordinate system, road ports at chunk boundaries, streaming and unloading, origin rebasing, persistence of generated seed/state | Stage 1 world separation + Stage 3 road conventions |
| **5 — Immersion** | Traffic AI and traffic lights, pedestrian ambience, weather/wet-road treatment, richer audio events and lighting polish | Stages 2–4 |
| **6 — Interface and optimization** | Full garage/menus, robust settings, saved statistics, LOD tiers, culling/instancing audit, adaptive quality and profiling | Stages 1–5 feature APIs |

## Current Phase 1 implementation boundary

Implemented in the source tree: the renderer/runtime, Rapier car chassis and building obstacle collision, keyboard driving, automatic/manual transmission toggle, chase/close/hood cameras, RPM-sensitive synthesized engine tone, synthesized wind, day/night lighting, a bounded Manhattan-like blockout, moving mini-map marker, HUD, pause/settings/control/about screens, FPS counter, and local settings persistence.

Not yet implemented: motorcycle or multiple vehicle roster, true wheel suspension/tire model, real recorded engine samples, traffic or pedestrians, detailed faithful NYC landmarks, chunk streaming/infinite roads, weather, full statistics persistence, key remapping, advanced post-processing (SSR/AO), adaptive resolution, VSync control, and controller/gamepad support. The map has a defined edge and is not endless yet.
