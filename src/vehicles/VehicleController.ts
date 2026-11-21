import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputState, VehicleTelemetry } from '../types';
import { createSportsCarVisual } from './vehicleVisual';

const GEAR_RATIOS = [3.15, 2.12, 1.52, 1.18, 0.92, 0.74];
const IDLE_RPM = 850;
const MAX_RPM = 7200;

export class VehicleController {
  readonly body: RAPIER.RigidBody;
  readonly visual: THREE.Group;
  private readonly wheelMeshes: THREE.Mesh[];
  private gear = 1;
  private rpm = IDLE_RPM;
  private speedMps = 0;
  private smoothedSteer = 0;
  private distanceKm = 0;
  private travelledThisFrame = 0;
  private lastShiftAt = 0;
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
      .setLinearDamping(0.06)
      .setAngularDamping(2.8)
      .setCanSleep(false)
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(0.91, 0.34, 2.02)
      .setMass(1420)
      .setFriction(0.85)
      .setRestitution(0.02);
    world.createCollider(collider, this.body);

    const visualParts = createSportsCarVisual();
    this.visual = visualParts.root;
    this.wheelMeshes = visualParts.wheels;
    scene.add(this.visual);
  }

  setManualTransmission(enabled: boolean): void { this.manualTransmission = enabled; }

  update(dt: number, input: InputState): VehicleTelemetry {
    const safeDt = Math.min(dt, 1 / 30);
    const p = this.body.translation();
    const q = this.body.rotation();
    this.scratchQuat.set(q.x, q.y, q.z, q.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.scratchQuat).setY(0).normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.scratchQuat).setY(0).normalize();

    const v = this.body.linvel();
    this.velocity.set(v.x, 0, v.z);
    this.speedMps = this.velocity.length();
    const signedSpeed = this.velocity.dot(this.forward);
    this.handbrake = input.handbrake;
    this.smoothedSteer = THREE.MathUtils.damp(this.smoothedSteer, input.steer, 6.5, safeDt);

    let drive = 0;
    if (input.throttle > 0 && input.brake === 0) {
      drive = 7600 * input.throttle * this.engineTorqueFactor();
    }
    if (input.brake > 0) {
      if (signedSpeed > 0.75) drive = -14500 * input.brake;
      else if (signedSpeed < -0.75) drive = 14500 * input.brake;
      else drive = -3300 * input.brake;
    }
    const speedLimiter = THREE.MathUtils.clamp(1 - Math.max(0, this.speedMps - 48) / 13, 0.08, 1);
    drive *= speedLimiter;

    this.force.copy(this.forward).multiplyScalar(drive);
    const lateralSpeed = this.velocity.dot(this.right);
    const grip = this.handbrake ? 1250 : 5200;
    this.force.addScaledVector(this.right, -lateralSpeed * grip);
    this.force.addScaledVector(this.velocity, -0.42 * this.speedMps);
    if (this.handbrake && this.speedMps > 1) this.force.addScaledVector(this.velocity, -this.speedMps * 110);
    this.body.applyForce({ x: this.force.x, y: 0, z: this.force.z }, true);

    const steeringAuthority = THREE.MathUtils.clamp(this.speedMps / 8, 0.12, 1);
    const yawRate = this.smoothedSteer * (0.1 + steeringAuthority * 1.02) * (this.handbrake ? 1.45 : 1);
    const currentAng = this.body.angvel();
    const desiredYaw = yawRate * Math.sign(signedSpeed || 1);
    const yawImpulse = (desiredYaw - currentAng.y) * 760 * (1 + this.speedMps * 0.025);
    this.body.applyTorqueImpulse({ x: 0, y: yawImpulse * safeDt, z: 0 }, true);

    this.updateTransmission(input, signedSpeed);
    const gearRatio = GEAR_RATIOS[this.gear - 1] ?? GEAR_RATIOS[0];
    const estimatedRpm = IDLE_RPM + Math.abs(signedSpeed) * gearRatio * 68;
    const targetRpm = input.throttle > 0 && this.speedMps < 2
      ? IDLE_RPM + 2200 * input.throttle
      : THREE.MathUtils.clamp(estimatedRpm, IDLE_RPM, MAX_RPM);
    this.rpm = THREE.MathUtils.damp(this.rpm, targetRpm, input.throttle > 0 ? 7.5 : 4.2, safeDt);

    this.travelledThisFrame = this.speedMps * safeDt;
    this.distanceKm += this.travelledThisFrame / 1000;
    this.visual.position.set(p.x, p.y - 0.05, p.z);
    this.visual.quaternion.set(q.x, q.y, q.z, q.w);
    for (const wheel of this.wheelMeshes) wheel.rotation.x -= signedSpeed * safeDt / 0.34;

    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      rpm: this.rpm,
      gear: this.gear,
      gearLabel: signedSpeed < -0.5 ? 'R' : String(this.gear),
      transmissionMode: this.manualTransmission ? 'MANUAL' : 'AUTO',
      throttle: input.throttle,
      steer: input.steer,
      distanceKm: this.distanceKm,
      engineLoad: THREE.MathUtils.clamp(input.throttle * 0.78 + Math.max(0, this.rpm - 1200) / 9000, 0, 1),
      worldX: p.x,
      worldZ: p.z,
      grounded: p.y < 1.25,
    };
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
    return target.set(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).normalize();
  }

  reset(position = new THREE.Vector3(0, 0.72, 0)): void {
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.rpm = IDLE_RPM;
    this.gear = 1;
  }

  getLastShiftTime(): number { return this.lastShiftAt; }

  private updateTransmission(input: InputState, signedSpeed: number): void {
    if (this.manualTransmission) {
      if (input.shiftUpPressed && this.gear < 6) { this.gear++; this.lastShiftAt = performance.now(); }
      if (input.shiftDownPressed && this.gear > 1) { this.gear--; this.lastShiftAt = performance.now(); }
      return;
    }
    const ratio = GEAR_RATIOS[this.gear - 1] ?? 1;
    const projectedRpm = IDLE_RPM + Math.abs(signedSpeed) * ratio * 68;
    if (projectedRpm > 6350 && this.gear < 6) {
      this.gear++;
      this.lastShiftAt = performance.now();
    } else if (projectedRpm < 2050 && this.gear > 1) {
      this.gear--;
      this.lastShiftAt = performance.now();
    }
  }

  private engineTorqueFactor(): number {
    const rpmBand = this.rpm / MAX_RPM;
    return THREE.MathUtils.clamp(1.18 - rpmBand * 0.42, 0.62, 1.18);
  }
}
