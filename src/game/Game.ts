import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { InputManager } from './InputManager';
import { CameraRig } from './CameraRig';
import { TrafficSystem } from './TrafficSystem';
import { CityWorld } from '../world/CityWorld';
import { VehicleController } from '../vehicles/VehicleController';
import { EngineAudio } from '../audio/EngineAudio';
import { UIController } from '../ui/UIController';
import { PhysicsDebugOverlay } from '../ui/PhysicsDebugOverlay';
import type { GameSettings, InputState, VehicleTelemetry } from '../types';

// Keep the floor contact consistent with the chassis collider. Tyre grip is
// modelled in VehicleController; high box-on-floor friction pins the car in place.
const ROAD_COLLISION_FRICTION = 0.08;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);
  private readonly input = new InputManager();
  private readonly audio = new EngineAudio();
  private readonly cameraRig: CameraRig;
  private readonly ui: UIController;
  private readonly debugOverlay: PhysicsDebugOverlay;
  private readonly trafficPlayerPosition = new THREE.Vector3();
  private readonly clock = new THREE.Clock();
  private readonly fixedTimeStep = 1 / 60;
  private physicsAccumulator = 0;
  private latestTelemetry: VehicleTelemetry | null = null;
  private readonly worldScene: CityWorld;
  private physics!: RAPIER.World;
  private vehicle!: VehicleController;
  private traffic!: TrafficSystem;
  private running = false;
  private paused = true;
  private hasStartedDriving = false;
  private hudVisible = true;
  private manualTransmission = false;
  private mapVisible = true;
  private debugVisible = false;
  private raf = 0;
  private lastFpsTime = performance.now();
  private frameCount = 0;
  private fps = 0;
  private dayPhase = 0.38;
  private readonly hemi = new THREE.HemisphereLight(0xdbe9f2, 0x373d43, 1.55);
  private readonly sun = new THREE.DirectionalLight(0xffe3bd, 2.15);

  private constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, settings: GameSettings) {
    this.manualTransmission = settings.transmission === 'manual';
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.graphics !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.graphics === 'low' ? 1 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = settings.graphics !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.add(this.hemi);
    this.sun.position.set(-55, 105, 38);
    this.sun.castShadow = settings.graphics !== 'low';
    const shadowResolution = settings.graphics === 'high' ? 1024 : 512;
    this.sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.sun.shadow.camera.left = -110;
    this.sun.shadow.camera.right = 110;
    this.sun.shadow.camera.top = 110;
    this.sun.shadow.camera.bottom = -110;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.00025;
    this.scene.add(this.sun);

    this.audio.setEngineVolume(settings.engineVolume);
    this.audio.setEffectsVolume(settings.effectsVolume);
    this.cameraRig = new CameraRig(this.camera);
    this.worldScene = new CityWorld(this.scene);
    this.ui = new UIController(uiRoot, settings);
    this.debugOverlay = new PhysicsDebugOverlay(uiRoot);

    this.ui.onStart(() => this.startDriving());
    this.ui.onResume(() => this.resume());
    this.ui.onPause(() => this.pause());
    this.ui.onReset(() => this.resetVehicle());
    this.ui.onSettings((next) => this.applySettings(next));
    this.ui.onRestart(() => this.restartDrive());
    this.ui.onGearSelect((selection) => {
      if (!this.hasStartedDriving || this.paused) return;
      this.vehicle.selectGear(selection === 'drive' ? 1 : selection);
    });
    this.ui.onTransmissionToggle(() => this.toggleTransmission());

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
    this.input.on('map', () => {
      if (!this.hasStartedDriving) return;
      this.mapVisible = !this.mapVisible;
      this.ui.setMapVisible(this.mapVisible);
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
    game.initializePhysics();
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
    this.debugOverlay.dispose();
    this.traffic.dispose();
    this.renderer.dispose();
    this.physics.free();
  }

  private toggleTransmission(): void {
    if (!this.hasStartedDriving || this.paused) return;
    this.manualTransmission = !this.manualTransmission;
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.ui.setTransmissionMode(this.manualTransmission ? 'MANUAL' : 'AUTO', true);
  }

  private initializePhysics(): void {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = this.fixedTimeStep;

    const floor = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.24, 0),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(280, 0.24, 280).setFriction(ROAD_COLLISION_FRICTION),
      floor,
    );

    for (const obstacle of this.worldScene.getBuildingColliders()) {
      const halfAngle = obstacle.rotation / 2;
      const body = this.physics.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(obstacle.x, obstacle.y, obstacle.z)
          .setRotation({
            x: 0,
            y: Math.sin(halfAngle),
            z: 0,
            w: Math.cos(halfAngle),
          }),
      );
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(obstacle.halfWidth, obstacle.halfHeight, obstacle.halfDepth)
          .setFriction(0.9),
        body,
      );
    }

    this.vehicle = new VehicleController(this.physics, this.scene);
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.vehicle.reset(new THREE.Vector3(0, 0.72, -70), true);
    this.traffic = new TrafficSystem(this.physics, this.scene, -70);
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    this.latestTelemetry = this.vehicle.getTelemetry();
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

      // Controls and forces are prepared before this fixed solver tick.
      this.vehicle.update(this.fixedTimeStep, tickInput);
      this.traffic.update(this.fixedTimeStep, this.vehicle.getPosition(this.trafficPlayerPosition));
      this.physics.step();
      this.vehicle.syncVisual();
      this.traffic.syncVisuals();

      // Read position and velocity only after Rapier has integrated the body.
      this.latestTelemetry = this.vehicle.getTelemetry();
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
        this.vehicle.getLastShiftTime(),
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
    this.sun.intensity = THREE.MathUtils.lerp(0.25, 2.15, 1 - night);
    this.hemi.intensity = THREE.MathUtils.lerp(0.35, 1.55, 1 - night);
    this.sun.position.set(
      Math.cos(this.dayPhase * Math.PI * 2) * 110,
      22 + Math.sin(this.dayPhase * Math.PI * 2) * 90,
      38,
    );
  }

  private startDriving(): void {
    if (this.hasStartedDriving && !this.paused) return;
    this.hasStartedDriving = true;
    this.paused = false;
    this.physicsAccumulator = 0;
    this.vehicle.reset(new THREE.Vector3(0, 0.72, -70), true);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
    this.ui.resetSessionProgress();
    this.ui.showGame();
    this.clock.getDelta();

    // Start immediately on the click gesture; do not block the render/physics loop on
    // AudioContext.resume(), which can resolve asynchronously on some browsers.
    void this.audio.unlock().catch((error: unknown) => {
      console.warn('Audio could not be enabled:', error);
    });
  }

  private pause(): void {
    if (this.paused || !this.hasStartedDriving) return;
    this.paused = true;
    this.physicsAccumulator = 0;
    this.ui.showPause();
  }

  private resume(): void {
    if (!this.paused || !this.hasStartedDriving) return;
    this.paused = false;
    this.physicsAccumulator = 0;
    this.ui.showGame();
    this.clock.getDelta();
  }

  private resetVehicle(): void {
    const position = this.vehicle.getPosition();
    position.y = 0.72;
    this.vehicle.reset(position);
    this.latestTelemetry = this.vehicle.getTelemetry();
    this.cameraRig.snap(this.vehicle.getPosition(), this.vehicle.getForward());
  }

  private restartDrive(): void {
    this.vehicle.reset(new THREE.Vector3(0, 0.72, -70), true);
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
    this.renderer.shadowMap.enabled = !low;
    this.sun.castShadow = !low;
    const shadowResolution = high ? 1024 : 512;
    this.sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1 : 1.5));
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
    if (document.hidden && !this.paused) this.pause();
  };
}
