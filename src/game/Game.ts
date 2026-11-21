import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { InputManager } from './InputManager';
import { CameraRig } from './CameraRig';
import { CityWorld } from '../world/CityWorld';
import { VehicleController } from '../vehicles/VehicleController';
import { EngineAudio } from '../audio/EngineAudio';
import { UIController } from '../ui/UIController';
import type { GameSettings, VehicleTelemetry } from '../types';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 850);
  private readonly input = new InputManager();
  private readonly audio = new EngineAudio();
  private readonly cameraRig: CameraRig;
  private readonly ui: UIController;
  private readonly clock = new THREE.Clock();
  private readonly fixedTimeStep = 1 / 60;
  private physicsAccumulator = 0;
  private latestTelemetry: VehicleTelemetry | null = null;
  private readonly worldScene: CityWorld;
  private physics!: RAPIER.World;
  private vehicle!: VehicleController;
  private running = false;
  private paused = true;
  private hudVisible = true;
  private manualTransmission = false;
  private mapVisible = true;
  private raf = 0;
  private lastFpsTime = 0;
  private frameCount = 0;
  private fps = 0;
  private totalDriveSeconds = 0;
  private dayPhase = 0.38;
  private readonly hemi = new THREE.HemisphereLight(0xdbe9f2, 0x373d43, 1.55);
  private readonly sun = new THREE.DirectionalLight(0xffe3bd, 2.15);

  private constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, settings: GameSettings) {
    this.manualTransmission = settings.transmission === 'manual';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.graphics !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.graphics === 'low' ? 1 : 1.6));
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
    this.scene.add(this.sun);
    this.audio.setEngineVolume(settings.engineVolume);
    this.audio.setEffectsVolume(settings.effectsVolume);
    this.cameraRig = new CameraRig(this.camera);
    this.worldScene = new CityWorld(this.scene);
    this.ui = new UIController(uiRoot, settings);
    this.ui.onStart(() => void this.startDriving());
    this.ui.onResume(() => this.resume());
    this.ui.onPause(() => this.pause());
    this.ui.onReset(() => this.resetVehicle());
    this.ui.onSettings((next) => this.applySettings(next));
    this.ui.onRestart(() => this.restartDrive());
    this.input.on('pause', () => this.paused ? this.resume() : this.pause());
    this.input.on('camera', () => this.ui.setCameraLabel(this.cameraRig.cycle()));
    this.input.on('reset', () => this.resetVehicle());
    this.input.on('hud', () => { this.hudVisible = !this.hudVisible; this.ui.setHudVisible(this.hudVisible); });
    this.input.on('map', () => { this.mapVisible = !this.mapVisible; this.ui.setMapVisible(this.mapVisible); });
    this.input.on('transmission', () => {
      this.manualTransmission = !this.manualTransmission;
      this.vehicle.setManualTransmission(this.manualTransmission);
      this.ui.setTransmissionMode(this.manualTransmission ? 'MANUAL' : 'AUTO', true);
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
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.input.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.physics.free();
  }

  private initializePhysics(): void {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = 1 / 60;
    const floor = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.24, 0));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(280, 0.24, 280).setFriction(1.05), floor);
    for (const obstacle of this.worldScene.getBuildingColliders()) {
      const halfAngle = obstacle.rotation / 2;
      const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed()
        .setTranslation(obstacle.x, obstacle.y, obstacle.z)
        .setRotation({ x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) }));
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(obstacle.halfWidth, obstacle.halfHeight, obstacle.halfDepth)
        .setFriction(0.9), body);
    }
    this.vehicle = new VehicleController(this.physics, this.scene);
    this.vehicle.setManualTransmission(this.manualTransmission);
    this.vehicle.reset(new THREE.Vector3(0, 0.72, -70));
    this.cameraRig.update(1, this.vehicle.getPosition(), this.vehicle.getForward());
  }

  private startLoop(): void {
    this.running = true;
    const frame = (): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (!this.paused) this.step(dt);
      else this.input.getState(); // Drain one-shot inputs while paused so they cannot fire on resume.
      this.renderer.render(this.scene, this.camera);
      this.updateFps();
    };
    frame();
  }

  private step(frameDt: number): void {
    this.physicsAccumulator = Math.min(this.physicsAccumulator + frameDt, this.fixedTimeStep * 3);
    let steps = 0;
    while (this.physicsAccumulator >= this.fixedTimeStep && steps < 3) {
      const input = this.input.getState();
      this.latestTelemetry = this.vehicle.update(this.fixedTimeStep, input);
      this.physics.timestep = this.fixedTimeStep;
      this.physics.step();
      this.vehicle.syncVisual();
      this.physicsAccumulator -= this.fixedTimeStep;
      steps++;
    }

    const telemetry = this.latestTelemetry;
    if (telemetry) {
      const position = this.vehicle.getPosition();
      this.cameraRig.update(frameDt, position, this.vehicle.getForward());
      this.audio.update(telemetry.rpm, telemetry.throttle, telemetry.speedMps, this.vehicle.getLastShiftTime());
      this.ui.updateTelemetry(telemetry, this.fps, this.cameraRig.mode, this.dayPhase);
    }

    this.totalDriveSeconds += frameDt;
    this.dayPhase = (this.dayPhase + frameDt * 0.00048) % 1;
    const night = Math.max(0, Math.min(1, (Math.cos(this.dayPhase * Math.PI * 2) + 0.25) * 0.72));
    this.worldScene.setNightBlend(night);
    this.sun.intensity = THREE.MathUtils.lerp(0.25, 2.15, 1 - night);
    this.hemi.intensity = THREE.MathUtils.lerp(0.35, 1.55, 1 - night);
    this.sun.position.set(Math.cos(this.dayPhase * Math.PI * 2) * 110, 22 + Math.sin(this.dayPhase * Math.PI * 2) * 90, 38);
  }

  private async startDriving(): Promise<void> {
    try { await this.audio.unlock(); }
    catch (error) { console.warn('Audio could not be enabled:', error); }
    this.paused = false;
    this.physicsAccumulator = 0;
    this.ui.showGame();
    this.clock.getDelta();
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.physicsAccumulator = 0;
    this.ui.showPause();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.physicsAccumulator = 0;
    this.ui.showGame();
    this.clock.getDelta();
  }

  private resetVehicle(): void {
    const p = this.vehicle.getPosition();
    p.y = 0.72;
    this.vehicle.reset(p);
  }

  private restartDrive(): void {
    this.vehicle.reset(new THREE.Vector3(0, 0.72, -70));
    this.resume();
  }

  private applySettings(settings: GameSettings): void {
    this.audio.setEngineVolume(settings.engineVolume);
    this.audio.setEffectsVolume(settings.effectsVolume);
    this.manualTransmission = settings.transmission === 'manual';
    this.vehicle?.setManualTransmission(this.manualTransmission);
    this.ui.setTransmissionMode(this.manualTransmission ? 'MANUAL' : 'AUTO', false);
    this.renderer.shadowMap.enabled = settings.graphics !== 'low';
    this.sun.castShadow = settings.graphics !== 'low';
    const shadowResolution = settings.graphics === 'high' ? 1024 : 512;
    this.sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.graphics === 'low' ? 1 : 1.6));
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
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden && !this.paused) this.pause();
  };
}
