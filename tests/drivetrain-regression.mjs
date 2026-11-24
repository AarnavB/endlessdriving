import assert from 'node:assert/strict';
import { createServer } from 'vite';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const FIXED_DT = 1 / 60;
const FORWARD_INPUT = {
  throttle: 1, brake: 0, steer: 0, handbrake: false,
  shiftUpPressed: false, shiftDownPressed: false,
};
const NEUTRAL_INPUT = {
  throttle: 0, brake: 0, steer: 0, handbrake: false,
  neutralPressed: false, clutchPedal: 0,
  shiftUpPressed: false, shiftDownPressed: false,
};
const BRAKE_INPUT = { ...NEUTRAL_INPUT, brake: 1 };
const MAX_FORWARD_SIMULATION_SECONDS = 36;

const vite = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

try {
  const [{ VehicleController }, { VEHICLE_CATALOGUE }] = await Promise.all([
    vite.ssrLoadModule('/src/vehicles/VehicleController.ts'),
    vite.ssrLoadModule('/src/vehicles/VehicleDefinitions.ts'),
  ]);

  await RAPIER.init();

  function createSimulation(definition, manual = false, dt = FIXED_DT) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = dt;
    world.numSolverIterations = 8;
    world.numInternalPgsIterations = 2;

    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(500, 0.1, 5000)
        .setTranslation(0, -0.1, 0)
        .setFriction(1.05)
        .setRestitution(0),
      groundBody,
    );

    const scene = new THREE.Scene();
    const vehicle = new VehicleController(world, scene, definition);
    vehicle.setManualTransmission(manual);
    vehicle.reset(new THREE.Vector3(0, 0.72, 0), true, new THREE.Vector3(0, 0, 1));

    return {
      world,
      scene,
      vehicle,
      step(input) {
        vehicle.update(dt, input);
        world.step();
        vehicle.syncVisual();
        const userForce = vehicle.body.userForce();
        return {
          telemetry: vehicle.getTelemetry(),
          debug: vehicle.getDebugTelemetry(input, dt, 1),
          residualUserForce: Math.hypot(userForce.x, userForce.y, userForce.z),
        };
      },
      dispose() {
        vehicle.dispose(world, scene);
        world.free();
      },
    };
  }

  function assertNoPersistentForce(sim, context) {
    const { residualUserForce } = sim.step(NEUTRAL_INPUT);
    assert(
      residualUserForce < 1e-6,
      `${context}: unexpected persistent Rapier user force ${residualUserForce}`,
    );
  }

  function runForwardAcceleration(definition, manual = false, dt = FIXED_DT) {
    const sim = createSimulation(definition, manual, dt);
    let maxSpeedKmh = 0;
    let minSignedSpeed = 0;
    let maxGear = 1;
    let previousGear = 1;
    let gearTransitions = 0;
    let firstShiftSeconds = null;
    let zeroTo100Seconds = null;
    let upshiftNextTick = false;
    const milestones = new Set();
    const maxRpm = definition.maxRpm;
    const recentSamples = [];

    try {
      for (let step = 0; step < Math.ceil(MAX_FORWARD_SIMULATION_SECONDS / dt); step++) {
        const input = {
          ...FORWARD_INPUT,
          shiftUpPressed: manual && upshiftNextTick,
        };
        upshiftNextTick = false;

        const { telemetry, debug, residualUserForce } = sim.step(input);
        maxSpeedKmh = Math.max(maxSpeedKmh, telemetry.speedKmh);
        minSignedSpeed = Math.min(minSignedSpeed, debug.forwardSpeed);
        maxGear = Math.max(maxGear, telemetry.gear);

        recentSamples.push({
          step,
          speedKmh: Number(telemetry.speedKmh.toFixed(2)),
          signedSpeedMps: Number(debug.forwardSpeed.toFixed(3)),
          rpm: Math.round(telemetry.rpm),
          gear: telemetry.gear,
          appliedForceN: Number(debug.appliedForwardForce.toFixed(1)),
        });
        if (recentSamples.length > 6) recentSamples.shift();

        if (telemetry.gear !== previousGear) {
          gearTransitions++;
          if (firstShiftSeconds === null) firstShiftSeconds = step * dt;
          previousGear = telemetry.gear;
        }
        if (zeroTo100Seconds === null && telemetry.speedKmh >= 100) {
          zeroTo100Seconds = step * dt;
        }

        for (const threshold of [50, 60, 80, 100, 150]) {
          if (telemetry.speedKmh >= threshold) milestones.add(threshold);
        }

        // In manual mode, issue a single shift edge near the top of the
        // current gear's usable range.
        if (manual && telemetry.gear < definition.physics.gearRatios.length
          && telemetry.rpm >= maxRpm * 0.78) {
          upshiftNextTick = true;
        }

        assert.equal(debug.brake, 0, `${definition.name}: unexpected brake input`);
        assert(
          debug.appliedForwardForce >= -1e-6,
          `${definition.name} (${manual ? 'manual' : 'auto'}): negative propulsion force in a forward gear`,
        );
        assert(
          debug.forwardSpeed >= -0.15,
          `${definition.name} (${manual ? 'manual' : 'auto'}): W-only run reversed. Last samples: ${JSON.stringify(recentSamples)}`,
        );
        assert(
          residualUserForce < 1e-6,
          `${definition.name}: road-load force remained in Rapier's persistent force accumulator`,
        );
        assert(
          telemetry.rpm <= maxRpm * 1.02,
          `${definition.name}: engine RPM exceeded configured maximum (${telemetry.rpm.toFixed(0)} > ${maxRpm})`,
        );
      }

      assert(
        maxSpeedKmh >= 150,
        `${definition.name} (${manual ? 'manual' : 'auto'}): only reached ${maxSpeedKmh.toFixed(1)} km/h on a clear flat test surface`,
      );
      assert.equal(
        milestones.size,
        5,
        `${definition.name} (${manual ? 'manual' : 'auto'}): missed speed milestones ${[50, 60, 80, 100, 150].filter(x => !milestones.has(x)).join(', ')} km/h`,
      );
      assert(gearTransitions > 0, `${definition.name}: transmission did not change gear`);
      if (!manual && maxSpeedKmh > 100) {
        assert(
          maxGear >= 3 && gearTransitions >= 2,
          `${definition.name}: automatic gearbox did not progressively upshift beyond second gear (highest=${maxGear}, shifts=${gearTransitions})`,
        );
        assert(
          gearTransitions === maxGear - 1,
          `${definition.name}: automatic gearbox hunted or skipped sequential forward gears (highest=${maxGear}, shifts=${gearTransitions})`,
        );
      }

      return {
        vehicle: definition.name,
        mode: manual ? 'manual' : 'automatic',
        maxSpeedKmh: Number(maxSpeedKmh.toFixed(1)),
        minimumSignedSpeedMps: Number(minSignedSpeed.toFixed(3)),
        highestGear: maxGear,
        gearTransitions,
        firstShiftSeconds: firstShiftSeconds === null ? null : Number(firstShiftSeconds.toFixed(2)),
        zeroTo100Seconds: zeroTo100Seconds === null ? null : Number(zeroTo100Seconds.toFixed(2)),
        speedMilestonesKmh: [...milestones].sort((a, b) => a - b),
        result: 'PASS',
      };
    } finally {
      sim.dispose();
    }
  }

  function runCoastBrakeAndReverse(definition) {
    const sim = createSimulation(definition, false, FIXED_DT);
    let coastStartKmh = 0;
    let coastEndKmh = 0;
    let stoppedDuringBrake = false;
    let reverseMaximumMps = 0;
    let reverseApplied = false;
    let returnedToForward = false;

    try {
      // Accelerate through the regression speed window first.
      for (let i = 0; i < 420; i++) {
        const { telemetry, debug, residualUserForce } = sim.step(FORWARD_INPUT);
        assert(debug.forwardSpeed >= -0.15, 'F40 reversed during W-only launch');
        assert(debug.appliedForwardForce >= 0, 'F40 produced negative forward propulsion');
        assert(residualUserForce < 1e-6, 'F40 retained a force after world.step');
      }
      assert(sim.vehicle.getTelemetry().speedKmh >= 50, 'F40 did not reach the 50 km/h regression window');

      // Throttle release must coast down without changing direction.
      coastStartKmh = sim.vehicle.getTelemetry().speedKmh;
      for (let i = 0; i < 240; i++) {
        const { debug } = sim.step(NEUTRAL_INPUT);
        assert(debug.forwardSpeed >= -0.15, 'F40 reversed while coasting with no controls');
      }
      coastEndKmh = sim.vehicle.getTelemetry().speedKmh;
      assert(coastEndKmh < coastStartKmh, 'F40 did not lose speed after throttle release');

      // S while moving is braking. Release it as soon as the vehicle reaches
      // standstill so this test does not request intentional reverse.
      for (let i = 0; i < 360; i++) {
        const { debug } = sim.step(BRAKE_INPUT);
        assert(debug.forwardSpeed >= -0.35, 'F40 crossed into meaningful reverse motion while braking');
        if (Math.abs(debug.forwardSpeed) <= 0.12) {
          stoppedDuringBrake = true;
          break;
        }
      }
      assert(stoppedDuringBrake, 'F40 did not reach standstill under controlled braking');

      // Keep the service brake held at standstill. Releasing it in gear now
      // correctly permits idle creep, so the intentional reverse gesture is
      // a continuous brake hold through the existing 0.4 s engagement delay.
      assert(
        Math.abs(sim.vehicle.getDebugTelemetry(BRAKE_INPUT, FIXED_DT, 1).forwardSpeed) <= 0.25,
        'F40 did not reach standstill before intentional reverse request',
      );
      for (let i = 0; i < 90; i++) {
        const { debug } = sim.step(BRAKE_INPUT);
        if (debug.appliedForwardForce < -1e-6) reverseApplied = true;
        reverseMaximumMps = Math.max(reverseMaximumMps, Math.abs(debug.forwardSpeed));
      }
      assert(reverseApplied, 'F40 did not apply reverse propulsion after an intentional standstill request');
      assert(reverseMaximumMps <= 6.4, `F40 exceeded reverse speed limit: ${reverseMaximumMps.toFixed(2)} m/s`);

      // Applying W exits reverse propulsion and restores forward drive through
      // the existing transmission state.
      for (let i = 0; i < 360; i++) {
        const { debug } = sim.step(FORWARD_INPUT);
        assert(debug.appliedForwardForce >= -1e-6, 'F40 applied reverse force after W was requested');
        if (debug.forwardSpeed > 0.5) {
          returnedToForward = true;
          break;
        }
      }
      assert(returnedToForward, 'F40 failed to transition from reverse back to forward movement');

      return {
        vehicle: definition.name,
        coastingFromKmh: Number(coastStartKmh.toFixed(1)),
        coastingToKmh: Number(coastEndKmh.toFixed(1)),
        stoppedUnderBrake: stoppedDuringBrake,
        intentionalReverseApplied: reverseApplied,
        maximumReverseSpeedMps: Number(reverseMaximumMps.toFixed(2)),
        returnedToForward,
        result: 'PASS',
      };
    } finally {
      sim.dispose();
    }
  }

  function runNeutralClutchEngineBrakeAndHandbrakeRegression(definition) {
    const sim = createSimulation(definition, true, FIXED_DT);
    try {
      // N must disengage the current forward ratio, including when it is not
      // first gear, and the engine must be able to free-rev without wheel force.
      sim.vehicle.selectGear(definition.physics.gearRatios.length);
      const neutral = sim.step({ ...NEUTRAL_INPUT, neutralPressed: true });
      assert.equal(neutral.telemetry.gearLabel, 'N', 'N input did not select neutral from a forward gear');
      for (let i = 0; i < 90; i++) {
        const sample = sim.step(FORWARD_INPUT);
        assert.equal(sample.telemetry.gearLabel, 'N', 'Neutral was not retained in manual mode');
        assert(Math.abs(sample.debug.appliedForwardForce) < 1e-5, 'Neutral transmitted engine torque to the wheels');
      }
      assert(
        sim.vehicle.getTelemetry().rpm > definition.maxRpm * 0.55,
        'Engine did not free-rev in neutral under throttle',
      );

      // E engages first from neutral. With the clutch pedal depressed, engine
      // RPM rises but no torque should reach the tyres.
      sim.step({ ...NEUTRAL_INPUT, shiftUpPressed: true });
      assert.equal(sim.vehicle.getTelemetry().gear, 1, 'E did not engage first gear from neutral');
      sim.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      for (let i = 0; i < 90; i++) {
        const sample = sim.step({ ...FORWARD_INPUT, clutchPedal: 1 });
        assert(Math.abs(sample.debug.appliedForwardForce) < 1e-5, 'Disengaged clutch transmitted wheel torque');
      }
      assert(
        sim.vehicle.getTelemetry().rpm > definition.maxRpm * 0.55,
        'Engine RPM did not respond while the clutch was disengaged',
      );

      // Releasing the clutch at idle must transmit engine torque mechanically
      // and permit low-speed creep without throttle input.
      for (let i = 0; i < 240; i++) sim.step(NEUTRAL_INPUT);
      assert(
        sim.vehicle.getTelemetry().speedMps > 0.12,
        'Fully engaged clutch did not produce idle creep through the drivetrain',
      );

      // N is a toggle from every forward gear in manual mode. The selected
      // ratio must be restored exactly on the next N edge.
      for (let gear = 1; gear <= definition.physics.gearRatios.length; gear++) {
        sim.vehicle.selectGear(gear);
        const neutral = sim.step({ ...NEUTRAL_INPUT, neutralPressed: true });
        assert.equal(neutral.telemetry.gearLabel, 'N', `N failed from forward gear ${gear}`);
        assert(Math.abs(neutral.debug.appliedForwardForce) < 1e-5,
          `Neutral transmitted torque after entering from gear ${gear}`);
        const restored = sim.step({ ...NEUTRAL_INPUT, neutralPressed: true });
        assert.equal(restored.telemetry.gear, gear,
          `N failed to restore manual gear ${gear} (restored ${restored.telemetry.gearLabel})`);
      }

      // Select reverse using the established standstill brake gesture, then
      // verify N cancels reverse and the next N restores the stored forward
      // ratio without retaining the reverse latch.
      sim.vehicle.selectGear(1);
      sim.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      for (let i = 0; i < 32; i++) sim.step(BRAKE_INPUT);
      sim.step({ ...NEUTRAL_INPUT, neutralPressed: true });
      assert.equal(sim.vehicle.getTelemetry().gearLabel, 'N', 'N failed to cancel reverse selection');
      const restoredAfterReverse = sim.step({ ...NEUTRAL_INPUT, neutralPressed: true });
      assert.equal(restoredAfterReverse.telemetry.gear, 1,
        'N did not restore first gear after cancelling reverse');
      assert.equal(restoredAfterReverse.telemetry.gearLabel, '1',
        'Reverse latch remained active after restoring the forward ratio');

      // Automatic mode selects a mechanically safe, speed-appropriate ratio
      // from neutral. Higher throttle demand must not choose a taller ratio.
      function automaticGearAfterNeutral(speedKmh, throttle) {
        const automatic = createSimulation(definition, false, FIXED_DT);
        try {
          automatic.vehicle.body.setLinvel({ x: 0, y: 0, z: speedKmh / 3.6 }, true);
          const entered = automatic.step({
            ...NEUTRAL_INPUT, throttle, neutralPressed: true,
          });
          assert.equal(entered.telemetry.gearLabel, 'N',
            `Automatic N entry failed at ${speedKmh} km/h`);
          const restored = automatic.step({
            ...NEUTRAL_INPUT, throttle, neutralPressed: true,
          });
          assert(restored.telemetry.gear >= 1,
            `Automatic neutral toggle did not choose a gear at ${speedKmh} km/h`);
          const velocity = automatic.vehicle.body.linvel();
          const roadSpeed = Math.hypot(velocity.x, velocity.z);
          const wheelRpm = roadSpeed / (2 * Math.PI * definition.physics.wheelRadiusM) * 60;
          const projectedRpm = wheelRpm
            * definition.physics.gearRatios[restored.telemetry.gear - 1]
            * definition.physics.finalDrive
            * definition.physics.transferDrive;
          assert(projectedRpm <= definition.maxRpm * 0.985 + 1,
            `Automatic neutral restoration selected an over-revving gear at ${speedKmh} km/h (${projectedRpm.toFixed(0)} rpm)`);
          return restored.telemetry.gear;
        } finally {
          automatic.dispose();
        }
      }
      const automaticLowLoadGear = automaticGearAfterNeutral(100, 0);
      const automaticHighLoadGear = automaticGearAfterNeutral(100, 1);
      assert(automaticHighLoadGear <= automaticLowLoadGear,
        `Automatic neutral restoration chose a taller gear at higher throttle demand (low-load=${automaticLowLoadGear}, high-load=${automaticHighLoadGear})`);
      assert.equal(automaticGearAfterNeutral(10, 0), 1,
        'Automatic neutral restoration should select first gear near standstill');

      // Engine braking must be a negative driveline force in gear and vanish in
      // neutral. Use matched speed and fixed-step simulations for comparison.
      function coastSpeed(inGear) {
        const coast = createSimulation(definition, true, FIXED_DT);
        try {
          for (let i = 0; i < 120; i++) coast.step(NEUTRAL_INPUT);
          coast.vehicle.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
          coast.vehicle.selectGear(inGear ? 1 : 0);
          for (let i = 0; i < 90; i++) coast.step(NEUTRAL_INPUT);
          return coast.vehicle.getTelemetry().speedMps;
        } finally {
          coast.dispose();
        }
      }
      const inGearCoastSpeed = coastSpeed(true);
      const neutralCoastSpeed = coastSpeed(false);
      assert(
        inGearCoastSpeed + 0.25 < neutralCoastSpeed,
        `Engine braking did not reduce speed in gear (gear=${inGearCoastSpeed.toFixed(2)}, neutral=${neutralCoastSpeed.toFixed(2)} m/s)`,
      );

      function handbrakeSpeed(active) {
        const brakeSim = createSimulation(definition, true, FIXED_DT);
        try {
          // Establish real wheel rotation through the tyre controller before
          // comparing handbrake response; teleporting chassis velocity leaves
          // the ray-cast wheel angular state uninitialised.
          for (let i = 0; i < 360; i++) brakeSim.step(FORWARD_INPUT);
          brakeSim.vehicle.selectGear(0);
          for (let i = 0; i < 30; i++) brakeSim.step(NEUTRAL_INPUT);
          const speedBeforeHandbrake = brakeSim.vehicle.getTelemetry().speedMps;
          for (let i = 0; i < 90; i++) {
            const sample = brakeSim.step({ ...NEUTRAL_INPUT, handbrake: active });
            if (active) {
              assert.equal(sample.telemetry.handbrakeActive, true, 'HUD telemetry did not report handbrake active');
              assert((brakeSim.vehicle.wheelController.wheelBrake(0) ?? 0) > 0,
                'Handbrake did not apply impulse to left rear wheel');
              assert((brakeSim.vehicle.wheelController.wheelBrake(2) ?? 0) > 0,
                'Handbrake did not apply impulse to right rear wheel');
              assert(Math.abs(brakeSim.vehicle.wheelController.wheelBrake(1) ?? 0) < 1e-6,
                'Handbrake incorrectly applied to left front wheel');
              assert(Math.abs(brakeSim.vehicle.wheelController.wheelBrake(3) ?? 0) < 1e-6,
                'Handbrake incorrectly applied to right front wheel');
            }
          }
          assert(speedBeforeHandbrake > 3, 'Handbrake regression did not establish a meaningful rolling speed');
          return brakeSim.vehicle.getTelemetry().speedMps;
        } finally {
          brakeSim.dispose();
        }
      }
      const freeRollSpeed = handbrakeSpeed(false);
      const handbrakeRollSpeed = handbrakeSpeed(true);
      assert(
        handbrakeRollSpeed + 0.5 < freeRollSpeed,
        `Rear handbrake did not measurably slow the vehicle (handbrake=${handbrakeRollSpeed.toFixed(2)}, free=${freeRollSpeed.toFixed(2)} m/s)`,
      );

      return {
        vehicle: definition.name,
        neutralFromAllForwardGears: true,
        clutchDisengagementStopsDrive: true,
        idleCreepMps: Number(sim.vehicle.getTelemetry().speedMps.toFixed(2)),
        engineBrakingMps: Number(inGearCoastSpeed.toFixed(2)),
        neutralCoastMps: Number(neutralCoastSpeed.toFixed(2)),
        handbrakeMps: Number(handbrakeRollSpeed.toFixed(2)),
        result: 'PASS',
      };
    } finally {
      sim.dispose();
    }
  }

  function runSteeringRegression(definition) {
    function runDirection(steer) {
      const sim = createSimulation(definition, false, FIXED_DT);
      let previousYaw = Math.atan2(sim.vehicle.getForward().x, sim.vehicle.getForward().z);
      let accumulatedYaw = 0;
      try {
        sim.step({ ...NEUTRAL_INPUT, steer });
        const controller = sim.vehicle.wheelController;
        const leftFront = controller.wheelSteering(1) ?? 0;
        const rightFront = controller.wheelSteering(3) ?? 0;
        assert(Math.sign(leftFront) === Math.sign(steer), 'Left-front steering angle has the wrong sign');
        assert(Math.sign(rightFront) === Math.sign(steer), 'Right-front steering angle has the wrong sign');
        assert(Math.abs(controller.wheelSteering(0) ?? 0) < 1e-6, 'Left-rear wheel received a steering angle');
        assert(Math.abs(controller.wheelSteering(2) ?? 0) < 1e-6, 'Right-rear wheel received a steering angle');
        assert(
          Math.abs(sim.vehicle.wheelMeshes[1].steeringPivot.rotation.y - leftFront) < 1e-4,
          'Rendered left-front steering pivot disagrees with Rapier',
        );

        for (let i = 0; i < 240; i++) {
          sim.step({ ...FORWARD_INPUT, steer });
          const forward = sim.vehicle.getForward();
          const yaw = Math.atan2(forward.x, forward.z);
          let delta = yaw - previousYaw;
          if (delta > Math.PI) delta -= Math.PI * 2;
          if (delta < -Math.PI) delta += Math.PI * 2;
          accumulatedYaw += delta;
          previousYaw = yaw;
        }
        assert(
          accumulatedYaw * steer > 0.015,
          `Chassis yaw sign disagrees with steering input (${steer} input, ${accumulatedYaw.toFixed(4)} rad yaw)`,
        );

        const beforeCentre = Math.abs(controller.wheelSteering(1) ?? 0);
        for (let i = 0; i < 90; i++) sim.step(NEUTRAL_INPUT);
        const afterCentre = Math.abs(controller.wheelSteering(1) ?? 0);
        assert(afterCentre < Math.max(0.002, beforeCentre * 0.15), 'Steering did not smoothly return toward centre');
        return {
          direction: steer < 0 ? 'left' : 'right',
          accumulatedYawRadians: Number(accumulatedYaw.toFixed(4)),
          initialFrontAnglesRadians: [Number(leftFront.toFixed(4)), Number(rightFront.toFixed(4))],
          centreResidualRadians: Number(afterCentre.toFixed(5)),
          result: 'PASS',
        };
      } finally {
        sim.dispose();
      }
    }
    return { vehicle: definition.name, left: runDirection(-0.65), right: runDirection(0.65), result: 'PASS' };
  }

  function runSpeedSensitiveSteeringRegression(definition) {
    const speedsKmh = [10, 30, 50, 80, 100, 150];
    const samples = [];
    for (const speedKmh of speedsKmh) {
      const sim = createSimulation(definition, false, FIXED_DT);
      try {
        sim.vehicle.selectGear(0);
        sim.vehicle.body.setLinvel({ x: 0, y: 0, z: speedKmh / 3.6 }, true);
        let sample;
        // Allow the speed-sensitive rack filter to settle before measuring
        // physical wheel angles.
        for (let frame = 0; frame < 36; frame++) {
          sample = sim.step({ ...NEUTRAL_INPUT, steer: 1 });
        }
        const controller = sim.vehicle.wheelController;
        const left = controller.wheelSteering(1) ?? 0;
        const right = controller.wheelSteering(3) ?? 0;
        assert(left > 0 && right > 0,
          `${definition.name}: right steering command lost direction at ${speedKmh} km/h`);
        assert(
          Math.abs(sim.vehicle.wheelMeshes[1].steeringPivot.rotation.y - left) < 1e-4,
          `${definition.name}: left steering visual diverged at ${speedKmh} km/h`,
        );
        assert(
          Math.abs(sim.vehicle.wheelMeshes[3].steeringPivot.rotation.y - right) < 1e-4,
          `${definition.name}: right steering visual diverged at ${speedKmh} km/h`,
        );

        // For a right turn, the right-front wheel is inside and must steer
        // farther than the left-front outside wheel. Reconstruct the centre
        // rack angle from both wheel radii instead of comparing either
        // Ackermann road-wheel angle directly with the rack calibration.
        const wheelbase = definition.visual.wheelBase;
        const halfTrack = definition.visual.wheelTrack * 0.5;
        const insideRadius = wheelbase / Math.tan(Math.abs(right));
        const outsideRadius = wheelbase / Math.tan(Math.abs(left));
        const reconstructedRackRadius = (insideRadius + outsideRadius) * 0.5;
        const reconstructedRackAngle = Math.atan(wheelbase / reconstructedRackRadius);
        assert(
          Math.abs(reconstructedRackAngle) <= 0.34 + 1e-4,
          `${definition.name}: reconstructed rack command exceeded calibration at ${speedKmh} km/h (${reconstructedRackAngle.toFixed(4)} rad)`,
        );
        assert(
          Math.abs((outsideRadius - insideRadius) - halfTrack * 2) < 0.02,
          `${definition.name}: Ackermann radii do not match the configured front track at ${speedKmh} km/h (inside=${insideRadius.toFixed(3)} m, outside=${outsideRadius.toFixed(3)} m)`,
        );
        samples.push({
          speedKmh,
          leftAngleRad: Number(left.toFixed(4)),
          rightAngleRad: Number(right.toFixed(4)),
          reconstructedRackAngleRad: Number(reconstructedRackAngle.toFixed(4)),
        });
      } finally {
        sim.dispose();
      }
    }
    for (let i = 1; i < samples.length; i++) {
      assert(samples[i - 1].leftAngleRad > samples[i].leftAngleRad,
        `${definition.name}: steering did not progressively reduce from ${samples[i - 1].speedKmh} to ${samples[i].speedKmh} km/h`);
    }
    assert(samples[2].leftAngleRad >= 0.1,
      `${definition.name}: steering authority remained too low at 50 km/h (${samples[2].leftAngleRad} rad)`);
    assert(samples[4].leftAngleRad >= 0.02,
      `${definition.name}: steering authority collapsed at 100 km/h (${samples[4].leftAngleRad} rad)`);
    assert(samples[5].leftAngleRad >= 0.005,
      `${definition.name}: steering authority collapsed at 150 km/h (${samples[5].leftAngleRad} rad)`);
    return { vehicle: definition.name, samples, result: 'PASS' };
  }

  function runWheelPhysicsRegression(definition) {
    const sim = createSimulation(definition, false, FIXED_DT);
    try {
      for (let i = 0; i < 180; i++) sim.step(NEUTRAL_INPUT);
      const controller = sim.vehicle.wheelController;
      const stationaryWheels = [];
      for (let i = 0; i < 4; i++) {
        assert(controller.wheelIsInContact(i), `${definition.name}: wheel ${i} lost contact on a flat road`);
        const normal = controller.wheelContactNormal(i);
        assert(normal && normal.y > 0.8, `${definition.name}: wheel ${i} has an invalid contact normal`);
        const suspensionLength = controller.wheelSuspensionLength(i);
        assert(
          Number.isFinite(suspensionLength) && suspensionLength >= 0 && suspensionLength <= 0.5,
          `${definition.name}: wheel ${i} suspension is out of bounds (${suspensionLength})`,
        );
        const visualWheel = sim.vehicle.wheelMeshes[i];
        assert(
          Math.abs(visualWheel.steeringPivot.position.y - (-0.16 - suspensionLength)) < 1e-4,
          `${definition.name}: wheel ${i} visual position is detached from suspension state`,
        );
        stationaryWheels.push({ index: i, suspensionLength: Number(suspensionLength.toFixed(4)) });
      }

      for (let i = 0; i < 90; i++) sim.step(FORWARD_INPUT);
      const rolling = [];
      for (let i = 0; i < 4; i++) {
        const angle = controller.wheelRotation(i);
        assert(Number.isFinite(angle), `${definition.name}: wheel ${i} rotation is not finite`);
        assert(
          Math.abs(sim.vehicle.wheelMeshes[i].rolling.rotation.x - angle) < 1e-4,
          `${definition.name}: wheel ${i} render rotation is not synchronised`,
        );
        rolling.push(Number(angle.toFixed(4)));
      }
      sim.step({ ...NEUTRAL_INPUT, steer: -0.6 });
      for (const i of [1, 3]) {
        const angle = controller.wheelSteering(i) ?? 0;
        assert(angle < 0, `${definition.name}: left input did not turn front wheel ${i} left`);
        assert(
          Math.abs(sim.vehicle.wheelMeshes[i].steeringPivot.rotation.y - angle) < 1e-4,
          `${definition.name}: steering pivot ${i} is not synchronised`,
        );
      }
      for (const i of [0, 2]) {
        assert(Math.abs(controller.wheelSteering(i) ?? 0) < 1e-6, `${definition.name}: rear wheel ${i} steered`);
      }
      return {
        vehicle: definition.name,
        stationaryWheels,
        forwardWheelAnglesRadians: rolling,
        frontSteeringSign: 'left input -> negative angle',
        result: 'PASS',
      };
    } finally {
      sim.dispose();
    }
  }

  function runPerGearMechanicalChecks(definition) {
    const sim = createSimulation(definition, true, FIXED_DT);
    const profile = definition.physics;
    const redlineSpeeds = profile.gearRatios.map((ratio, index) => {
      const totalReduction = ratio * profile.finalDrive * profile.transferDrive;
      const wheelRpmAtRedline = definition.maxRpm / totalReduction;
      const speedMps = wheelRpmAtRedline / 60 * 2 * Math.PI * profile.wheelRadiusM;
      return { gear: index + 1, ratio, redlineSpeedKmh: speedMps * 3.6 };
    });
    try {
      for (let i = 0; i < 900; i++) {
        const { telemetry, debug } = sim.step(FORWARD_INPUT);
        assert.equal(telemetry.gear, 1, `${definition.name}: manual first gear changed without shift input`);
        assert(telemetry.rpm <= definition.maxRpm * 1.02, `${definition.name}: first-gear rev limiter failed`);
        assert(debug.appliedForwardForce >= -1e-6, `${definition.name}: first gear generated negative propulsion`);
        if (telemetry.speedMps > 6 && telemetry.rpm < definition.maxRpm * 0.96) {
          const wheelRpm = telemetry.speedMps / (2 * Math.PI * profile.wheelRadiusM) * 60;
          const expectedRpm = wheelRpm * profile.gearRatios[0] * profile.finalDrive * profile.transferDrive;
          assert(
            Math.abs(telemetry.rpm - expectedRpm) < definition.maxRpm * 0.04,
            `${definition.name}: engine RPM disconnected from driven-wheel RPM in first gear`,
          );
        }
      }
      const telemetry = sim.vehicle.getTelemetry();
      const firstGearRedlineKmh = redlineSpeeds[0].redlineSpeedKmh;
      assert(
        telemetry.speedKmh <= firstGearRedlineKmh * 1.12 + 3,
        `${definition.name}: first gear exceeded ratio-derived redline speed (${telemetry.speedKmh.toFixed(1)} > ${firstGearRedlineKmh.toFixed(1)} km/h)`,
      );
      assert(
        telemetry.rpm >= definition.maxRpm * 0.88,
        `${definition.name}: full-throttle first gear did not approach engine redline`,
      );
      for (let i = 1; i < redlineSpeeds.length; i++) {
        assert(
          redlineSpeeds[i].redlineSpeedKmh > redlineSpeeds[i - 1].redlineSpeedKmh,
          `${definition.name}: gear ${i + 1} has no higher redline speed than gear ${i}`,
        );
      }
      const isolatedGearRuns = [];
      for (let gear = 1; gear <= profile.gearRatios.length; gear++) {
        const gearSim = createSimulation(definition, true, FIXED_DT);
        try {
          const expected = redlineSpeeds[gear - 1];
          const startSpeedMps = expected.redlineSpeedKmh / 3.6 * 0.94;
          gearSim.vehicle.body.setLinvel({ x: 0, y: 0, z: startSpeedMps }, true);
          gearSim.vehicle.selectGear(gear);
          let maximumSpeedKmh = 0;
          for (let i = 0; i < 150; i++) {
            const { telemetry } = gearSim.step(FORWARD_INPUT);
            maximumSpeedKmh = Math.max(maximumSpeedKmh, telemetry.speedKmh);
            assert.equal(
              telemetry.gear,
              gear,
              `${definition.name}: manual gear ${gear} changed without a player shift`,
            );
            assert(
              telemetry.rpm <= definition.maxRpm * 1.02,
              `${definition.name}: gear ${gear} exceeded engine redline`,
            );
            if (telemetry.speedMps > 8 && telemetry.rpm < definition.maxRpm * 0.96) {
              const wheelRpm = telemetry.speedMps / (2 * Math.PI * profile.wheelRadiusM) * 60;
              const expectedRpm = wheelRpm * profile.gearRatios[gear - 1]
                * profile.finalDrive * profile.transferDrive;
              assert(
                Math.abs(telemetry.rpm - expectedRpm) < definition.maxRpm * 0.05,
                `${definition.name}: gear ${gear} RPM is not coupled to wheel speed`,
              );
            }
          }
          const finalTelemetry = gearSim.vehicle.getTelemetry();
          assert(
            maximumSpeedKmh <= expected.redlineSpeedKmh * 1.12 + 3,
            `${definition.name}: gear ${gear} exceeded ratio-derived redline speed (${maximumSpeedKmh.toFixed(1)} > ${expected.redlineSpeedKmh.toFixed(1)} km/h)`,
          );
          isolatedGearRuns.push({
            gear,
            ratio: expected.ratio,
            calculatedRedlineSpeedKmh: Number(expected.redlineSpeedKmh.toFixed(1)),
            measuredMaximumSpeedKmh: Number(maximumSpeedKmh.toFixed(1)),
            finalEngineRpm: Math.round(finalTelemetry.rpm),
            result: 'PASS',
          });
        } finally {
          gearSim.dispose();
        }
      }
      return {
        vehicle: definition.name,
        manualGearHeld: 1,
        calculatedRedlineSpeedsKmh: redlineSpeeds.map((entry) => ({
          gear: entry.gear,
          speed: Number(entry.redlineSpeedKmh.toFixed(1)),
        })),
        measuredFirstGearSpeedKmh: Number(telemetry.speedKmh.toFixed(1)),
        finalEngineRpm: Math.round(telemetry.rpm),
        isolatedGearRuns,
        result: 'PASS',
      };
    } finally {
      sim.dispose();
    }
  }

  const vehicleRuns = [];
  for (const definition of VEHICLE_CATALOGUE) {
    vehicleRuns.push(runForwardAcceleration(definition, false));
    vehicleRuns.push(runForwardAcceleration(definition, true));
  }

  const defaultVehicle = VEHICLE_CATALOGUE[0];
  const scenarioRuns = [runCoastBrakeAndReverse(defaultVehicle)];
  const transmissionControlRuns = [
    runNeutralClutchEngineBrakeAndHandbrakeRegression(defaultVehicle),
  ];
  const steeringRuns = VEHICLE_CATALOGUE.map(runSteeringRegression);
  const speedSensitiveSteeringRuns = VEHICLE_CATALOGUE.map(runSpeedSensitiveSteeringRegression);
  const wheelPhysicsRuns = VEHICLE_CATALOGUE.map(runWheelPhysicsRegression);
  const perGearRuns = VEHICLE_CATALOGUE.map(runPerGearMechanicalChecks);

  const timestepRuns = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    const sim = createSimulation(defaultVehicle, false, dt);
    let minimumSignedSpeedMps = 0;
    let maximumSpeedKmh = 0;
    let previousGear = 1;
    const gearTransitions = [];
    try {
      for (let i = 0; i < Math.ceil(12 / dt); i++) {
        const { telemetry, debug, residualUserForce } = sim.step(FORWARD_INPUT);
        minimumSignedSpeedMps = Math.min(minimumSignedSpeedMps, debug.forwardSpeed);
        maximumSpeedKmh = Math.max(maximumSpeedKmh, telemetry.speedKmh);
        if (telemetry.gear !== previousGear) {
          gearTransitions.push({
            gear: telemetry.gear,
            simulationTimeSeconds: Number(((i + 1) * dt).toFixed(4)),
          });
          previousGear = telemetry.gear;
        }
        assert(debug.forwardSpeed >= -0.15, `F40 reversed at timestep ${dt}`);
        assert(debug.appliedForwardForce >= -1e-6, `F40 produced negative propulsion at timestep ${dt}`);
        assert(residualUserForce < 1e-6, `F40 retained a persistent force at timestep ${dt}`);
      }
      assert(
        gearTransitions.length >= 2,
        `F40 automatic gearbox failed to exercise multiple shifts at timestep ${dt}`,
      );
      timestepRuns.push({
        timestepSeconds: Number(dt.toFixed(6)),
        minimumSignedSpeedMps: Number(minimumSignedSpeedMps.toFixed(3)),
        maximumSpeedKmh: Number(maximumSpeedKmh.toFixed(1)),
        gearTransitions,
        result: 'PASS',
      });
    } finally {
      sim.dispose();
    }
  }

  const referenceShiftSequence = timestepRuns[0].gearTransitions.map((event) => event.gear);
  for (const run of timestepRuns.slice(1)) {
    const sequence = run.gearTransitions.map((event) => event.gear);
    assert.deepEqual(
      sequence,
      referenceShiftSequence,
      `F40 automatic gear sequence changed at timestep ${run.timestepSeconds}`,
    );
    for (let i = 0; i < run.gearTransitions.length; i++) {
      assert(
        Math.abs(
          run.gearTransitions[i].simulationTimeSeconds
          - timestepRuns[0].gearTransitions[i].simulationTimeSeconds,
        ) <= 0.25,
        `F40 shift to gear ${sequence[i]} occurred at inconsistent simulation time for timestep ${run.timestepSeconds}`,
      );
    }
  }

  console.log(JSON.stringify({
    simulation: 'Rapier DynamicRayCastVehicleController with a flat static ground collider',
    fixedTimestepSeconds: FIXED_DT,
    vehicleRuns,
    scenarioRuns,
    transmissionControlRuns,
    steeringRuns,
    speedSensitiveSteeringRuns,
    wheelPhysicsRuns,
    perGearRuns,
    timestepRuns,
    summary: {
      vehicleRunsPassed: vehicleRuns.length,
      vehicleRunsFailed: 0,
      scenarioRunsPassed: scenarioRuns.length,
      scenarioRunsFailed: 0,
      transmissionControlRunsPassed: transmissionControlRuns.length,
      transmissionControlRunsFailed: 0,
      steeringRunsPassed: steeringRuns.length,
      steeringRunsFailed: 0,
      speedSensitiveSteeringRunsPassed: speedSensitiveSteeringRuns.length,
      speedSensitiveSteeringRunsFailed: 0,
      wheelPhysicsRunsPassed: wheelPhysicsRuns.length,
      wheelPhysicsRunsFailed: 0,
      timestepRunsPassed: timestepRuns.length,
      perGearRunsPassed: perGearRuns.length,
      perGearRunsFailed: 0,
      timestepRunsFailed: 0,
    },
  }, null, 2));
} finally {
  await vite.close();
}
