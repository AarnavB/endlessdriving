import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { InputManager } from './InputManager';
import { CameraRig } from './CameraRig';
import { TrafficSystem } from './TrafficSystem';
import { NYCCityChunkManager } from '../world/nyc/NYCCityChunkManager';
import { CityRoadGraph } from '../world/nyc/CityRoadGraph';
import { GooglePhotorealisticTiles } from '../world/nyc/GooglePhotorealisticTiles';
import { NYCEnvironmentLighting } from '../world/nyc/NYCEnvironmentLighting';
import { VehicleController } from '../vehicles/VehicleController';
import { getVehicleDefinition, loadSelectedVehicleId, saveSelectedVehicleId } from '../vehicles/VehicleDefinitions';
import { GaragePreview } from '../vehicles/GaragePreview';
import { EngineAudio } from '../audio/EngineAudio';
import { UIController } from '../ui/UIController';
import { PhysicsDebugOverlay } from '../ui/PhysicsDebugOverlay';
import type { GameSettings, InputState, VehicleTelemetry } from '../types';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000);
  private readonly input = new InputManager();
  private readonly audio = new EngineAudio();
  private readonly cameraRig: CameraRig;
  private readonly ui: UIController;
  private readonly garagePreview: GaragePreview;
  private readonly debugOverlay: PhysicsDebugOverlay;
  private readonly trafficPlayerPosition = new THREE.Vector3();
  private readonly sunFocusPosition = new THREE.Vector3();
  private readonly sunTarget = new THREE.Object3D();
  private readonly clock = new THREE.Clock();
  private readonly fixedTimeStep = 1 / 60;
  private physicsAccumulator = 0;
  private roadPitchSampleTicks = 0;
  private latestTelemetry: VehicleTelemetry | null = null;
  private readonly roadGraph = new CityRoadGraph(20261124);
  private readonly worldOffset = new THREE.Vector3();
  private worldScene!: NYCCityChunkManager;
  private googleTiles: GooglePhotorealisticTiles | null = null;
  private physics!: RAPIER.World;
  private vehicle!: VehicleController;
  private traffic!: TrafficSystem;
  private running = false;
  private paused = true;
  private hasStartedDriving = false;
  private hudVisible = true;
  private manualTransmission = false;
  private debugVisible = false;
  private raf = 0;
  private lastFpsTime = performance.now();
  private frameCount = 0;
  private fps = 0;
  private dayPhase = 0.38;
  private readonly hemi = new THREE.HemisphereLight(0xdbe9f2, 0x373d43, 0.85);
  private readonly sun = new THREE.DirectionalLight(0xffe3bd, 3.0);
  private readonly environmentLighting: NYCEnvironmentLighting;

  private constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, settings: GameSettings) {
    this.manualTransmission = settings.transmission === 'manual';
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.graphics === 'high',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.graphics === 'low' ? 0.85 : settings.graphics === 'medium' ? 1 : 1.25));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = settings.graphics === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.environmentLighting = new NYCEnvironmentLighting(this.renderer, this.scene);
    this.scene.add(this.hemi);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sunTarget);
    this.sun.position.set(-55, 105, 38);
    this.sun.castShadow = settings.graphics === 'high';
    const shadowResolution = settings.graphics === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.sun.shadow.camera.left = -110;
    this.sun.shadow.camera.right = 110;
    this.sun.shadow.camera.top = 110;
    this.sun.shadow.camera.bottom = -110;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 3.5;
    this.scene.add(this.sun);

    this.audio.setEngineVolume(settings.engineVolume);
    this.audio.setEffectsVolume(settings.effectsVolume);
    this.cameraRig = new CameraRig(this.camera);
    this.ui = new UIController(uiRoot, settings);
    this.garagePreview = new GaragePreview(this.ui.getGaragePreviewCanvas());
    this.debugOverlay = new PhysicsDebugOverlay(uiRoot);
    const initialVehicle = getVehicleDefinition(loadSelectedVehicleId());
    this.garagePreview.setVehicle(initialVehicle);

    this.ui.onStart(() => this.startDriving());
    this.ui.onResume(() => this.resume());
    this.ui.onPause(() => this.pause());
    this.ui.onReset(() => this.resetVehicle());
    this.ui.onSettings((next) => this.applySettings(next));
    this.ui.onRestart(() => this.restartDrive());
    this.ui.onGearSelect((selection) => {
      if (!this.hasStartedDriving || this.paused) return;
      if (selection === 'drive') this.vehicle.selectGear(1);
      else if (selection === 0) this.vehicle.toggleNeutral();
      else this.vehicle.selectGear(selection);
      for (const event of this.vehicle.drainShiftEvents()) this.audio.playShiftEvent(event);
    });
    this.ui.onTransmissionToggle(() => this.toggleTransmission());
    this.ui.onVehiclePreview((vehicleId) => this.garagePreview.setVehicle(getVehicleDefinition(vehicleId)));
    this.ui.onVehicleSelect((vehicleId) => this.selectVehicle(vehicleId));
    this.ui.onTripReset(() => this.vehicle.resetTrip());
    this.ui.onGarageRotate((enabled) => this.garagePreview.setAutoRotate(enabled));

    this.input.on('pause', () => {
      if (!this.hasStartedDriving) return;
      this.paused ? this.resume() : this.pause();
    });
    this.input.on('camera', () => {
      if (!this.hasStartedDriving || this.paused) return;
      this.ui.setCameraLabel(this.cameraRig.cycle());
    });
    this.input.on('reset', () => {
      if (this.hasStartedDriving && !this.paused) this.resetVehicle();
    });
    this.input.on('hud', () => {
      if (!this.hasStartedDriving) return;
      this.hudVisible = !this.hudVisible;
      this.ui.setHudVisible(this.hudVisible);
    });
    this.input.on('transmission', () => this.toggleTransmission());
    this.input.on('debug', () => {
      if (!this.hasStartedDriving) return;
      this.debugVisible = !this.debugVisible;
      this.debugOverlay.setVisible(this.debugVisible);
    });

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  static async create(canvas: HTMLCanvasElement, uiRoot: HTMLElement, settings: GameSettings): Promise<Game> {
    await RAPIER.init();
    const game = new Game(canvas, uiRoot, settings);
    await game.initializePhysics();
    game.initializeGoogleTiles();
    game.startLoop();
    return game;
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.input.dispose();
    this.audio.dispose();
    this.garagePreview.dispose();
    this.vehicle.dispose(this.physics, this.scene);
    this.debugOverlay.dispose();
    this.traffic.dispose();
    this.worldScene.dispose();
    this.googleTiles?.dispose();
    this.environmentLighting.dispose(this.scene);
    this.renderer.dispose();
    this.physics.free();
  }

  private getSpawnPosition(): THREE.Vector3 {
    const pose = this.roadGraph.getSpawnPose();
    return new THREE.Vector3(
      pose.position.x - this.worldOffset.x,
      pose.position.y + 0.72 - this.worldOffset.y,
      pose.position.z - this.worldOffset.z,
    );
  }

  private getRoadHeadingAt(position: THREE.Vector3): THREE.Vector3 {
    const forward = this.vehicle?.getForward() ?? new THREE.Vector3(0, 0, 1);
    const tangent = this.roadGraph.getNearestRoadHeading(
      position.x + this.worldOffset.x,
      position.z + this.worldOffset.z,
      forward.x,
      forward.z,
      position.y + this.worldOffset.y,
    );
    return new THREE.Vector3(tangent.x, tangent.y, tangent.z);
  }

  /**
   * Rebase at a 2.5 km local radius. Total distance is accumulated by the
   * vehicle controller, while path/chunk indices continue in global distance.
   */
  private maybeRebaseWorld(): boolean {
    const position = this.vehicle.getPosition();
    if (Math.max(Math.abs(position.x), Math.abs(position.z)) < 2500) return false;

    const delta = new THREE.Vector3(position.x, 0, position.z);
    this.vehicle.rebase(delta);
    this.traffic.rebase(delta);
    this.worldScene.rebase(delta);
    this.worldOffset.add(delta);
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    return true;
  }

  private selectVehicle(vehicleId: string): void {
    const definition = getVehicleDefinition(vehicleId);
    if (this.vehicle?.definition.id === definition.id) {
      saveSelectedVehicleId(definition.id);
      this.ui.setSelectedVehicle(definition.id);
      return;
    }
    // Vehicle changes are only accepted from the menu or while the simulation is paused.
    if (this.hasStartedDriving && !this.paused) {
      this.ui.setSelectedVehicle(this.vehicle.definition.id);
      return;
    }
    const position = this.vehicle.getPosition();
    const forward = this.vehicle.getForward();
    this.vehicle.dispose(this.physics, this.scene);
    this.vehicle = new VehicleController(this.physics, this.scene, definition);
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.vehicle.reset(position, false, forward);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    saveSelectedVehicleId(definition.id);
    this.ui.setSelectedVehicle(definition.id);
    this.garagePreview.setVehicle(definition);
  }

  private toggleTransmission(): void {
    if (!this.hasStartedDriving || this.paused) return;
    this.manualTransmission = !this.manualTransmission;
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.ui.setTransmissionMode(this.manualTransmission ? 'MANUAL' : 'AUTO', true);
  }

  private async initializePhysics(): Promise<void> {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = this.fixedTimeStep;
    this.physics.numSolverIterations = 8;
    this.physics.numInternalPgsIterations = 2;

    const spawnPosition = this.getSpawnPosition();
    const cityWorld = new NYCCityChunkManager(this.scene, this.physics, this.roadGraph);
    await cityWorld.initialize(spawnPosition);
    this.worldScene = cityWorld;

    this.vehicle = new VehicleController(this.physics, this.scene, getVehicleDefinition(loadSelectedVehicleId()));
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.vehicle.reset(spawnPosition, true, this.getRoadHeadingAt(spawnPosition));
    this.traffic = new TrafficSystem(this.physics, this.scene, this.roadGraph, spawnPosition);
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    this.latestTelemetry = this.vehicle.getTelemetry();
  }

  private initializeGoogleTiles(): void {
    const environment = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
    const apiKey = environment.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.info('Google Photorealistic 3D Tiles disabled: VITE_GOOGLE_MAPS_API_KEY is not configured.');
      return;
    }
    try {
      this.googleTiles = new GooglePhotorealisticTiles(this.scene, this.camera, this.renderer, apiKey);
    } catch (error) {
      console.error('Google Photorealistic 3D Tiles could not initialize:', error);
      this.googleTiles = null;
    }
  }

  private startLoop(): void {
    this.running = true;
    this.clock.start();

    const frame = (): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      const frameDt = THREE.MathUtils.clamp(this.clock.getDelta(), 0, 0.05);

      try {
        if (!this.paused) this.step(frameDt);
        else this.input.drainEdges();
        this.garagePreview.update(frameDt, this.ui.isGarageVisible());
        this.googleTiles?.update();
        this.renderer.render(this.scene, this.camera);
        this.updateFps();
      } catch (error) {
        // Keep the animation loop alive and show the actual failure instead of leaving
        // the player with a running audio context and a frozen/invisible car.
        console.error('Endless Driving frame failed:', error);
        this.paused = true;
        this.ui.showRuntimeError(error);
        try { this.renderer.render(this.scene, this.camera); } catch (renderError) {
          console.error('WebGL render failed:', renderError);
        }
      }
    };

    frame();
  }

  private step(frameDt: number): void {
    const currentInput = this.input.getState();
    this.physicsAccumulator = Math.min(
      this.physicsAccumulator + frameDt,
      this.fixedTimeStep * 4,
    );

    let steps = 0;
    while (this.physicsAccumulator >= this.fixedTimeStep && steps < 4) {
      const tickInput: InputState = steps === 0
        ? currentInput
        : { ...currentInput, shiftUpPressed: false, shiftDownPressed: false };

      // Sample the graph grade at 10 Hz, then smoothly apply it in the
      // vehicle controller at the physics rate. This avoids a per-frame
      // nearest-road graph scan while preserving ramp pitch alignment.
      const playerPosition = this.vehicle.getPosition(this.trafficPlayerPosition);
      if (this.roadPitchSampleTicks++ % 6 === 0) {
        this.vehicle.setRoadTangent(this.getRoadHeadingAt(playerPosition));
      }

      // Controls and forces are prepared before this fixed solver tick.
      this.vehicle.update(this.fixedTimeStep, tickInput);
      for (const event of this.vehicle.drainShiftEvents()) this.audio.playShiftEvent(event);
      this.traffic.update(this.fixedTimeStep, playerPosition);
      this.physics.step();
      this.vehicle.syncVisual();
      this.traffic.syncVisuals();

      // Read position and velocity only after Rapier has integrated the body.
      this.latestTelemetry = this.vehicle.getTelemetry();
      if (this.maybeRebaseWorld()) this.latestTelemetry = this.vehicle.getTelemetry();
      this.worldScene.update(this.vehicle.getPosition(this.trafficPlayerPosition));
      this.physicsAccumulator -= this.fixedTimeStep;
      steps++;

      if (steps === 1) this.input.consumeEdges();
    }

    const telemetry = this.latestTelemetry;
    if (telemetry) {
      const position = this.vehicle.getPosition();
      const forward = this.vehicle.getForward();
      this.cameraRig.update(frameDt, position, forward);
      this.audio.update(
        telemetry.rpm,
        currentInput.throttle,
        telemetry.speedMps,
        telemetry.engineLoad,
        this.vehicle.definition,
      );
      this.ui.updateTelemetry(telemetry, this.fps, this.cameraRig.mode, this.dayPhase);

      if (this.debugVisible) {
        this.debugOverlay.update(
          this.vehicle.getDebugTelemetry(currentInput, this.fixedTimeStep, steps),
          this.cameraRig.mode,
          this.camera.position.distanceTo(position),
        );
      }
    }

    this.dayPhase = (this.dayPhase + frameDt * 0.00048) % 1;
    const night = THREE.MathUtils.clamp((Math.cos(this.dayPhase * Math.PI * 2) + 0.25) * 0.72, 0, 1);
    this.worldScene.setNightBlend(night);
    this.sun.intensity = THREE.MathUtils.lerp(0.04, 3.0, 1 - night);
    this.hemi.intensity = THREE.MathUtils.lerp(0.12, 0.85, 1 - night);
    // Keep the directional-light shadow frustum centred on the active vehicle.
    // Without this anchor, the fixed 220 m shadow camera loses the player as
    // the endless world streams away from the origin.
    this.vehicle.getPosition(this.sunFocusPosition);
    this.sunTarget.position.copy(this.sunFocusPosition);
    this.sun.position.set(
      this.sunFocusPosition.x + Math.cos(this.dayPhase * Math.PI * 2) * 125,
      this.sunFocusPosition.y + 22 + Math.sin(this.dayPhase * Math.PI * 2) * 90,
      this.sunFocusPosition.z + 38,
    );
  }

  private startDriving(): void {
    if (this.hasStartedDriving && !this.paused) return;
    this.hasStartedDriving = true;
    this.paused = false;
    this.physicsAccumulator = 0;
    const spawnPosition = this.getSpawnPosition();
    this.vehicle.reset(spawnPosition, true, this.getRoadHeadingAt(spawnPosition));
    this.worldScene.reset(spawnPosition);
    this.traffic.reset(spawnPosition);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    this.ui.resetSessionProgress();
    this.ui.showGame();
    this.clock.getDelta();

    // Unlock the layered engine-and-exhaust sound on the user gesture so
    // browsers do not block Web Audio before the first simulation frame.
    void this.audio.unlock(this.vehicle.definition).catch((error: unknown) => {
      console.warn('Recorded engine audio could not be enabled:', error);
    });
  }

  private pause(): void {
    if (this.paused || !this.hasStartedDriving) return;
    this.paused = true;
    this.physicsAccumulator = 0;
    this.audio.pause();
    this.ui.showPause();
  }

  private resume(): void {
    if (!this.paused || !this.hasStartedDriving) return;
    this.paused = false;
    this.physicsAccumulator = 0;
    this.audio.resume();
    this.ui.showGame();
    this.clock.getDelta();
  }

  private resetVehicle(): void {
    const position = this.vehicle.getPosition();
    const globalPosition = new THREE.Vector3(
      position.x + this.worldOffset.x,
      position.y + this.worldOffset.y,
      position.z + this.worldOffset.z,
    );
    const preferred = this.vehicle.getForward();
    const lane = this.roadGraph.getNearestLanePose(
      globalPosition.x, globalPosition.z, preferred.x, preferred.z, globalPosition.y,
    );
    position.set(
      lane.position.x - this.worldOffset.x,
      lane.position.y + 0.72 - this.worldOffset.y,
      lane.position.z - this.worldOffset.z,
    );
    this.vehicle.reset(position, false, new THREE.Vector3(lane.tangent.x, lane.tangent.y, lane.tangent.z));
    this.worldScene.reset(position);
    this.traffic.reset(position);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
  }

  private restartDrive(): void {
    const spawnPosition = this.getSpawnPosition();
    this.vehicle.reset(spawnPosition, true, this.getRoadHeadingAt(spawnPosition));
    this.worldScene.reset(spawnPosition);
    this.traffic.reset(spawnPosition);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    this.ui.resetSessionProgress();
    this.resume();
  }

  private applySettings(settings: GameSettings): void {
    this.audio.setEngineVolume(settings.engineVolume);
    this.audio.setEffectsVolume(settings.effectsVolume);
    this.manualTransmission = settings.transmission === 'manual';
    this.vehicle?.setManualTransmission(this.manualTransmission);
    this.ui.setTransmissionMode(this.manualTransmission ? 'MANUAL' : 'AUTO', false);

    const low = settings.graphics === 'low';
    const high = settings.graphics === 'high';
    this.renderer.shadowMap.enabled = high;
    this.sun.castShadow = high;
    const shadowResolution = high ? 2048 : 1024;
    this.sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 0.85 : high ? 1.25 : 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private updateFps(): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / Math.max(1, now - this.lastFpsTime));
      this.frameCount = 0;
      this.lastFpsTime = now;
      this.ui.setFps(this.fps);
    }
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.vehicle?.flushOdometer();
      if (!this.paused) this.pause();
    }
  };
}
