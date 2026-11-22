import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState, VehicleDebugTelemetry, VehicleTelemetry } from '../types';
import { createSportsCarVisual } from './vehicleVisual';
import type { VehicleDefinition } from './VehicleDefinitions';

export type ShiftEventType = 'upshift' | 'downshift' | 'neutral' | 'engage' | 'reverse';
export interface VehicleShiftEvent {
  previousGear: number;
  newGear: number;
  direction: 'up' | 'down' | 'neutral' | 'reverse';
  type: ShiftEventType;
  currentRpm: number;
  targetRpm: number;
  automatic: boolean;
}

export const IDLE_RPM = 850;
export const MAX_RPM = 8500;
export const MAX_FORWARD_SPEED = 58;
const CHASSIS_FRICTION = 0.08;
const ODOMETER_KEY = 'endless-driving-vehicle-odometers-v1';

const NEUTRAL_INPUT: InputState = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  shiftUpPressed: false, shiftDownPressed: false,
};

function readOdometer(vehicleId: string): number {
  try {
    const value = JSON.parse(localStorage.getItem(ODOMETER_KEY) ?? '{}') as Record<string, number>;
    const distance = value[vehicleId];
    return Number.isFinite(distance) ? Math.max(0, distance) : 0;
  } catch {
    return 0;
  }
}

function writeOdometer(vehicleId: string, distanceKm: number): void {
  try {
    const value = JSON.parse(localStorage.getItem(ODOMETER_KEY) ?? '{}') as Record<string, number>;
    value[vehicleId] = distanceKm;
    localStorage.setItem(ODOMETER_KEY, JSON.stringify(value));
  } catch { /* storage can be unavailable in private browsing */ }
}

export class VehicleController {
  readonly body: RAPIER.RigidBody;
  readonly visual: THREE.Group;
  readonly definition: VehicleDefinition;
  private readonly wheelMeshes: THREE.Mesh[];
  private gear = 1;
  private rpm: number;
  private speedMps = 0;
  private smoothedSteer = 0;
  private yawVelocity = 0;
  private tripDistanceKm = 0;
  private odometerKm: number;
  private lastPersistedOdometerKm: number;
  private lastDistanceX = 0;
  private lastDistanceZ = 0;
  private hasDistanceSample = false;
  private lastShiftAt = 0;
  private lastAppliedForwardForce = 0;
  private lastInput: InputState = { ...NEUTRAL_INPUT };
  private readonly shiftEvents: VehicleShiftEvent[] = [];
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly force = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private handbrake = false;
  private manualTransmission = false;
  private reverseAudioLatched = false;

  constructor(world: RAPIER.World, scene: THREE.Scene, definition: VehicleDefinition) {
    this.definition = definition;
    this.rpm = Math.min(1200, Math.max(700, definition.maxRpm * 0.12));
    this.odometerKm = readOdometer(definition.id);
    this.lastPersistedOdometerKm = this.odometerKm;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.72, 0)
      .setLinearDamping(0.08)
      .setAngularDamping(1.1)
      .setCanSleep(false)
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(definition.visual.bodyWidth * 0.48, 0.34, definition.visual.bodyLength * 0.46)
      .setMass(definition.physics.massKg)
      .setFriction(CHASSIS_FRICTION)
      .setRestitution(0.015);
    world.createCollider(collider, this.body);

