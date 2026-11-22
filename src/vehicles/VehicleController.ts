import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState, VehicleDebugTelemetry, VehicleTelemetry } from '../types';
import { createSportsCarVisual } from './vehicleVisual';

const GEAR_RATIOS = [3.15, 2.12, 1.52, 1.18, 0.92, 0.74];
export const IDLE_RPM = 850;
export const MAX_RPM = 7200;
export const MAX_FORWARD_SPEED = 58; // m/s, approximately 209 km/h
const CAR_MASS = 1420;

/**
 * This prototype has one chassis collider rather than four simulated wheel
 * colliders. Keep chassis/road contact friction low and model tyre grip in the
 * controller's longitudinal and lateral forces. High box-on-floor friction
 * pins the body in static contact friction and can cancel the entire drive force.
 */
const CHASSIS_FRICTION = 0.08;

const NEUTRAL_INPUT: InputState = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  shiftUpPressed: false,
  shiftDownPressed: false,
};

export class VehicleController {
  readonly body: RAPIER.RigidBody;
  readonly visual: THREE.Group;
  private readonly wheelMeshes: THREE.Mesh[];
  private gear = 1;
  private rpm = IDLE_RPM;
  private speedMps = 0;
  private smoothedSteer = 0;
  private yawVelocity = 0;
  private distanceKm = 0;
  private lastDistanceX = 0;
  private lastDistanceZ = 0;
  private hasDistanceSample = false;
  private lastShiftAt = 0;
  private lastAppliedForwardForce = 0;
  private lastInput: InputState = { ...NEUTRAL_INPUT };
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly force = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private handbrake = false;
  private manualTransmission = false;

