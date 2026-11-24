import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const graphPath = resolve(root, 'src/world/nyc/CityRoadGraph.ts');
const managerPath = resolve(root, 'src/world/nyc/NYCCityChunkManager.ts');
const trafficPath = resolve(root, 'src/game/TrafficSystem.ts');
const gamePath = resolve(root, 'src/game/Game.ts');

async function transpile(sourcePath, destinationPath, replacements = []) {
  let source = await readFile(sourcePath, 'utf8');
  for (const [from, to] of replacements) {
    assert(source.includes(from), 'transpile import anchor missing: ' + from);
    source = source.replace(from, to);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, 'TypeScript transpilation should not report diagnostics');
  await writeFile(destinationPath, output.outputText, 'utf8');
}

const graphTemp = resolve(root, 'src/world/nyc/.CityRoadGraph.regression.mjs');
const managerTemp = resolve(root, 'src/world/nyc/.NYCCityChunkManager.regression.mjs');
const trafficTemp = resolve(root, 'src/game/.TrafficSystem.regression.mjs');
let physics;
let manager;
let traffic;
try {
  await transpile(graphPath, graphTemp);
  await transpile(managerPath, managerTemp, [
    ["from './CityRoadGraph'", "from './.CityRoadGraph.regression.mjs'"],
  ]);
  await transpile(trafficPath, trafficTemp, [
    ["from '../world/nyc/CityRoadGraph'", "from '../world/nyc/.CityRoadGraph.regression.mjs'"],
  ]);

  const city = await import(pathToFileURL(graphTemp).href);
  const { NYCCityChunkManager } = await import(pathToFileURL(managerTemp).href);
  const { TrafficSystem } = await import(pathToFileURL(trafficTemp).href);
  const graph = new city.CityRoadGraph(20261124);

  const start = graph.getIntersectionId(0, 0);
  const finish = graph.getIntersectionId(5, 4);
  const route = graph.findRoute(start, finish);
  assert.equal(route.length, 9, 'Manhattan grid path length should equal the minimum number of blocks');
  assert.equal(route[0].fromNodeId, start, 'route starts at the requested intersection');
  assert.equal(route.at(-1).toNodeId, finish, 'route ends at the requested intersection');
  for (let index = 0; index < route.length; index++) {
    const edge = route[index];
    assert.equal(edge.fromNodeId, index === 0 ? start : route[index - 1].toNodeId,
      'adjacent route edges share their intersection');
    const segment = graph.getSegment(edge.segmentId);
    assert.equal(segment.lengthM, city.CITY_BLOCK_SPACING_M, 'segment length uses fixed block spacing');
    assert.equal(segment.axis === 'x' || segment.axis === 'z', true, 'segments remain orthogonal');
    assert.equal(segment.fromNodeId, edge.direction > 0 ? edge.fromNodeId : edge.toNodeId,
      'segment canonical direction resolves correctly');
  }
  assert.equal(new Set(route.map((edge) => graph.getSegment(edge.segmentId).axis)).size, 2,
    'route traverses avenues and connecting streets');

  const avenue = graph.getEdgeFromTo(graph.getIntersectionId(0, 0), graph.getIntersectionId(0, 1));
  const avenueProfile = graph.getSegment(avenue.segmentId).profile;
  assert.equal(avenueProfile.category, 'avenue', 'primary north-south line is an avenue');
  assert.equal(avenueProfile.lanesPerDirection, 3, 'avenues have three lanes per direction');
  const lanePoses = [0, 1, 2].map((lane) => graph.getLanePose(avenue, lane, 42));
  for (const pose of lanePoses) {
    assert(Math.abs(Math.hypot(pose.tangent.x, pose.tangent.z) - 1) < 1e-9,
      'lane tangent is a normalized horizontal direction');
    assert(Number.isFinite(pose.yaw), 'lane heading is finite');
    assert(Math.abs(pose.position.x) <= avenueProfile.widthM * 0.5,
      'lane center lies within road boundaries');
  }
  assert(Math.abs(Math.abs(lanePoses[0].position.x - lanePoses[1].position.x)
    - avenueProfile.laneWidthM) < 1e-9, 'lane spacing matches the declared lane width');

  const forwardAlleyStart = graph.getIntersectionId(0, 5);
  const forwardAlleyEnd = graph.getIntersectionId(1, 5);
  assert.throws(() => graph.getEdgeFromTo(forwardAlleyStart, forwardAlleyEnd),
    /one-way/, 'one-way alley rejects the prohibited direction');
  const permittedAlley = graph.getEdgeFromTo(forwardAlleyEnd, forwardAlleyStart);
  assert.equal(permittedAlley.direction, -1, 'reverse-only alley retains its permitted direction');
  assert(graph.getOutgoingEdges(forwardAlleyStart).every((edge) => edge.toNodeId !== forwardAlleyEnd),
    'directed adjacency omits the prohibited alley edge');

  const turn = graph.chooseNextEdge(avenue.toNodeId, avenue.fromNodeId, 301);
  assert(turn, 'intersection has a valid outgoing turn');
  assert.equal(turn.fromNodeId, avenue.toNodeId, 'turn connects to current intersection');
  assert.notEqual(turn.toNodeId, avenue.fromNodeId, 'turn selection does not reverse immediately');

  const nearest = graph.getNearestLanePose(9, 50, 0, 1);
  assert(Math.abs(nearest.position.x - 8.5) < 1e-8, 'nearest-lane sampling returns an avenue lane center');

  const signals = new city.CityTrafficController(graph);
  const signalNode = graph.getIntersectionId(1, 2);
  const phases = new Set();
  for (let step = 0; step < 900; step++) {
    phases.add(signals.getSignalState(signalNode, 'x'));
    phases.add(signals.getSignalState(signalNode, 'z'));
    signals.advance(0.1);
  }
  assert(phases.has('green') && phases.has('yellow') && phases.has('red'),
    'internally simulated signals expose all three phases');
  assert.equal(signals.canEnterIntersection(signalNode, 'z'),
    signals.getSignalState(signalNode, 'z') === 'green',
    'only a protected green approach can enter');
  assert.equal(signals.canEnterIntersection(signalNode, 'x'),
    signals.getSignalState(signalNode, 'x') === 'green',
    'conflicting axis waits through red and yellow');
  const northApproach = graph.getEdgeFromTo(graph.getIntersectionId(1, 1), signalNode);
  const northLeft = graph.getEdgeFromTo(signalNode, graph.getIntersectionId(0, 2));
  const southApproach = graph.getEdgeFromTo(graph.getIntersectionId(1, 3), signalNode);
  const southLeft = graph.getEdgeFromTo(signalNode, graph.getIntersectionId(2, 2));
  let northLeftPhaseSeen = false;
  let southLeftPhaseSeen = false;
  for (let tick = 0; tick < 560; tick++) {
    const northPermission = signals.canEnterMovement(signalNode, northApproach, northLeft);
    const southPermission = signals.canEnterMovement(signalNode, southApproach, southLeft);
    assert(!(northPermission && southPermission),
      'opposing left-turn approaches never receive simultaneous protected permission');
    northLeftPhaseSeen ||= northPermission;
    southLeftPhaseSeen ||= southPermission;
    signals.advance(0.1);
  }
  assert(northLeftPhaseSeen && southLeftPhaseSeen,
    'both left-turn approaches receive separate protected phases');
  signals.enqueue(signalNode, 'traffic-a');
  signals.enqueue(signalNode, 'traffic-a');
  signals.enqueue(signalNode, 'traffic-b');
  assert.equal(signals.getQueueLength(signalNode), 2, 'vehicle queue membership is de-duplicated');
  signals.dequeue(signalNode, 'traffic-a');
  assert.equal(signals.getQueueLength(signalNode), 1, 'vehicle leaves queue after clearing approach');
  signals.reset();
  assert.equal(signals.getQueueLength(signalNode), 0, 'signal reset clears stale queues');
  assert.equal(signals.getElapsedSeconds(), 0, 'signal reset restores deterministic cycle phase');

  const worldOffset = { x: 512, y: 0, z: -256 };
  const globalPosition = { x: 742.5, y: 12, z: -316.25 };
  const localPosition = city.globalToLocalPosition(globalPosition, worldOffset);
  assert.deepEqual(city.localToGlobalPosition(localPosition, worldOffset), globalPosition,
    'local/global conversion survives world rebasing');

  const gameSource = await readFile(gamePath, 'utf8');
  const trafficSource = await readFile(trafficPath, 'utf8');
  const managerSource = await readFile(managerPath, 'utf8');
  assert(!/RoadPath|RoadChunkManager/.test(gameSource), 'Game.ts no longer depends on the scalar highway system');
  assert(/new CityRoadGraph/.test(gameSource), 'Game owns the deterministic city road graph');
  assert(/new NYCCityChunkManager\(this\.scene, this\.physics, this\.roadGraph\)/.test(gameSource),
    'game initialization streams world geometry from the graph');
  assert(/new TrafficSystem\(this\.physics, this\.scene, this\.roadGraph, spawnPosition\)/.test(gameSource),
    'traffic uses the same authoritative graph');
  assert(/CityTrafficController/.test(trafficSource) && /getLanePose/.test(trafficSource),
    'traffic routes by edge and lane rather than scalar road distance');
  assert(/setNextKinematicTranslation/.test(trafficSource) && /setNextKinematicRotation/.test(trafficSource),
    'AI transforms are submitted through Rapier kinematic bodies');
  assert(/removeRigidBody\(chunk\.body\)/.test(managerSource) && /geometry\.dispose\(\)/.test(managerSource),
    'chunk disposal releases colliders and chunk geometry');
  assert(/this\.originOffset\.add\(delta\)/.test(managerSource),
    'chunk coordinates preserve their global origin during rebasing');

  await RAPIER.init();
  physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.timestep = 1 / 60;
  const scene = new THREE.Scene();
  const spawnPose = graph.getSpawnPose();
  const playerPosition = new THREE.Vector3(
    spawnPose.position.x, spawnPose.position.y + 0.72, spawnPose.position.z,
  );
  manager = new NYCCityChunkManager(scene, physics, graph);
  await manager.initialize(playerPosition);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const initialChunks = manager.getDiagnostics();
  assert(initialChunks.activeChunks >= 1 && initialChunks.activeChunks <= 9,
    'chunk streamer loads the spawn chunk and remains within its bounded radius');

  traffic = new TrafficSystem(physics, scene, graph, playerPosition);
  assert.equal(traffic.getDiagnostics().activeVehicles, 10, 'graph traffic creates its bounded vehicle pool');

  const playerBody = physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(playerPosition.x, playerPosition.y, playerPosition.z)
    .setCanSleep(false)
    .enabledRotations(false, true, false));
  physics.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 0.3, 1.6)
    .setMass(1400).setFriction(0.72), playerBody);
  const initialY = playerBody.translation().y;
  for (let frame = 0; frame < 120; frame++) {
    traffic.update(1 / 60, playerPosition);
    physics.step();
    traffic.syncVisuals();
  }
  assert(Math.abs(playerBody.translation().y - initialY) < 0.8,
    'headless Rapier player body remains supported by generated street collision geometry');

  const chunkGroup = scene.children.find((object) => object.name.startsWith('fictional-city-chunk-'));
  assert(chunkGroup, 'streamed geometry is present in the Three.js scene');
  const beforeRebaseX = chunkGroup.position.x;
  const rebaseDelta = new THREE.Vector3(128, 0, 0);
  manager.rebase(rebaseDelta);
  traffic.rebase(rebaseDelta);
  assert(Math.abs(chunkGroup.position.x - (beforeRebaseX - 128)) < 1e-8,
    'streamed chunk meshes shift by the exact rebase delta');

  playerPosition.x += 600;
  manager.update(playerPosition);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(manager.getDiagnostics().activeChunks <= 9,
    'chunk streaming unloads distant chunks and maintains a bounded active set');

  traffic.dispose();
  manager.dispose();
  assert.equal(manager.getDiagnostics().activeChunks, 0, 'world disposal clears active chunks');
  assert.equal(traffic.getDiagnostics().activeVehicles, 0, 'traffic disposal clears pooled vehicles');
  assert.equal(scene.children.filter((object) => object.name.startsWith('fictional-city-chunk-')).length, 0,
    'world disposal removes streamed scene objects');

  console.log(JSON.stringify({
    suite: 'city graph, streaming, traffic and Rapier integration regression',
    graphRouteEdges: route.length,
    signalPhases: [...phases],
    runtimeChunksLoaded: initialChunks.activeChunks,
    trafficPool: 10,
    headlessPhysicsFrames: 120,
    assertions: 37,
    result: 'PASS',
  }, null, 2));
} finally {
  traffic?.dispose();
  manager?.dispose();
  if (physics) physics.free();
  await Promise.all([
    rm(graphTemp, { force: true }),
    rm(managerTemp, { force: true }),
    rm(trafficTemp, { force: true }),
  ]);
}