    const visualParts = createSportsCarVisual(definition);
    this.visual = visualParts.root;
    this.wheelMeshes = visualParts.wheels;
    this.visual.traverse((object: THREE.Object3D) => {
      object.frustumCulled = true;
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    scene.add(this.visual);
    this.reset(new THREE.Vector3(0, 0.72, -70));
  }

  setManualTransmission(enabled: boolean): void {
    this.manualTransmission = enabled;
  }

  /** Select neutral (0) or a forward gear (1 through this vehicle's gear count). */
  selectGear(gear: number): void {
    if (!Number.isInteger(gear) || gear < 0 || gear > this.definition.physics.gearRatios.length) return;
    if (gear === this.gear) return;
    const speed = this.getSignedForwardSpeed();
    this.changeGear(gear, speed, false);
  }

  update(dt: number, input: InputState): VehicleTelemetry {
    const safeDt = THREE.MathUtils.clamp(dt, 1 / 240, 1 / 30);
    this.lastInput = input;

    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.scratchQuat).setY(0).normalize();

    const bodyVelocity = this.body.linvel();
    this.velocity.set(bodyVelocity.x, 0, bodyVelocity.z);
    this.speedMps = this.velocity.length();
    const signedSpeed = this.velocity.dot(this.forward);

    this.handbrake = input.handbrake;
    this.smoothedSteer = THREE.MathUtils.damp(
      this.smoothedSteer, input.steer, this.definition.physics.steeringResponse * 9, safeDt,
    );

    let longitudinalForce = 0;
    const profile = this.definition.physics;
    const maxSpeedMps = profile.maxSpeedKmh / 3.6;
    const gearRatio = this.gear === 0 ? 0 : (profile.gearRatios[this.gear - 1] ?? profile.gearRatios[0]);
    if (this.gear !== 0 && input.throttle > 0 && input.brake === 0) {
      const targetCoupledRpm = this.calculateCoupledRpm(this.gear, Math.abs(signedSpeed));
      const torqueFactor = this.getTorqueFactor(targetCoupledRpm);
      const gearFactor = THREE.MathUtils.clamp(gearRatio / profile.gearRatios[0], 0.3, 1);
      const speedRatio = THREE.MathUtils.clamp(this.speedMps / maxSpeedMps, 0, 1);
      const speedFade = 1 - Math.pow(speedRatio, 1.5) * 0.38;
      const hybridAssist = this.definition.audio.induction === 'hybrid'
        ? 1.16 - Math.min(0.16, speedRatio * 0.16)
        : 1;
      longitudinalForce = profile.maxDriveForce * input.throttle * torqueFactor
        * gearFactor * speedFade * hybridAssist;
    } else if (this.gear !== 0 && input.throttle === 0 && this.speedMps > 1.2) {
      longitudinalForce = -Math.sign(signedSpeed) * profile.engineBrakeForce;
    }

    if (input.brake > 0) {
      if (this.gear === 0) {
        longitudinalForce = this.speedMps > 0.2
          ? -Math.sign(signedSpeed) * profile.brakeForce * input.brake
          : 0;
      } else if (signedSpeed > 0.55) {
        longitudinalForce = -profile.brakeForce * input.brake;
      } else if (signedSpeed < -0.55) {
        longitudinalForce = profile.brakeForce * input.brake;
      } else {
        longitudinalForce = -profile.brakeForce * 0.24 * input.brake;
      }
    }

    if (this.speedMps > maxSpeedMps && longitudinalForce > 0) {
      longitudinalForce *= THREE.MathUtils.clamp(1 - (this.speedMps - maxSpeedMps) / 10, 0, 1);
    }
    this.lastAppliedForwardForce = longitudinalForce;
    this.force.copy(this.forward).multiplyScalar(longitudinalForce);

    const lateralSpeed = this.velocity.dot(this.right);
    const lateralGrip = this.handbrake ? profile.handbrakeGrip : profile.lateralGrip;
    this.force.addScaledVector(this.right, -lateralSpeed * lateralGrip);
    const rollingDrag = 0.95 + this.speedMps * 0.46;
    this.force.addScaledVector(this.velocity, -rollingDrag);
    if (this.handbrake && this.speedMps > 0.5) {
      this.force.addScaledVector(this.velocity, -this.speedMps * 145);
    }

    this.body.resetForces(true);
    this.body.addForce({ x: this.force.x, y: 0, z: this.force.z }, true);

    const steeringAuthority = THREE.MathUtils.clamp(this.speedMps / 7.5, 0.22, 1);
    const direction = Math.abs(signedSpeed) > 0.4 ? Math.sign(signedSpeed) : 1;
    const targetYawRate = -this.smoothedSteer * (0.12 + steeringAuthority * 1.02)
      * direction * (this.handbrake ? 1.2 : 1);
    const yawAlpha = 1 - Math.exp(-7 * safeDt);
    this.yawVelocity = THREE.MathUtils.lerp(this.body.angvel().y, targetYawRate, yawAlpha);
    this.body.setAngvel({ x: 0, y: this.yawVelocity, z: 0 }, true);

    this.updateTransmission(input, signedSpeed);

    // S/reverse is represented by the existing brake-at-rest control. Emit one
    // distinct drivetrain event when it transitions from braking to reverse.
    if (input.brake > 0 && this.gear !== 0 && signedSpeed < 0.55 && signedSpeed > -0.55
      && !this.reverseAudioLatched) {
      this.shiftEvents.push({
        previousGear: this.gear,
        newGear: this.gear,
        direction: 'reverse',
        type: 'reverse',
        currentRpm: this.rpm,
        targetRpm: Math.max(850, this.rpm * 0.92),
        automatic: !this.manualTransmission,
      });
      this.reverseAudioLatched = true;
    } else if (input.brake === 0 && signedSpeed >= -0.1) {
      this.reverseAudioLatched = false;
    }

    const idleRpm = Math.min(1200, Math.max(700, this.definition.maxRpm * 0.12));
    const freeRevRpm = idleRpm + input.throttle * (this.definition.maxRpm - idleRpm) * 0.84;
    const coupledRpm = this.gear === 0
      ? idleRpm
      : this.calculateCoupledRpm(this.gear, Math.abs(signedSpeed));
    const clutchEngagement = THREE.MathUtils.smoothstep(Math.abs(signedSpeed), 0.8, 7.5);
    const targetRpm = this.gear === 0
      ? freeRevRpm
      : THREE.MathUtils.lerp(freeRevRpm, coupledRpm, clutchEngagement);
    this.rpm = THREE.MathUtils.damp(this.rpm, targetRpm, input.throttle > 0 ? 8 : 4.5, safeDt);

    for (const wheel of this.wheelMeshes) wheel.rotation.x -= signedSpeed * safeDt / 0.35;
    this.syncVisual();
    return this.getTelemetry();
  }