  constructor(world: RAPIER.World, scene: THREE.Scene) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.72, 0)
      .setLinearDamping(0.08)
      .setAngularDamping(1.1)
      .setCanSleep(false)
      .enabledRotations(false, true, false);

    this.body = world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(0.91, 0.34, 2.02)
      .setMass(CAR_MASS)
      .setFriction(CHASSIS_FRICTION)
      .setRestitution(0.015);
    world.createCollider(collider, this.body);

    const visualParts = createSportsCarVisual();
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

  /** Select neutral (0) or a forward gear (1–6) without altering vehicle velocity. */
  selectGear(gear: number): void {
    if (!Number.isInteger(gear) || gear < 0 || gear > GEAR_RATIOS.length) return;
    if (gear === this.gear) return;
    this.gear = gear;
    this.lastShiftAt = performance.now();
  }

  update(dt: number, input: InputState): VehicleTelemetry {
    const safeDt = THREE.MathUtils.clamp(dt, 1 / 240, 1 / 30);
    this.lastInput = { ...input };

    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);

    // The car mesh's nose points along local +Z; Rapier and Three.js share
    // the same world axes, so rotate that local forward vector by the body pose.
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.scratchQuat).setY(0).normalize();

    const bodyVelocity = this.body.linvel();
    this.velocity.set(bodyVelocity.x, 0, bodyVelocity.z);
    this.speedMps = this.velocity.length();
    const signedSpeed = this.velocity.dot(this.forward);

    this.handbrake = input.handbrake;
    this.smoothedSteer = THREE.MathUtils.damp(this.smoothedSteer, input.steer, 8.5, safeDt);

    // Propulsion, braking and reverse all act along the chassis' world-space forward axis.
    let longitudinalForce = 0;
    // Neutral disconnects engine torque from the wheels while leaving all
    // passive forces and braking active.
    if (this.gear !== 0 && input.throttle > 0 && input.brake === 0) {
      const speedRatio = THREE.MathUtils.clamp(this.speedMps / MAX_FORWARD_SPEED, 0, 1);
      const torqueCurve = 1.12 - speedRatio * 0.33;
      longitudinalForce = 10400 * input.throttle * torqueCurve;
    }

    if (input.brake > 0) {
      if (this.gear === 0) {
        // In neutral, S is a brake only: it must never command reverse torque.
        longitudinalForce = this.speedMps > 0.2
          ? -Math.sign(signedSpeed) * 18500 * input.brake
          : 0;
      } else if (signedSpeed > 0.55) {
        longitudinalForce = -18500 * input.brake;
      } else if (signedSpeed < -0.55) {
        longitudinalForce = 18500 * input.brake;
      } else {
        longitudinalForce = -4400 * input.brake;
      }
    }

    if (this.speedMps > MAX_FORWARD_SPEED && longitudinalForce > 0) {
      longitudinalForce *= THREE.MathUtils.clamp(1 - (this.speedMps - MAX_FORWARD_SPEED) / 10, 0, 1);
    }

    this.lastAppliedForwardForce = longitudinalForce;
    this.force.copy(this.forward).multiplyScalar(longitudinalForce);

    // Model lateral tyre grip here instead of relying on a high-friction chassis box.
    const lateralSpeed = this.velocity.dot(this.right);
    const lateralGrip = this.handbrake ? 1750 : 6900;
    this.force.addScaledVector(this.right, -lateralSpeed * lateralGrip);

    // Rolling and aerodynamic resistance keep the vehicle from coasting forever.
    const rollingDrag = 0.95 + this.speedMps * 0.46;
    this.force.addScaledVector(this.velocity, -rollingDrag);
    if (this.handbrake && this.speedMps > 0.5) {
      this.force.addScaledVector(this.velocity, -this.speedMps * 145);
    }

    // Rapier 0.21.0 exposes addForce/resetForces on RigidBody. Apply the force
    // before the matching fixed world.step(); the solver consumes it that tick.
    this.body.resetForces(true);
    this.body.addForce({ x: this.force.x, y: 0, z: this.force.z }, true);

    // Stable yaw-rate steering remains physics-driven: the body is rotated by
    // Rapier, which then resolves ground and obstacle contacts normally.
    const steeringAuthority = THREE.MathUtils.clamp(this.speedMps / 7.5, 0.22, 1);
    const direction = Math.abs(signedSpeed) > 0.4 ? Math.sign(signedSpeed) : 1;
    const targetYawRate = -this.smoothedSteer * (0.12 + steeringAuthority * 1.02)
      * direction * (this.handbrake ? 1.2 : 1);
    const yawAlpha = 1 - Math.exp(-7 * safeDt);
    this.yawVelocity = THREE.MathUtils.lerp(this.body.angvel().y, targetYawRate, yawAlpha);
    this.body.setAngvel({ x: 0, y: this.yawVelocity, z: 0 }, true);

    this.updateTransmission(input, signedSpeed);

    const gearRatio = this.gear === 0 ? 0 : (GEAR_RATIOS[this.gear - 1] ?? GEAR_RATIOS[0]);
    const estimatedRpm = IDLE_RPM + Math.abs(signedSpeed) * gearRatio * 62;
    const freeRevRpm = IDLE_RPM + input.throttle * (MAX_RPM - IDLE_RPM) * 0.82;
    const targetRpm = this.gear === 0
      ? freeRevRpm
      : input.throttle > 0 && this.speedMps < 3
        ? IDLE_RPM + 2500 * input.throttle
        : THREE.MathUtils.clamp(estimatedRpm + input.throttle * 800, IDLE_RPM, MAX_RPM);
    this.rpm = THREE.MathUtils.damp(this.rpm, targetRpm, input.throttle > 0 ? 8 : 4.5, safeDt);

    for (const wheel of this.wheelMeshes) wheel.rotation.x -= signedSpeed * safeDt / 0.34;
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

    // Distance is sampled from the real Rapier transform after integration.
    // The first sample (and every reset) only establishes a baseline.
    if (this.hasDistanceSample) {
      this.distanceKm += Math.hypot(p.x - this.lastDistanceX, p.z - this.lastDistanceZ) / 1000;
    }
    this.lastDistanceX = p.x;
    this.lastDistanceZ = p.z;
    this.hasDistanceSample = true;

    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      rpm: this.rpm,
      gear: this.gear,
      gearLabel: this.gear === 0 ? 'N' : signedSpeed < -0.7 ? 'R' : String(this.gear),
      transmissionMode: this.manualTransmission ? 'MANUAL' : 'AUTO',
      throttle: this.lastInput.throttle,
      steer: this.lastInput.steer,
      distanceKm: this.distanceKm,
      engineLoad: THREE.MathUtils.clamp(
        this.lastInput.throttle * 0.78 + Math.max(0, this.rpm - IDLE_RPM) / 9000,
        0,
        1,
      ),
      worldX: p.x,
      worldZ: p.z,
      grounded: p.y < 1.25,
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
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      appliedForwardForce: this.lastAppliedForwardForce,
      velocityX: v.x,
      velocityY: v.y,
      velocityZ: v.z,
      forwardSpeed,
      positionX: p.x,
      positionY: p.y,
      positionZ: p.z,
      rpm: this.rpm,
      gear: this.gear,
      physicsTimestep,
      physicsStepsThisFrame,
      sleeping: this.body.isSleeping(),
      meshSyncError,
    };
  }

  /**
   * Move the dynamic chassis into a nearby local coordinate frame without
   * changing velocity, gear, or accumulated odometer distance.
   */
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

  reset(position = new THREE.Vector3(0, 0.72, -70), resetDistance = false): void {
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    if (resetDistance) this.distanceKm = 0;
    this.lastDistanceX = position.x;
    this.lastDistanceZ = position.z;
    this.hasDistanceSample = true;
    this.rpm = IDLE_RPM;
    this.gear = 1;
    this.speedMps = 0;
    this.smoothedSteer = 0;
    this.yawVelocity = 0;
    this.lastAppliedForwardForce = 0;
    this.lastShiftAt = 0;
    this.handbrake = false;
    this.lastInput = { ...NEUTRAL_INPUT };
    this.force.set(0, 0, 0);
    for (const wheel of this.wheelMeshes) wheel.rotation.x = 0;
    this.syncVisual();
  }

  getLastShiftTime(): number {
    return this.lastShiftAt;
  }

  private updateTransmission(input: InputState, signedSpeed: number): void {
    if (this.manualTransmission) {
      if (input.shiftUpPressed && this.gear < 6) {
        this.gear = this.gear === 0 ? 1 : this.gear + 1;
        this.lastShiftAt = performance.now();
      } else if (input.shiftDownPressed && this.gear > 0) {
        this.gear = this.gear === 1 ? 0 : this.gear - 1;
        this.lastShiftAt = performance.now();
      }
      return;
    }

    // An explicitly selected neutral state remains latched in automatic mode.
    if (this.gear === 0) return;

    const ratio = GEAR_RATIOS[this.gear - 1] ?? 1;
    const projectedRpm = IDLE_RPM + Math.abs(signedSpeed) * ratio * 62;
    if (projectedRpm > 6200 && this.gear < 6) {
      this.gear++;
      this.lastShiftAt = performance.now();
    } else if (projectedRpm < 1850 && this.gear > 1) {
      this.gear--;
      this.lastShiftAt = performance.now();
    }
  }
}
