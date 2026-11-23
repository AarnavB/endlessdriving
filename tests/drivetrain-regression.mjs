import assert from 'node:assert/strict';
import { createServer } from 'vite';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const fixedDt = 1 / 60;
const MAX_SIMULATION_SECONDS = 36;
const MAX_STEPS = Math.ceil(MAX_SIMULATION_SECONDS / fixedDt);
const INPUT = {
  throttle: 1,
  brake: 0,
  steer: 0,
  handbrake: false,
  shiftUpPressed: false,
  shiftDownPressed: false,
};

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

  function createSimulation(definition, manual = false, dt = fixedDt) {
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
        return {
          telemetry: vehicle.getTelemetry(),
          debug: vehicle.getDebugTelemetry(input, dt, 1),
        };
      },
      dispose() {
        vehicle.dispose(world, scene);
        world.free();
      },
    };
  }

  function runForwardAcceleration(definition, manual = false, dt = fixedDt) {
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
      for (let step = 0; step < Math.ceil(MAX_SIMULATION_SECONDS / dt); step++) {
        const input = {
          ...INPUT,
          shiftUpPressed: manual && upshiftNextTick,
        };
        upshiftNextTick = false;

        const { telemetry, debug } = sim.step(input);
        const rotation = sim.vehicle.body.rotation();
        const yaw = Math.atan2(
          2 * (rotation.w * rotation.y + rotation.x * rotation.z),
          1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
        );
        const angularVelocity = sim.vehicle.body.angvel();
        const wheelController = sim.vehicle.wheelController;
        const sample = {
          step,
          speedKmh: Number(telemetry.speedKmh.toFixed(2)),
          signedForwardMps: Number(debug.forwardSpeed.toFixed(3)),
          worldVelocity: [Number(debug.velocityX.toFixed(3)), Number(debug.velocityY.toFixed(3)), Number(debug.velocityZ.toFixed(3))],
          yawRadians: Number(yaw.toFixed(4)),
          yawRate: Number(angularVelocity.y.toFixed(4)),
          positionY: Number(debug.positionY.toFixed(3)),
          gear: telemetry.gear,
          rpm: Number(telemetry.rpm.toFixed(0)),
          appliedForwardForce: Number(debug.appliedForwardForce.toFixed(1)),
          wheelEngineForces: [0, 1, 2, 3].map(i => Number((wheelController.wheelEngineForce(i) ?? 0).toFixed(1))),
          wheelBrakes: [0, 1, 2, 3].map(i => Number((wheelController.wheelBrake(i) ?? 0).toFixed(3))),
          wheelContacts: [0, 1, 2, 3].map(i => wheelController.wheelIsInContact(i)),
          wheelForwardImpulses: [0, 1, 2, 3].map(i => Number((wheelController.wheelForwardImpulse(i) ?? 0).toFixed(4))),
          wheelSideImpulses: [0, 1, 2, 3].map(i => Number((wheelController.wheelSideImpulse(i) ?? 0).toFixed(4))),
          wheelContactNormals: [0, 1, 2, 3].map(i => {
            const v = wheelController.wheelContactNormal(i);
            return v ? [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))] : null;
          }),
          wheelAxles: [0, 1, 2, 3].map(i => {
            const v = wheelController.wheelAxleCs(i);
            return v ? [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))] : null;
          }),
        };
        recentSamples.push(sample);
        if (recentSamples.length > 10) recentSamples.shift();
        maxSpeedKmh = Math.max(maxSpeedKmh, telemetry.speedKmh);
        minSignedSpeed = Math.min(minSignedSpeed, debug.forwardSpeed);
        maxGear = Math.max(maxGear, telemetry.gear);

        if (telemetry.gear !== previousGear) {
          gearTransitions++;
          previousGear = telemetry.gear;
        }

        for (const threshold of [50, 60, 80, 100, 150]) {
          if (telemetry.speedKmh >= threshold) milestones.add(threshold);
        }

        // Manual mode uses a single edge-triggered upshift once the engine
        // reaches a safe fraction of redline. Automatic mode must shift itself.
        if (manual && telemetry.gear < definition.physics.gearRatios.length
          && telemetry.rpm >= maxRpm * 0.78) {
          upshiftNextTick = true;
        }

        assert.equal(debug.brake, 0, `${definition.name}: unexpected brake input`);
        assert(
          debug.appliedForwardForce >= -1e-6,
          `${definition.name} (${manual ? 'manual' : 'auto'}): negative forward drive force at step ${step}`,
        );
        assert(
          debug.forwardSpeed >= -0.4,
          `${definition.name} (${manual ? 'manual' : 'auto'}): W-only run acquired reverse longitudinal speed. Diagnostics: ${JSON.stringify(recentSamples)}`,
        );
      }

      assert(
        maxSpeedKmh >= 150,
        `${definition.name} (${manual ? 'manual' : 'auto'}): only reached ${maxSpeedKmh.toFixed(1)} km/h; expected to pass 150 km/h on a clear flat test surface`,
      );
      assert(
        milestones.size === 5,
        `${definition.name} (${manual ? 'manual' : 'auto'}): missed speed milestones ${[50, 60, 80, 100, 150].filter(x => !milestones.has(x)).join(', ')} km/h`,
      );
      if (!manual && maxSpeedKmh > 100) {
        assert(maxGear >= 2, `${definition.name}: automatic transmission did not upshift`);
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

  const results = [];
  for (const definition of VEHICLE_CATALOGUE) {
    results.push(runForwardAcceleration(definition, false));
    results.push(runForwardAcceleration(definition, true));
  }

  // Check the timestep invariant on the default vehicle with three fixed
  // Rapier timesteps. The same W-only direction guard applies at each rate.
  const defaultVehicle = VEHICLE_CATALOGUE[0];
  const timestepResults = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    const sim = createSimulation(defaultVehicle, false, dt);
    let minSignedSpeed = 0;
    try {
      for (let i = 0; i < Math.ceil(12 / dt); i++) {
        const { debug } = sim.step(INPUT);
        minSignedSpeed = Math.min(minSignedSpeed, debug.forwardSpeed);
        assert(
          debug.forwardSpeed >= -0.4,
          `F40 timestep ${dt.toFixed(5)} acquired reverse longitudinal speed ${debug.forwardSpeed.toFixed(3)} m/s`,
        );
        assert(debug.appliedForwardForce >= -1e-6, 'Forward drive force became negative');
      }
      timestepResults.push({
        timestepSeconds: Number(dt.toFixed(6)),
        minimumSignedSpeedMps: Number(minSignedSpeed.toFixed(3)),
        result: 'PASS',
      });
    } finally {
      sim.dispose();
    }
  }

  console.log(JSON.stringify({
    simulation: 'Rapier DynamicRayCastVehicleController on a flat static collider',
    fixedTimestepSeconds: fixedDt,
    vehicleRuns: results,
    timestepRuns: timestepResults,
    summary: {
      vehicleRunsPassed: results.length,
      vehicleRunsFailed: 0,
      timestepRunsPassed: timestepResults.length,
      timestepRunsFailed: 0,
    },
  }, null, 2));
} finally {
  await vite.close();
}
