# Endless Driving — Phase 1

A browser-based 3D driving prototype built with Vite, TypeScript, Three.js, Rapier 3D, Tailwind CSS, and the Web Audio API.

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8 requirement)
- A modern desktop browser with WebGL 2 and Web Audio support

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Click **Start Driving** once to enable audio playback in the browser.

For a production build:

```bash
npm run build
npm run preview
```

## Vehicle movement and instrument-cluster milestone

The `fix/vehicle-movement` branch retains the Rapier movement/steering corrections and F3 physics diagnostics, and adds:

- A force-driven Rapier chassis with fixed-step propulsion, braking, reverse, lateral grip, drag, and steering.
- A real neutral transmission state. Neutral disconnects wheel propulsion, permits independent engine revving, and preserves coasting, drag, and braking. The player can select N through the HUD in automatic or manual mode.
- A paired analogue speedometer and tachometer. Both start at 6 o'clock and sweep clockwise through 270 degrees. Digital values are integrated into the dials, with an RPM gear indicator and redline feedback.
- A fixed pool of six kinematic traffic vehicles following the generated road centreline and lane offsets in both directions. Rapier colliders allow the player vehicle to interact with traffic; vehicles are recycled at a safe distance to keep object counts bounded.
- Post-physics odometer sampling, a session score, a locally persisted best distance, and distance milestone notifications.

## Phase 1 includes

- One controllable sports-car prototype with throttle, braking, reverse, steering, and handbrake.
- Six forward gears, automatic/manual transmission modes, neutral selection, and E/Q manual shifts.
- Rapier 3D rigid-body gravity and collision handling for the player chassis, traffic vehicles, streamed road surfaces, and roadside guardrails, with custom force-based propulsion and tire grip.
- Third-person chase, close-follow, and hood camera modes.
- A deterministic, chunk-streamed highway with smooth curves and elevation changes, four lanes, continuous edge/centre markings, roadside shoulders, and guardrails.
- A six-vehicle pooled traffic system that follows the shared curved road path; traffic does not yet navigate intersections or change lanes.
- Synthesized RPM-responsive engine tones and wind noise using the Web Audio API. No real engine samples are bundled.
- A responsive main menu, analogue instrument HUD, transmission selector, pause overlay, settings, controls reference, and local preferences/statistics persistence.
- Distance, session score, best-distance record, and distance milestones.
- Speed units (km/h / mph), graphics presets (Low / Medium / High), engine and wind/ambience volume, transmission preference, and FPS toggle.
- F3 physics diagnostics.

## Controls

| Input | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake, then reverse at low speed (neutral remains brake-only) |
| A / D or ← / → | Steer |
| Space | Handbrake |
| E / Q | Gear up / down while in manual mode; Q from first selects neutral |
| HUD gear selector | Select N, D, or a manual forward gear |
| M | Toggle automatic / manual transmission |
| C | Cycle camera |
| R | Reset vehicle position without clearing session distance |
| Esc | Pause / resume |
| H | Toggle HUD |
| N | Toggle mini-map |
| F3 | Toggle physics diagnostics |

## Known Phase 1 boundaries

This remains a playable prototype rather than a complete driving simulator. It has one fictional sports-car model and an effectively unbounded, deterministic highway generated in 120 m chunks. The active road window is bounded to two chunks behind and six ahead; old Three.js geometry and per-chunk Rapier bodies are disposed when sections leave that window. Five seeded environment profiles transition across regions. Traffic is currently six pooled road-following vehicles—there are no intersection turns, lane changes, traffic lights, pedestrians, or broader city traffic routing. There is no floating-origin rebase yet; the road path is addressable by world distance and typical driving sessions remain within practical float precision. The vehicle uses a single chassis collider with force-based tire grip rather than full wheel suspension/tire simulation. Engine and wind audio are synthesized; tire, brake, impact, and traffic audio are not yet implemented. Weather, multiple vehicles, advanced post-processing, texture streaming, adaptive resolution, VSync controls, gamepad support, and key remapping remain future work. The best-distance record is persisted locally; there is no cloud leaderboard or account sync.

For the technical architecture, folder tree and staged dependencies, see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).

## Architecture

- `src/game/` — lifecycle, keyboard input, camera follow, and pooled traffic
- `src/vehicles/` — vehicle dynamics and procedural vehicle mesh
- `src/world/` — seeded road path, environment profiles, chunk streaming, scenery, road markings, guardrails, and Rapier road colliders
- `src/audio/` — synthesized engine and wind audio
- `src/ui/` — menus, analogue instrument cluster, diagnostics and saved preferences
