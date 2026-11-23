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
const CHASSIS_FRICTION = 0.75;
const WHEEL_REST_LENGTH = 0.22;
const WHEEL_CONNECTION_Y = -0.16;
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
  private readonly wheelController: RAPIER.DynamicRayCastVehicleController;
  readonly definition: VehicleDefinition;
  private readonly wheelMeshes: THREE.Object3D[];
  private gear = 1;
  private rpm: number;
  private speedMps = 0;
  private smoothedSteer = 0;
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
  private readonly velocity = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private handbrake = false;
  private manualTransmission = false;
  private driveThrottle = 0;
  private brakeToReverseTime = 0;
  private reverseEngaged = false;
  private reverseAudioLatched = false;

  constructor(world: RAPIER.World, scene: THREE.Scene, definition: VehicleDefinition) {
    this.definition = definition;
    this.rpm = Math.min(1200, Math.max(700, definition.maxRpm * 0.12));
    this.odometerKm = readOdometer(definition.id);
    this.lastPersistedOdometerKm = this.odometerKm;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.72, 0)
      .setLinearDamping(0.018)
      .setAngularDamping(0.75)
      .setCanSleep(false)
      .enabledRotations(false, true, false);
    this.body = world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(definition.visual.bodyWidth * 0.48, 0.34, definition.visual.bodyLength * 0.46)
      .setMass(definition.physics.massKg)
      .setFriction(CHASSIS_FRICTION)
      .setRestitution(0.015);
    world.createCollider(collider, this.body);

    // One chassis body with four ray-cast tyres and independent suspension.
    this.wheelController = world.createVehicleController(this.body);
    this.wheelController.indexUpAxis = 1;
    this.wheelController.setIndexForwardAxis = 2;
    let wheelIndex = 0;
    for (const side of [-1, 1]) {
      for (const z of [-definition.visual.wheelBase * 0.5, definition.visual.wheelBase * 0.5]) {
        this.wheelController.addWheel(
          { x: side * definition.visual.wheelTrack * 0.5, y: WHEEL_CONNECTION_Y, z },
          { x: 0, y: -1, z: 0 },
          { x: -1, y: 0, z: 0 },
          WHEEL_REST_LENGTH,
          definition.physics.wheelRadiusM,
        );
        this.wheelController.setWheelMaxSuspensionTravel(wheelIndex, 0.22);
        this.wheelController.setWheelSuspensionStiffness(wheelIndex, 18);
        this.wheelController.setWheelSuspensionCompression(wheelIndex, 2.1);
        this.wheelController.setWheelSuspensionRelaxation(wheelIndex, 2.5);
        this.wheelController.setWheelMaxSuspensionForce(wheelIndex, definition.physics.massKg * 9.81 * 0.72);
        this.wheelController.setWheelFrictionSlip(wheelIndex, 5.5);
        this.wheelController.setWheelSideFrictionStiffness(wheelIndex, 1.2);
        wheelIndex++;
      }
    }

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

    const bodyVelocity = this.body.linvel();
    this.velocity.set(bodyVelocity.x, 0, bodyVelocity.z);
    this.speedMps = this.velocity.length();
    let signedSpeed = this.velocity.dot(this.forward);

    this.handbrake = input.handbrake;
    this.driveThrottle = THREE.MathUtils.damp(
      this.driveThrottle,
      input.throttle,
      input.throttle > this.driveThrottle ? 12 : 16,
      safeDt,
    );
    // A slower steering rack response filters abrupt digital keyboard inputs.
    // Vehicle-specific response remains a small modifier, not a large sensitivity multiplier.
    this.smoothedSteer = THREE.MathUtils.damp(
      this.smoothedSteer,
      input.steer,
      this.definition.physics.steeringResponse * 4.5,
      safeDt,
    );

    // Shift before calculating this tick's wheel torque so the new ratio is
    // applied immediately rather than one simulation frame late.
    this.updateTransmission(input, signedSpeed);

    // S/Down is a brake while the car is moving forward. Reverse only
    // engages after the chassis has reached a genuine standstill and the
    // driver keeps the brake input held for a short engagement interval.
    const reverseRequested = input.brake > 0
      && input.throttle < 0.05
      && this.gear !== 0;
    if (!reverseRequested) {
      this.brakeToReverseTime = 0;
      this.reverseEngaged = false;
    } else if (!this.reverseEngaged && this.speedMps <= 0.18) {
      this.brakeToReverseTime += safeDt;
      if (this.brakeToReverseTime >= 0.4) this.reverseEngaged = true;
    } else if (!this.reverseEngaged) {
      this.brakeToReverseTime = 0;
    }
    const reverseMode = reverseRequested && this.reverseEngaged;

    // Do not hard-clamp chassis velocity to a per-gear redline.
    // Gear limits belong in the engine torque/rev-limiter model; directly
    // rewriting velocity here creates an artificial speed wall and can
    // destabilise the tyre solver during shifts or while cornering.

    const profile = this.definition.physics;
    const idleRpm = Math.min(1200, Math.max(700, this.definition.maxRpm * 0.12));
    const maxSpeedMps = profile.maxSpeedKmh / 3.6;
    const gearRatio = this.gear === 0 ? 0 : (profile.gearRatios[this.gear - 1] ?? profile.gearRatios[0]);
    const speedRatio = THREE.MathUtils.clamp(this.speedMps / maxSpeedMps, 0, 1);
    // Preserve usable power at high speed; engine output should fall with the
    // torque curve and gearing, not an arbitrary 32% power cliff.
    const speedFade = 1 - Math.pow(speedRatio, 1.5) * 0.12;
    const hybridAssist = profile.hybridAssist
      ? profile.hybridAssist - Math.min(profile.hybridAssist - 1, speedRatio * (profile.hybridAssist - 1))
      : 1;

    const launchRpm = idleRpm + this.driveThrottle * (this.definition.maxRpm - idleRpm) * 0.28;
    const coupledGear = reverseMode ? 1 : this.gear;
    const rawCoupledRpm = this.gear === 0
      ? idleRpm
      : this.calculateRawCoupledRpm(coupledGear, Math.abs(signedSpeed));
    const clutchEngagement = THREE.MathUtils.smoothstep(Math.abs(signedSpeed), 0.35, 4.2);
    const coupledTorqueRpm = THREE.MathUtils.clamp(rawCoupledRpm, idleRpm, this.definition.maxRpm);
    const torqueRpm = this.gear === 0
      ? idleRpm + this.driveThrottle * (this.definition.maxRpm - idleRpm) * 0.72
      : THREE.MathUtils.lerp(launchRpm, coupledTorqueRpm, clutchEngagement);
    const torqueFactor = this.getTorqueFactor(torqueRpm);

    // Convert crankshaft torque to tractive force at the driven tyres:
    // F = engine torque × gear ratio × final drive × transfer ratio / tyre radius.
    // maxDriveForce is a tyre/traction ceiling, not a substitute for gear ratios.
    const drivelineEfficiency = 0.9;
    const wheelTorqueNm = this.definition.torqueNm
      * torqueFactor
      * gearRatio
      * profile.finalDrive
      * profile.transferDrive
      * drivelineEfficiency;
    const requestedWheelForce = wheelTorqueNm / profile.wheelRadiusM;
    // Soft electronic rev limiter for manual transmission; automatic mode
    // normally upshifts before reaching this range.
    const revLimiter = this.gear === 0
      ? 1
      : 1 - THREE.MathUtils.smoothstep(
        this.definition.maxRpm * 0.985,
        this.definition.maxRpm,
        rawCoupledRpm,
      );
    const engineForce = this.gear === 0
      ? 0
      : Math.max(
        0,
        Math.min(profile.maxDriveForce, requestedWheelForce)
          * this.driveThrottle * speedFade * hybridAssist * revLimiter,
      );

    const drivenWheels = this.definition.drivetrain.toLowerCase().includes('all-wheel')
      ? [0, 1, 2, 3]
      : [0, 2];
    // Rapier applies half of each wheel's longitudinal impulse.
    // Divide the vehicle-level target force across driven wheels accordingly.
    const drivePerWheel = engineForce * 2 / drivenWheels.length;
    const braking = input.brake > 0 && !reverseMode;
    const reverseSpeedLimit = 6; // 21.6 km/h; independent of forward gear ratios.
    const reverseForce = reverseMode && signedSpeed > -reverseSpeedLimit
      ? -profile.maxDriveForce * 0.22 * input.brake * torqueFactor
      : 0;
    // Rapier's wheel engine force is signed: negative force drives the tyres
    // backward through the same contact/friction solver as forward propulsion.
    const reversePerWheel = reverseForce * 2 / drivenWheels.length;
    const wheelDriveForce = braking ? 0 : reverseMode ? reversePerWheel : drivePerWheel;

    // Limit lateral acceleration through the road-wheel angle, rather than
    // leaving near-parking steering lock available at motorway speeds.
    // a_lat = v^2 * tan(delta) / wheelbase; cap commanded cornering demand
    // to a conservative fraction of gravity so a digital steering input
    // cannot abruptly rotate the chassis at speed.
    const steeringWheelbase = this.definition.visual.wheelBase;
    const maxLateralAcceleration = 0.72 * 9.81;
    const dynamicSteerLimit = Math.atan(
      (steeringWheelbase * maxLateralAcceleration) / (this.speedMps * this.speedMps + 1.5),
    );
    const maxSteerAngle = Math.min(0.34, dynamicSteerLimit);
    const centreSteerAngle = THREE.MathUtils.clamp(this.smoothedSteer, -1, 1) * maxSteerAngle;

    // Ackermann geometry: the front tyres converge on a shared instantaneous
    // turn centre on the rear-axle line. The inside front wheel therefore turns
    // farther than the outside wheel. Rear wheels remain straight.
    let leftFrontSteer = 0;
    let rightFrontSteer = 0;
    const turnMagnitude = Math.abs(centreSteerAngle);
    if (turnMagnitude > 1e-4) {
      const wheelbase = this.definition.visual.wheelBase;
      const halfTrack = this.definition.visual.wheelTrack * 0.5;
      const turnRadius = wheelbase / Math.tan(turnMagnitude);
      const innerAngle = Math.atan(wheelbase / Math.max(0.1, turnRadius - halfTrack));
      const outerAngle = Math.atan(wheelbase / (turnRadius + halfTrack));

      // Rapier rotates the wheel axle about chassis-up before deriving its
      // rolling direction. With our -X axle, positive input must stay positive
      // for D/right to turn the front wheels to the vehicle's right.
      const controllerSign = Math.sign(centreSteerAngle);
      if (centreSteerAngle > 0) {
        // Right turn: right front tyre is inside.
        leftFrontSteer = controllerSign * outerAngle;
        rightFrontSteer = controllerSign * innerAngle;
      } else {
        // Left turn: left front tyre is inside.
        leftFrontSteer = controllerSign * innerAngle;
        rightFrontSteer = controllerSign * outerAngle;
      }
    }
    // Rapier's wheelBrake argument is a per-step impulse, not a force in N.
    const baseBrake = braking ? profile.brakeForce * input.brake * safeDt / 4 : 0;
    const coastBrake = this.driveThrottle < 0.015 && input.brake === 0 && this.gear !== 0
      ? profile.engineBrakeForce * 0.22 * safeDt / drivenWheels.length
      : 0;
    const handbrakeImpulse = this.handbrake ? profile.brakeForce * 0.62 * safeDt / 2 : 0;

    for (let i = 0; i < 4; i++) {
      const driven = drivenWheels.includes(i);
      const front = i === 1 || i === 3;
      this.wheelController.setWheelEngineForce(i, driven ? wheelDriveForce : 0);
      this.wheelController.setWheelBrake(
        i,
        baseBrake + (this.handbrake && !front ? handbrakeImpulse : 0)
          + (driven ? coastBrake : 0),
      );
      this.wheelController.setWheelSteering(
        i,
        i === 1 ? leftFrontSteer : i === 3 ? rightFrontSteer : 0,
      );
    }

    // Evaluate tyre contacts before the matching Rapier fixed-step.
    this.wheelController.updateVehicle(safeDt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);

    // Aerodynamic drag grows with velocity squared; rolling resistance
    // prevents the car coasting indefinitely when the engine is off-load.
    if (this.speedMps > 0.05) {
      const airDensity = 1.225;
      const dragArea = 0.76; // Cd × frontal area, representative supercar value.
      const aerodynamicDrag = 0.5 * airDensity * dragArea * this.speedMps * this.speedMps;
      const rollingResistance = profile.massKg * 9.81 * 0.012;
      const stoppingForceLimit = profile.massKg * this.speedMps / safeDt * 0.8;
      const roadLoad = Math.min(aerodynamicDrag + rollingResistance, stoppingForceLimit);
      const dragScale = -roadLoad / this.speedMps;
      // Rapier user forces persist across simulation steps until resetForces()
      // is called. Road load is recomputed every tick, so applying it as the
      // timestep-scaled impulse F * dt avoids accumulating old drag forces.
      this.body.applyImpulse({
        x: this.velocity.x * dragScale * safeDt,
        y: 0,
        z: this.velocity.z * dragScale * safeDt,
      }, true);
    }

    // Reverse is transmitted through the driven tyres above; do not add a
    // second chassis-level force, which bypasses tyre contact and traction.
    this.lastAppliedForwardForce = reverseMode ? reverseForce : (braking ? 0 : engineForce);

    if (reverseMode && !this.reverseAudioLatched) {
      this.shiftEvents.push({
        previousGear: this.gear,
        newGear: this.gear,
        direction: 'reverse',
        type: 'reverse',
        currentRpm: this.rpm,
        targetRpm: Math.max(idleRpm, this.rpm * 0.92),
        automatic: !this.manualTransmission,
      });
      this.reverseAudioLatched = true;
    } else if (!reverseMode && signedSpeed >= -0.1) {
      this.reverseAudioLatched = false;
    }

    const targetRpm = this.gear === 0
      ? idleRpm + this.driveThrottle * (this.definition.maxRpm - idleRpm) * 0.72
      : THREE.MathUtils.lerp(
        launchRpm,
        coupledTorqueRpm,
        clutchEngagement,
      );
    this.rpm = THREE.MathUtils.damp(this.rpm, targetRpm, input.throttle > 0 ? 9 : 6, safeDt);

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
      gearLabel: this.gear === 0 ? 'N' : this.reverseEngaged ? 'R' : String(this.gear),
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
    this.visual.position.set(p.x, p.y, p.z);
    this.visual.quaternion.set(q.x, q.y, q.z, q.w);

    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const wheel = this.wheelMeshes[i];
      const suspensionLength = this.wheelController.wheelSuspensionLength(i) ?? WHEEL_REST_LENGTH;
      const rotation = this.wheelController.wheelRotation(i);
      wheel.position.y = WHEEL_CONNECTION_Y - suspensionLength;
      if (rotation !== null && Number.isFinite(rotation)) wheel.rotation.x = rotation;
      wheel.rotation.y = i === 1 || i === 3 ? (this.wheelController.wheelSteering(i) ?? 0) : 0;
    }
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
    this.lastAppliedForwardForce = 0;
    this.driveThrottle = 0;
    this.brakeToReverseTime = 0;
    this.reverseEngaged = false;
    this.lastShiftAt = 0;
    this.shiftEvents.length = 0;
    this.reverseAudioLatched = false;
    this.handbrake = false;
    this.lastInput = { ...NEUTRAL_INPUT };
    for (const wheel of this.wheelMeshes) wheel.rotation.set(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      this.wheelController.setWheelEngineForce(i, 0);
      this.wheelController.setWheelBrake(i, 0);
      this.wheelController.setWheelSteering(i, 0);
    }
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
    world.removeVehicleController(this.wheelController);
    world.removeRigidBody(this.body);
    this.shiftEvents.length = 0;
  }

  private calculateRawCoupledRpm(gear: number, speedMps: number): number {
    const profile = this.definition.physics;
    const ratio = profile.gearRatios[gear - 1] ?? profile.gearRatios[0];
    const wheelRpm = speedMps / (2 * Math.PI * profile.wheelRadiusM) * 60;
    return wheelRpm * ratio * profile.finalDrive * profile.transferDrive;
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
      : this.calculateRawCoupledRpm(nextGear, Math.abs(signedSpeed));
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

    if (this.gear === 0 || signedSpeed < -0.25) return;
    // Do not upshift/downshift the forward gearbox while the vehicle is moving backward.
    // Keep automatic shifts sequential and prevent hunting around a shift point.
    if (performance.now() - this.lastShiftAt < 240) return;
    const projectedRpm = this.calculateRawCoupledRpm(this.gear, Math.abs(signedSpeed));
    const throttle = THREE.MathUtils.clamp(Math.max(input.throttle, this.driveThrottle), 0, 1);
    const upshiftThreshold = this.definition.maxRpm * THREE.MathUtils.lerp(0.74, 0.91, throttle);
    const downshiftThreshold = Math.max(
      1850,
      this.definition.maxRpm * 0.28,
    );

    if (projectedRpm >= upshiftThreshold && this.gear < gearCount) {
      this.changeGear(this.gear + 1, signedSpeed, true);
    } else if (projectedRpm <= downshiftThreshold
      && this.gear > 1 && Math.abs(signedSpeed) > 3.5) {
      this.changeGear(this.gear - 1, signedSpeed, true);
    }
  }
}