  /** Read telemetry after world.step() so the HUD reports the current solver result. */
  getTelemetry(): VehicleTelemetry {
    const p = this.body.translation();
    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();

    const bodyVelocity = this.body.linvel();
    this.velocity.set(bodyVelocity.x, 0, bodyVelocity.z);
    this.speedMps = this.velocity.length();
    const signedSpeed = this.velocity.dot(this.forward);

    if (this.hasDistanceSample) {
      const movement = Math.hypot(p.x - this.lastDistanceX, p.z - this.lastDistanceZ);
      // Ignore sub-centimetre contact jitter, while retaining genuine movement.
      if (movement >= 0.0015 && movement < 5 && this.speedMps >= 0.2) {
        const travelledKm = movement / 1000;
        this.tripDistanceKm += travelledKm;
        this.odometerKm += travelledKm;
        if (this.odometerKm - this.lastPersistedOdometerKm >= 0.05) {
          writeOdometer(this.definition.id, this.odometerKm);
          this.lastPersistedOdometerKm = this.odometerKm;
        }
      }
    }
    this.lastDistanceX = p.x;
    this.lastDistanceZ = p.z;
    this.hasDistanceSample = true;

    const idleRpm = Math.min(1200, Math.max(700, this.definition.maxRpm * 0.12));
    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      rpm: this.rpm,
      gear: this.gear,
      gearLabel: this.gear === 0 ? 'N' : signedSpeed < -0.7 ? 'R' : String(this.gear),
      transmissionMode: this.manualTransmission ? 'MANUAL' : 'AUTO',
      throttle: this.lastInput.throttle,
      steer: this.lastInput.steer,
      distanceKm: this.tripDistanceKm,
      tripDistanceKm: this.tripDistanceKm,
      odometerKm: this.odometerKm,
      engineLoad: THREE.MathUtils.clamp(
        this.lastInput.throttle * 0.78 + Math.max(0, this.rpm - idleRpm) / this.definition.maxRpm,
        0,
        1,
      ),
      worldX: p.x,
      worldZ: p.z,
      grounded: p.y < 1.25,
      vehicleId: this.definition.id,
      vehicleName: this.definition.name,
      maxRpm: this.definition.maxRpm,
      maxSpeedKmh: this.definition.topSpeedKmh,
    };
  }

  getDebugTelemetry(
    input: InputState,
    physicsTimestep: number,
    physicsStepsThisFrame: number,
  ): VehicleDebugTelemetry {
    const p = this.body.translation();
    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();
    const v = this.body.linvel();
    const forwardSpeed = v.x * this.forward.x + v.z * this.forward.z;
    const meshSyncError = Math.hypot(
      this.visual.position.x - p.x,
      this.visual.position.y - (p.y - 0.05),
      this.visual.position.z - p.z,
    );
    return {
      throttle: input.throttle, brake: input.brake, steer: input.steer,
      appliedForwardForce: this.lastAppliedForwardForce,
      velocityX: v.x, velocityY: v.y, velocityZ: v.z, forwardSpeed,
      positionX: p.x, positionY: p.y, positionZ: p.z, rpm: this.rpm, gear: this.gear,
      physicsTimestep, physicsStepsThisFrame, sleeping: this.body.isSleeping(), meshSyncError,
    };
  }

  rebase(delta: THREE.Vector3): void {
    if (delta.lengthSq() === 0) return;
    const position = this.body.translation();
    this.body.setTranslation({
      x: position.x - delta.x,
      y: position.y - delta.y,
      z: position.z - delta.z,
    }, true);
    this.lastDistanceX -= delta.x;
    this.lastDistanceZ -= delta.z;
    this.visual.position.sub(delta);
  }

  syncVisual(): void {
    const p = this.body.translation();
    const q = this.body.rotation();
    this.visual.position.set(p.x, p.y - 0.05, p.z);
    this.visual.quaternion.set(q.x, q.y, q.z, q.w);
  }

  getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    const p = this.body.translation();
    return target.set(p.x, p.y, p.z);
  }

  getForward(target = new THREE.Vector3()): THREE.Vector3 {
    const q = this.body.rotation();
    return target.set(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
      .setY(0)
      .normalize();
  }

  resetTrip(): void {
    this.tripDistanceKm = 0;
  }

  flushOdometer(): void {
    if (this.odometerKm !== this.lastPersistedOdometerKm) {
      writeOdometer(this.definition.id, this.odometerKm);
      this.lastPersistedOdometerKm = this.odometerKm;
    }
  }

  reset(
    position = new THREE.Vector3(0, 0.72, -70),
    resetDistance = false,
    roadHeading = new THREE.Vector3(0, 0, 1),
  ): void {
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const heading = roadHeading.clone().setY(0).normalize();
    const yaw = Math.atan2(heading.x, heading.z);
    this.body.setRotation({
      x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2),
    }, true);
    if (resetDistance) this.tripDistanceKm = 0;
    this.lastDistanceX = position.x;
    this.lastDistanceZ = position.z;
    this.hasDistanceSample = true;
    this.rpm = Math.min(1200, Math.max(700, this.definition.maxRpm * 0.12));
    this.gear = 1;
    this.speedMps = 0;
    this.smoothedSteer = 0;
    this.yawVelocity = 0;
    this.lastAppliedForwardForce = 0;
    this.lastShiftAt = 0;
    this.shiftEvents.length = 0;
    this.reverseAudioLatched = false;
    this.handbrake = false;
    this.lastInput = { ...NEUTRAL_INPUT };
    this.force.set(0, 0, 0);
    for (const wheel of this.wheelMeshes) wheel.rotation.x = 0;
    this.syncVisual();
  }

  drainShiftEvents(): VehicleShiftEvent[] {
    if (this.shiftEvents.length === 0) return [];
    return this.shiftEvents.splice(0, this.shiftEvents.length);
  }

  getLastShiftTime(): number { return this.lastShiftAt; }

  dispose(world: RAPIER.World, scene: THREE.Scene): void {
    this.flushOdometer();
    scene.remove(this.visual);
    this.visual.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const mat of materials) mat.dispose();
      }
    });
    world.removeRigidBody(this.body);
    this.shiftEvents.length = 0;
  }

  private calculateCoupledRpm(gear: number, speedMps: number): number {
    const profile = this.definition.physics;
    const ratio = profile.gearRatios[gear - 1] ?? profile.gearRatios[0];
    const wheelRpm = speedMps / (2 * Math.PI * profile.wheelRadiusM) * 60;
    const rpm = wheelRpm * ratio * profile.finalDrive * profile.transferDrive;
    const idleRpm = Math.min(1200, Math.max(700, this.definition.maxRpm * 0.12));
    return THREE.MathUtils.clamp(rpm, idleRpm, this.definition.maxRpm);
  }

  private getTorqueFactor(rpm: number): number {
    const points = this.definition.physics.torqueCurve;
    const ratio = THREE.MathUtils.clamp(rpm / this.definition.maxRpm, 0, 1);
    for (let i = 1; i < points.length; i++) {
      const [previousX, previousY] = points[i - 1];
      const [nextX, nextY] = points[i];
      if (ratio <= nextX) {
        const position = (ratio - previousX) / Math.max(0.001, nextX - previousX);
        return THREE.MathUtils.lerp(previousY, nextY, position);
      }
    }
    return points[points.length - 1][1];
  }

  private getSignedForwardSpeed(): number {
    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();
    const velocity = this.body.linvel();
    return velocity.x * this.forward.x + velocity.z * this.forward.z;
  }

  private changeGear(nextGear: number, signedSpeed: number, automatic: boolean): void {
    const previousGear = this.gear;
    if (previousGear === nextGear) return;
    const targetRpm = nextGear === 0
      ? this.rpm
      : this.calculateCoupledRpm(nextGear, Math.abs(signedSpeed));
    // Reject any downshift that would mechanically overspeed the engine.
    if (nextGear < previousGear && nextGear > 0 && targetRpm > this.definition.maxRpm * 0.985) return;

    let direction: VehicleShiftEvent['direction'] = 'neutral';
    let type: ShiftEventType = 'neutral';
    if (previousGear === 0 && nextGear > 0) {
      direction = 'up';
      type = 'engage';
    } else if (nextGear === 0) {
      direction = 'neutral';
      type = 'neutral';
    } else if (nextGear > previousGear) {
      direction = 'up';
      type = 'upshift';
    } else {
      direction = 'down';
      type = 'downshift';
    }

    this.gear = nextGear;
    this.lastShiftAt = performance.now();
    this.shiftEvents.push({
      previousGear,
      newGear: nextGear,
      direction,
      type,
      currentRpm: this.rpm,
      targetRpm: Math.min(this.definition.maxRpm * 0.985, Math.max(700, targetRpm)),
      automatic,
    });
  }

  private updateTransmission(input: InputState, signedSpeed: number): void {
    const gearCount = this.definition.physics.gearRatios.length;
    if (this.manualTransmission) {
      if (input.shiftUpPressed && this.gear < gearCount) {
        this.changeGear(this.gear === 0 ? 1 : this.gear + 1, signedSpeed, false);
      } else if (input.shiftDownPressed && this.gear > 0) {
        this.changeGear(this.gear === 1 ? 0 : this.gear - 1, signedSpeed, false);
      }
      return;
    }

    if (this.gear === 0) return;
    const projectedRpm = this.calculateCoupledRpm(this.gear, Math.abs(signedSpeed));
    if (projectedRpm > this.definition.maxRpm * 0.87 && this.gear < gearCount) {
      this.changeGear(this.gear + 1, signedSpeed, true);
    } else if (projectedRpm < Math.max(1850, this.definition.maxRpm * 0.23)
      && this.gear > 1 && Math.abs(signedSpeed) > 2) {
      this.changeGear(this.gear - 1, signedSpeed, true);
    }
  }
}
