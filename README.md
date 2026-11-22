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

## 0.1.1 gameplay hotfix

This build fixes the Phase 1 driving-loop issues:

- Replace the unsupported `RigidBody.applyForce()` call with Rapier JavaScript's `RigidBody.addForce()` method; clear the previous persistent force before applying each physics tick's propulsion, grip and drag. The old call could throw on the first update and stop all game simulation while audio had already started.
- Synchronize the car mesh immediately on spawn/reset and snap the camera to the correct chase-camera position.
- Capture keyboard input at document level, retain one-shot gear changes until a physics tick consumes them, and show a visible diagnostic panel if a runtime exception interrupts the game loop.
- Improve steering authority and reverse behavior, correct the tire-to-road visual alignment, and instance the lane markings to reduce draw calls.

## Phase 1 includes

- A controllable sports-car prototype with throttle, braking, reverse, steering, handbrake, a six-speed automatic gearbox, and manual gear up/down inputs.
- Rapier 3D rigid-body gravity and collision handling for the chassis, plus custom force-based propulsion, lateral tire grip, and static building obstacle colliders.
- Third-person chase, close-follow, and hood camera modes.
- A procedural Manhattan-inspired street grid with sidewalks, lane markings, buildings, trees, streetlights, and a Times Square-inspired sign corner.
- Synthesized RPM-responsive engine tones and wind noise using Web Audio API. No real engine samples are bundled.
- A responsive main menu, HUD, pause overlay, settings, controls reference, and local settings persistence.
- Speed units (km/h / mph), graphics presets (Low / Medium / High), engine and wind/ambience volume, transmission preference and FPS toggle.

## Controls

| Input | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake, then reverse at low speed |
| A / D or ← / → | Steer |
| Space | Handbrake |
| E / Q | Gear up / down while in manual mode |
| M | Toggle automatic / manual transmission |
| C | Cycle camera |
| R | Reset vehicle |
| Esc | Pause / resume |
| H | Toggle HUD |
| N | Toggle mini-map |

## Known Phase 1 boundaries

This is a playable foundation, not the complete feature list in the project brief. It currently has one fictional sports-car model, a bounded prototype city grid, no AI traffic, no pedestrians, no real engine recordings, no weather system, and no endless chunk streaming. The world-generation and vehicle-roster systems are scheduled for later phases. The graphics presets currently adjust renderer pixel ratio and shadow use; advanced SSR, AO, texture streaming, VSync and adaptive resolution are not implemented yet. Automatic and manual transmission modes are both available (M toggles in-game; the selection is saved; E/Q shift in manual mode). The secondary volume setting controls synthesized wind/ambience for this phase; tire, brake, impact and traffic effects are not part of Phase 1.

For the complete technical architecture, folder tree and staged dependencies, see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).

## Architecture

- `src/game/` — lifecycle, keyboard input, camera follow
- `src/vehicles/` — vehicle dynamics and procedural vehicle mesh
- `src/world/` — city blockout and environment generation
- `src/audio/` — synthesized engine and wind audio
- `src/ui/` — menus, HUD and saved preferences
