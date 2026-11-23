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
          previousGear = telemetry.gear;
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
      }

      return {
        vehicle: definition.name,
        mode: manual ? 'manual' : 'automatic',
        maxSpeedKmh: Number(maxSpeedKmh.toFixed(1)),
        minimumSignedSpeedMps: Number(minSignedSpeed.toFixed(3)),
        highestGear: maxGear,
        gearTransitions,
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

      // Let residual speed settle and release the brake before deliberately
      // requesting reverse from a stationary state.
      for (let i = 0; i < 90; i++) {
        const { debug } = sim.step(NEUTRAL_INPUT);
        assert(debug.forwardSpeed >= -0.15, 'F40 reversed after all controls were released');
      }
      assert(
        Math.abs(sim.vehicle.getDebugTelemetry(NEUTRAL_INPUT, FIXED_DT, 1).forwardSpeed) <= 0.25,
        'F40 was not stationary before intentional reverse request',
      );

      // At standstill, holding S for the engagement interval is the existing
      // deliberate reverse command.
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

  function runSteeringRegression(definition) {
    const sim = createSimulation(definition, false, FIXED_DT);
    let maximumSpeedKmh = 0;
    try {
      for (let i = 0; i < 600; i++) {
        const { telemetry, debug } = sim.step({ ...FORWARD_INPUT, steer: 0.15 });
        maximumSpeedKmh = Math.max(maximumSpeedKmh, telemetry.speedKmh);
        assert(debug.forwardSpeed >= -0.4, 'F40 acquired reverse longitudinal speed while steering under throttle');
        assert(debug.appliedForwardForce >= -1e-6, 'Steering caused negative forward propulsion');
      }
      assert(maximumSpeedKmh >= 50, 'Steering test failed to pass through 50 km/h');
      return { maximumSpeedKmh: Number(maximumSpeedKmh.toFixed(1)), result: 'PASS' };
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
  const scenarioRuns = [runCoastBrakeAndReverse(defaultVehicle), runSteeringRegression(defaultVehicle)];

  const timestepRuns = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    const sim = createSimulation(defaultVehicle, false, dt);
    let minimumSignedSpeedMps = 0;
    let maximumSpeedKmh = 0;
    try {
      for (let i = 0; i < Math.ceil(12 / dt); i++) {
        const { telemetry, debug, residualUserForce } = sim.step(FORWARD_INPUT);
        minimumSignedSpeedMps = Math.min(minimumSignedSpeedMps, debug.forwardSpeed);
        maximumSpeedKmh = Math.max(maximumSpeedKmh, telemetry.speedKmh);
        assert(debug.forwardSpeed >= -0.15, `F40 reversed at timestep ${dt}`);
        assert(debug.appliedForwardForce >= -1e-6, `F40 produced negative propulsion at timestep ${dt}`);
        assert(residualUserForce < 1e-6, `F40 retained a persistent force at timestep ${dt}`);
      }
      timestepRuns.push({
        timestepSeconds: Number(dt.toFixed(6)),
        minimumSignedSpeedMps: Number(minimumSignedSpeedMps.toFixed(3)),
        maximumSpeedKmh: Number(maximumSpeedKmh.toFixed(1)),
        result: 'PASS',
      });
    } finally {
      sim.dispose();
    }
  }

  console.log(JSON.stringify({
    simulation: 'Rapier DynamicRayCastVehicleController with a flat static ground collider',
    fixedTimestepSeconds: FIXED_DT,
    vehicleRuns,
    scenarioRuns,
    timestepRuns,
    summary: {
      vehicleRunsPassed: vehicleRuns.length,
      vehicleRunsFailed: 0,
      scenarioRunsPassed: scenarioRuns.length,
      scenarioRunsFailed: 0,
      timestepRunsPassed: timestepRuns.length,
      timestepRunsFailed: 0,
    },
  }, null, 2));
} finally {
  await vite.close();
}
