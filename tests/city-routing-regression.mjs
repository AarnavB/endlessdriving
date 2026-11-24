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
const urbanPath = resolve(root, 'src/world/nyc/CityUrbanModel.ts');
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
const urbanTemp = resolve(root, 'src/world/nyc/.CityUrbanModel.regression.mjs');
const managerTemp = resolve(root, 'src/world/nyc/.NYCCityChunkManager.regression.mjs');
const trafficTemp = resolve(root, 'src/game/.TrafficSystem.regression.mjs');
let physics;
let manager;
let traffic;
try {
  await transpile(graphPath, graphTemp);
  await transpile(urbanPath, urbanTemp);
  await transpile(managerPath, managerTemp, [
    ["from './CityRoadGraph'", "from './.CityRoadGraph.regression.mjs'"],
    ["from './CityUrbanModel'", "from './.CityUrbanModel.regression.mjs'"],
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

  // Grade-separated road crossings must have distinct graph identities and
  // no implicit edge between the coincident horizontal coordinates.
  const interchange = graph.getInterchangeDescriptor();
  const groundCrossingId = graph.getIntersectionId(0, 2);
  const deckCrossing = graph.getIntersection(interchange.deckCrossingNodeId);
  const groundCrossing = graph.getIntersection(groundCrossingId);
  assert.equal(groundCrossing.level, 0, 'surface crossing remains on the ground level');
  assert.equal(deckCrossing.level, 1, 'expressway crossing uses its own graph level');
  assert.equal(deckCrossing.position.x, groundCrossing.position.x,
    'the elevated and ground nodes occupy the same X coordinate');
  assert.equal(deckCrossing.position.z, groundCrossing.position.z,
    'the elevated and ground nodes occupy the same Z coordinate');
  assert(deckCrossing.position.y > groundCrossing.position.y + 6,
    'the highway deck has genuine vertical clearance above the street');
  const nearestDeckPose = graph.getNearestLanePose(
    0, 320, 1, 0, city.CITY_HIGHWAY_ELEVATION_M,
  );
  assert(Math.abs(nearestDeckPose.position.y - city.CITY_HIGHWAY_ELEVATION_M) < 1e-6,
    'nearest-lane sampling selects the elevated deck when the query Y is on the highway');
  const nearestGroundPose = graph.getNearestLanePose(0, 320, 1, 0, 0);
  assert(Math.abs(nearestGroundPose.position.y) < 1e-6,
    'nearest-lane sampling remains on the surface street when the query Y is at ground level');
  assert.notEqual(deckCrossing.id, groundCrossing.id,
    'coincident roads at different levels have distinct node identities');
  assert(graph.getOutgoingEdges(groundCrossingId)
    .every((edge) => edge.toNodeId !== deckCrossing.id),
  'grade-separated roads are not connected by horizontal proximity');
  assert.throws(() => graph.getEdgeFromTo(groundCrossingId, deckCrossing.id),
    /Grid segments are ground-level only/,
    'a level change is rejected unless represented by an explicit ramp edge');

  const rampMidId = graph.getIntersectionId(-2, 2, 1);
  const rampStart = graph.getEdgeFromTo(interchange.groundEntryNodeId, rampMidId);
  const rampFinish = graph.getEdgeFromTo(rampMidId, graph.getIntersectionId(-1, 2, 1));
  const firstRampSegment = graph.getSegment(rampStart.segmentId);
  const secondRampSegment = graph.getSegment(rampFinish.segmentId);
  assert.equal(firstRampSegment.roadType, 'entrance-ramp', 'the ground-to-deck connector is typed as an entrance ramp');
  assert.equal(firstRampSegment.level, 1, 'ramp carries its explicit road layer');
  const firstEndPose = graph.getCenterlinePose(firstRampSegment.id, firstRampSegment.lengthM);
  const secondStartPose = graph.getCenterlinePose(secondRampSegment.id, 0);
  assert(Math.hypot(
    firstEndPose.position.x - secondStartPose.position.x,
    firstEndPose.position.y - secondStartPose.position.y,
    firstEndPose.position.z - secondStartPose.position.z,
  ) < 1e-7, 'consecutive entrance-ramp segments meet without an elevation or position jump');
  const tangentDot = firstEndPose.tangent.x * secondStartPose.tangent.x
    + firstEndPose.tangent.y * secondStartPose.tangent.y
    + firstEndPose.tangent.z * secondStartPose.tangent.z;
  assert(tangentDot > 0.999, 'ramp segment boundaries preserve a continuous forward tangent');

  for (const segmentId of [...interchange.entryRampSegmentIds, ...interchange.exitRampSegmentIds]) {
    const segment = graph.getSegment(segmentId);
    const fromNode = graph.getIntersection(segment.fromNodeId);
    const toNode = graph.getIntersection(segment.toNodeId);
    const startPose = graph.getCenterlinePose(segmentId, 0).position;
    const endPose = graph.getCenterlinePose(segmentId, segment.lengthM).position;
    assert(Math.hypot(startPose.x - fromNode.position.x, startPose.y - fromNode.position.y,
      startPose.z - fromNode.position.z) < 1e-5,
    'ramp ' + segmentId + ' starts at its declared graph node');
    assert(Math.hypot(endPose.x - toNode.position.x, endPose.y - toNode.position.y,
      endPose.z - toNode.position.z) < 1e-5,
    'ramp ' + segmentId + ' terminates at its declared graph node');
    assert(segment.profile.widthM > 0, 'ramp ' + segmentId + ' has a valid drivable width');
    let maximumObservedGradient = 0;
    let previous = graph.getCenterlinePose(segmentId, 0).position;
    for (let sample = 1; sample <= 48; sample++) {
      const distance = segment.lengthM * sample / 48;
      const currentPose = graph.getCenterlinePose(segmentId, distance).position;
      const horizontalRun = Math.hypot(
        currentPose.x - previous.x,
        currentPose.z - previous.z,
      );
      const grade = Math.abs(currentPose.y - previous.y) / Math.max(1e-6, horizontalRun);
      maximumObservedGradient = Math.max(maximumObservedGradient, grade);
      previous = currentPose;
    }
    assert(maximumObservedGradient <= segment.maxGradient + 0.002,
      'ramp ' + segmentId + ' respects its declared maximum gradient');
  }

  const routeOntoHighway = graph.findRoute(
    interchange.groundEntryNodeId, interchange.deckCrossingNodeId,
  );
  assert(routeOntoHighway.some((edge) => graph.getSegment(edge.segmentId).roadType === 'entrance-ramp'),
    'the road graph routes from surface streets onto the elevated expressway');
  const routeOffHighway = graph.findRoute(
    interchange.deckCrossingNodeId, interchange.groundExitNodeId,
  );
  assert(routeOffHighway.some((edge) => graph.getSegment(edge.segmentId).roadType === 'exit-ramp'),
    'the road graph routes from the expressway down to surface streets');
  const routeBackDown = graph.findRoute(
    interchange.deckCrossingNodeId, interchange.groundEntryNodeId,
  );
  assert(routeBackDown.some((edge) => edge.direction < 0
    && graph.getSegment(edge.segmentId).roadType === 'entrance-ramp'),
  'bidirectional ramp connectivity supports the reverse route');
  const routeBackOntoDeck = graph.findRoute(
    interchange.groundExitNodeId, interchange.deckCrossingNodeId,
  );
  assert(routeBackOntoDeck.some((edge) => edge.direction < 0
    && graph.getSegment(edge.segmentId).roadType === 'exit-ramp'),
  'the exit ramp is connected and traversable in reverse as well');

  // A remote chunk deterministically materialises the same elevated corridor
  // and a second ramp pair; multi-level generation is not limited to the
  // representative interchange around the origin.
  const remoteSegments = graph.getSpecialSegmentsInBounds(1024, 1792, 290, 380);
  assert(remoteSegments.some((segment) => segment.roadType === 'elevated-highway'),
    'distant streamed chunks generate continuous elevated expressway segments');
  assert(remoteSegments.some((segment) => segment.id === 'nyc:ramp:8:lower')
    && remoteSegments.some((segment) => segment.id === 'nyc:ramp:8:climb')
    && remoteSegments.some((segment) => segment.id === 'nyc:ramp:8:merge'),
    'distant chunks generate a deterministic, connected procedural ramp pair');
  const remoteGroundNode = graph.getIntersectionId(8, 2);
  const remoteDeckNode = graph.getIntersectionId(11, 2, 1);
  const remoteRampRoute = graph.findRoute(remoteGroundNode, remoteDeckNode);
  assert(remoteRampRoute.some((edge) => graph.getSegment(edge.segmentId).roadType === 'entrance-ramp')
    && remoteRampRoute.some((edge) => graph.getSegment(edge.segmentId).roadType === 'exit-ramp'),
    'a second interchange connects ground traffic onto the remote elevated corridor');
  const remoteRamp = graph.getSegment('nyc:ramp:8:climb');
  let remoteMaximumGrade = 0;
  let remotePrevious = graph.getCenterlinePose(remoteRamp.id, 0).position;
  for (let sample = 1; sample <= 32; sample++) {
    const currentPosition = graph.getCenterlinePose(remoteRamp.id, remoteRamp.lengthM * sample / 32).position;
    const run = Math.hypot(currentPosition.x - remotePrevious.x, currentPosition.z - remotePrevious.z);
    remoteMaximumGrade = Math.max(remoteMaximumGrade,
      Math.abs(currentPosition.y - remotePrevious.y) / Math.max(1e-6, run));
    remotePrevious = currentPosition;
  }
  assert(remoteMaximumGrade <= remoteRamp.maxGradient + 0.002,
    'procedurally generated remote ramps respect the configured grade limit');

  const underpassSegments = graph.getUnderpassSegments();
  assert(underpassSegments.length >= 1, 'the interchange includes graph-backed underpass segments');
  assert(underpassSegments.every((segment) => segment.roadType === 'underpass' && segment.level === 0),
    'underpass streets remain on their own ground-level road surface');
  assert.equal(deckCrossing.signalControlled, false,
    'the elevated deck crossing does not create an independent traffic signal');
  const deckIncoming = graph.getEdgeFromTo(
    graph.getIntersectionId(-1, 2, 1), interchange.deckCrossingNodeId,
  );
  const deckOutgoing = graph.getOutgoingEdges(interchange.deckCrossingNodeId)
    .find((edge) => edge.toNodeId !== deckIncoming.fromNodeId);
  assert(deckOutgoing, 'the elevated deck has a valid onward connection');
  const gradeSignals = new city.CityTrafficController(graph);
  assert.equal(gradeSignals.canEnterMovement(interchange.deckCrossingNodeId, deckIncoming, deckOutgoing),
    true, 'grade-separated highway movement bypasses unrelated ground-level signal phases');
  assert.equal(gradeSignals.getSignalState(interchange.deckCrossingNodeId, 'x'),
    'green', 'an uncontrolled elevated node does not cycle a ground-level signal');
  
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
    assert.equal(signals.getProtectedLeftTurnState(signalNode, 'z', 1),
      northPermission ? 'green' : 'red', 'north left-turn arrow tracks its protected approach phase');
    assert.equal(signals.getProtectedLeftTurnState(signalNode, 'z', -1),
      southPermission ? 'green' : 'red', 'south left-turn arrow tracks its protected approach phase');
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
  const vehicleSource = await readFile(resolve(root, 'src/vehicles/VehicleController.ts'), 'utf8');
  assert(!/RoadPath|RoadChunkManager/.test(gameSource), 'Game.ts no longer depends on the scalar highway system');
  assert(/new CityRoadGraph/.test(gameSource), 'Game owns the deterministic city road graph');
  assert(/new NYCCityChunkManager\(this\.scene, this\.physics, this\.roadGraph\)/.test(gameSource),
    'game initialization streams world geometry from the graph');
  assert(/new TrafficSystem\(this\.physics, this\.scene, this\.roadGraph, spawnPosition\)/.test(gameSource),
    'traffic uses the same authoritative graph');
  assert(/CityTrafficController/.test(trafficSource) && /getLanePose/.test(trafficSource),
    'traffic routes by edge and lane rather than scalar road distance');
  assert(/createSignalAssembly/.test(trafficSource) && /getProtectedLeftTurnState/.test(trafficSource),
    'rendered signal heads and protected arrows are connected to live traffic phases');
  assert(/setNextKinematicTranslation/.test(trafficSource) && /setNextKinematicRotation/.test(trafficSource),
    'AI transforms are submitted through Rapier kinematic bodies');
  assert(/getPoseRotation/.test(trafficSource)
    && /makeBasis\(/.test(trafficSource)
    && /pose\.tangent/.test(trafficSource),
    'AI vehicle orientation follows the full 3D road tangent frame rather than yaw alone');
  assert(/transitionFrom: CityLanePose \| null/.test(trafficSource)
    && /blendVector/.test(trafficSource)
    && /const tangent = normalizeVector/.test(trafficSource)
    && /const up = normalizeVector\(cross\(tangent, right\)\)/.test(trafficSource),
    'AI road transitions blend 3D position and an orthonormal tangent frame without yaw-only snaps');
  assert(/enabledRotations\(false, true, false\)/.test(vehicleSource)
    && /setRoadTangent\(tangent: THREE\.Vector3\)/.test(vehicleSource)
    && /this\.targetRoadPitch = pitch/.test(vehicleSource)
    && /this\.appliedRoadPitch = THREE\.MathUtils\.damp/.test(vehicleSource)
    && /setRoadTangent\(this\.getRoadHeadingAt\(playerPosition\)\)/.test(gameSource)
    && /roadPitchSampleTicks\+\+ % 6 === 0/.test(gameSource),
    'player road-grade pitch follows the sampled 3D graph while physics-driven roll and pitch remain locked');
  assert(/preferred\.z, globalPosition\.y/.test(gameSource)
    || /preferred\.z,\s*globalPosition\.y/.test(gameSource),
    'vehicle recovery chooses the nearest road using current elevation as well as X/Z');
  assert(/getSpecialSegmentsInBounds/.test(managerSource)
    && /elevated-highways-and-ramps/.test(managerSource)
    && /bridge-deck-undersides/.test(managerSource),
    'chunk rendering builds graph-derived elevated road decks and visible soffits');
  assert(/sampleTerrainHeight/.test(managerSource)
    && /terrain-heightfield/.test(managerSource)
    && /groundGeometry\) this\.addTrimeshCollider/.test(managerSource),
    'block topography is deterministic and the rendered heightfield has matching Rapier collision');
  assert(/elevatedRoadGeometry\) this\.addTrimeshCollider/.test(managerSource)
    && /elevatedUndersideGeometry\) this\.addTrimeshCollider/.test(managerSource)
    && /addUnderpassColliders\(body/.test(managerSource),
    'elevated decks, soffits and underpass structures receive matching Rapier colliders');
  assert(/for \(const barrier of barrierSpecs\)/.test(managerSource)
    && /setRotation\(\{ x: rotation\.x, y: rotation\.y, z: rotation\.z, w: rotation\.w \}\)/.test(managerSource),
    'bridge and ramp guardrails have matching rotated collision shapes');
  assert(/underpass-west-retaining-wall-' \+ section/.test(managerSource)
    && /'north', 294, 28/.test(managerSource)
    && /'south', 346, 28/.test(managerSource)
    && /wallCentreZ of \[294, 346\]/.test(managerSource),
    'underpass retaining walls leave the transverse at-grade crossing clear');
  assert(/rightOfWaySegments/.test(managerSource)
    && /intersectsElevatedRightOfWay/.test(managerSource),
    'procedural building placement reserves clear footprints for elevated roads and ramps');
  assert(/isAabbClearOfRoadNetwork/.test(managerSource)
    && /propPlacementIndex/.test(managerSource)
    && /graph-aligned-streetlight-poles/.test(managerSource),
    'environment placement is footprint-aware and aligned to authoritative street geometry');
  assert(/buildingColliders/.test(managerSource)
    && /buildingColliders !== buildingSpecs\.length/.test(managerSource),
    'each streamed building is required to receive a matching static collider');
  assert(/removeRigidBody\(chunk\.body\)/.test(managerSource) && /geometry\.dispose\(\)/.test(managerSource),
    'chunk disposal releases colliders and chunk geometry');
  assert(/this\.originOffset\.add\(delta\)/.test(managerSource),
    'chunk coordinates preserve their global origin during rebasing');
  assert(/street-level-retail-glazing/.test(managerSource)
    && /street-level-retail-frames/.test(managerSource)
    && /street-level-retail-sign-bands/.test(managerSource),
    'generated block facades include instanced shopfront glazing, frames and retail sign bands');
  assert(/arrow\.rotation\.z = Math\.PI/.test(trafficSource),
    'protected arrows are oriented left in the rendered signal face');
  assert(/new THREE\.Sprite\(approach\.lamps\.redGlow\)/.test(trafficSource),
    'signal heads render camera-facing radial glow sprites over the red lens');
  assert(/THREE\.AdditiveBlending/.test(trafficSource) && /toneMapped: false/.test(trafficSource),
    'signal halo uses additive, un-tonemapped materials rather than relying on exposure alone');
  assert(/signalGlowTexture\.dispose\(\)/.test(trafficSource),
    'shared signal glow texture is released with traffic infrastructure');

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
  assert.equal(initialChunks.buildingColliders, initialChunks.buildings,
    'all streamed visible building footprints have registered Rapier colliders');
  assert(initialChunks.environmentObjects > 0,
    'validated street and park objects register matching static support colliders');
  const terrainChunk = scene.children.find((object) => object.name.startsWith('fictional-city-chunk-'));
  const terrainMesh = terrainChunk?.getObjectByName('terrain-heightfield');
  assert(terrainMesh instanceof THREE.Mesh, 'streamed city chunk includes its terrain heightfield mesh');
  assert(terrainMesh.geometry.getAttribute('color')?.count > 1000,
    'terrain heightfield carries lightweight spatial surface colour variation');
  assert(terrainMesh.geometry.getAttribute('normal')?.count === terrainMesh.geometry.getAttribute('position')?.count,
    'terrain normals are sampled consistently at chunk boundaries');
  const roadMesh = terrainChunk?.getObjectByName('asphalt-road-network');
  assert(roadMesh instanceof THREE.Mesh, 'streamed chunk exposes the road surface mesh');
  const roadMaterial = Array.isArray(roadMesh.material) ? roadMesh.material[0] : roadMesh.material;
  assert(roadMaterial instanceof THREE.MeshStandardMaterial,
    'road surface uses a physically based standard material');
  assert(roadMaterial.map instanceof THREE.DataTexture
    && roadMaterial.normalMap instanceof THREE.DataTexture
    && roadMaterial.roughnessMap instanceof THREE.DataTexture,
    'asphalt uses shared procedural albedo, normal and roughness maps');
  assert(roadMesh.geometry.getAttribute('uv')?.count === roadMesh.geometry.getAttribute('position')?.count,
    'road mesh has world-aligned UVs for continuous texture tiling');
  assert(roadMaterial.roughness > 0.9 && roadMaterial.metalness === 0,
    'asphalt PBR response remains dielectric and highly rough');
  const terrainPositions = terrainMesh.geometry.getAttribute('position');
  let minimumTerrainY = Infinity;
  let maximumTerrainY = -Infinity;
  for (let vertex = 0; vertex < terrainPositions.count; vertex++) {
    minimumTerrainY = Math.min(minimumTerrainY, terrainPositions.getY(vertex));
    maximumTerrainY = Math.max(maximumTerrainY, terrainPositions.getY(vertex));
  }
  assert(maximumTerrainY - minimumTerrainY > 0.35,
    'terrain has coherent elevation variation instead of a flat ground plane');
  const terrainBlockX = Math.floor(terrainChunk.position.x / city.CITY_BLOCK_SPACING_M)
    * city.CITY_BLOCK_SPACING_M + city.CITY_BLOCK_SPACING_M * 0.5;
  const terrainBlockZ = Math.floor(terrainChunk.position.z / city.CITY_BLOCK_SPACING_M)
    * city.CITY_BLOCK_SPACING_M + city.CITY_BLOCK_SPACING_M * 0.5;
  const terrainProbeY = manager.sampleTerrainHeight(terrainBlockX, terrainBlockZ);
  const streetDatumY = manager.sampleTerrainHeight(
    Math.round(terrainBlockX / city.CITY_BLOCK_SPACING_M) * city.CITY_BLOCK_SPACING_M,
    terrainBlockZ,
  );
  assert(Math.abs(streetDatumY + 0.405) < 1e-5,
    'terrain blends smoothly back to the established ground-road datum');
  physics.step();
  const terrainHit = physics.castRay(
    new RAPIER.Ray({ x: terrainBlockX, y: terrainProbeY + 8, z: terrainBlockZ }, { x: 0, y: -1, z: 0 }),
    16, true,
  );
  assert(terrainHit && Math.abs(terrainHit.timeOfImpact - 8) < 0.25,
    'Rapier raycast contacts the same generated terrain elevation used by the visible mesh');

  // The remote ramp has a right-of-way through the procedural block plan.
  // The manager's private method is TypeScript-private (not a JS # member),
  // allowing a direct deterministic assertion without mutating the scene.
  const remoteRampBuildings = manager.collectBuildings(1280, 1792, 0, 512);
  const remoteRampSegments = graph.getSpecialSegmentsInBounds(1200, 1872, 280, 440)
    .filter((segment) => segment.id.startsWith('nyc:ramp:8:'));
  assert(remoteRampSegments.length >= 3, 'remote interchange has all three ramp curve segments');
  for (const building of remoteRampBuildings) {
    for (const segment of remoteRampSegments) {
      const points = [segment.start, segment.end, ...(segment.controlPoints ?? [])];
      const margin = segment.profile.widthM * 0.5 + 1;
      const roadMinX = Math.min(...points.map((point) => point.x)) - margin;
      const roadMaxX = Math.max(...points.map((point) => point.x)) + margin;
      const roadMinZ = Math.min(...points.map((point) => point.z)) - margin;
      const roadMaxZ = Math.max(...points.map((point) => point.z)) + margin;
      const buildingMinX = building.x - building.width * 0.5;
      const buildingMaxX = building.x + building.width * 0.5;
      const buildingMinZ = building.z - building.depth * 0.5;
      const buildingMaxZ = building.z + building.depth * 0.5;
      assert(!(roadMaxX >= buildingMinX && roadMinX <= buildingMaxX
        && roadMaxZ >= buildingMinZ && roadMinZ <= buildingMaxZ),
      'procedural buildings do not occupy the remote ramp swept footprint');
    }
  }

  // Rapier refreshes its broadphase/query pipeline during a world step.
  // Step once after static chunk colliders are created before issuing rays.
  physics.step();
  // Verify the same generated deck mesh supports highway traffic while a
  // second ray beginning below the soffit can still reach the ground street.
  const deckHit = physics.castRay(
    new RAPIER.Ray({ x: 100, y: 12, z: 320 }, { x: 0, y: -1, z: 0 }),
    20, true,
  );
  assert(deckHit && Math.abs(deckHit.timeOfImpact - 4.8) < 0.45,
    'elevated road collider presents the deck surface at its rendered elevation');
  const underDeckHit = physics.castRay(
    new RAPIER.Ray({ x: 100, y: 4, z: 320 }, { x: 0, y: -1, z: 0 }),
    8, true,
  );
  assert(underDeckHit && underDeckHit.timeOfImpact > 3.5 && underDeckHit.timeOfImpact < 4.5,
    'a ground-level ray beneath the deck reaches the street without hitting the soffit');
  const spawnChunk = scene.children.find((object) => object.name.startsWith('fictional-city-chunk-'));
  assert(spawnChunk?.getObjectByName('street-level-retail-glazing'),
    'spawn chunk creates visible instanced ground-floor storefront glazing');
  assert(spawnChunk?.getObjectByName('street-level-retail-sign-bands'),
    'spawn chunk creates visible ground-floor retail sign fasciae');

  traffic = new TrafficSystem(physics, scene, graph, playerPosition);
  assert.equal(traffic.getDiagnostics().activeVehicles, 10, 'graph traffic creates its bounded vehicle pool');
  const signalGroups = scene.children.filter((object) => object.name.startsWith('traffic-signals-'));
  assert.equal(signalGroups.length, 9,
    'traffic system renders signal assemblies at the bounded nearby intersection set');
  const signalSprites = [];
  for (const signalGroup of signalGroups) {
    signalGroup.traverse((object) => {
      if (object instanceof THREE.Sprite) signalSprites.push(object);
    });
  }
  assert(signalSprites.length >= 9 * 12,
    'each streamed signal assembly has three luminous lens halos per approach head');
  const glowMaterials = signalSprites.map((sprite) => sprite.material);
  assert(glowMaterials.every((material) => material instanceof THREE.SpriteMaterial
    && material.map && material.blending === THREE.AdditiveBlending),
  'signal glow sprites use shared radial textures and additive blending');
  assert(glowMaterials.some((material) => material.opacity > 0),
    'controller state activates at least one visible signal-lens halo');

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
  const signalGroup = scene.children.find((object) => object.name.startsWith('traffic-signals-'));
  assert(signalGroup, 'traffic signal scene group is available for rebase validation');
  const beforeSignalX = signalGroup.position.x;
  const rebaseDelta = new THREE.Vector3(128, 0, 0);
  manager.rebase(rebaseDelta);
  traffic.rebase(rebaseDelta);
  assert(Math.abs(chunkGroup.position.x - (beforeRebaseX - 128)) < 1e-8,
    'streamed chunk meshes shift by the exact rebase delta');
  assert(Math.abs(signalGroup.position.x - (beforeSignalX - 128)) < 1e-8,
    'traffic signal models shift by the exact rebase delta');

  playerPosition.x += 600;
  manager.update(playerPosition);
  traffic.update(1 / 60, playerPosition);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(manager.getDiagnostics().activeChunks <= 9,
    'chunk streaming unloads distant chunks and maintains a bounded active set');
  assert.equal(scene.children.filter((object) => object.name.startsWith('traffic-signals-')).length, 9,
    'signal streaming rebuilds a bounded visible intersection set around the player');

  traffic.dispose();
  manager.dispose();
  assert.equal(manager.getDiagnostics().activeChunks, 0, 'world disposal clears active chunks');
  assert.equal(traffic.getDiagnostics().activeVehicles, 0, 'traffic disposal clears pooled vehicles');
  assert.equal(scene.children.filter((object) => object.name.startsWith('fictional-city-chunk-')).length, 0,
    'world disposal removes streamed scene objects');
  assert.equal(scene.children.filter((object) => object.name.startsWith('traffic-signals-')).length, 0,
    'traffic disposal removes signal meshes and their scene objects');
  const remainingSignalSprites = [];
  for (const object of scene.children) {
    object.traverse((child) => {
      if (child instanceof THREE.Sprite) remainingSignalSprites.push(child);
    });
  }
  assert.equal(remainingSignalSprites.length, 0,
    'traffic disposal removes all signal glow sprites from the scene');

  console.log(JSON.stringify({
    suite: 'city graph, streaming, traffic and Rapier integration regression',
    graphRouteEdges: route.length,
    signalPhases: [...phases],
    runtimeChunksLoaded: initialChunks.activeChunks,
    trafficPool: 10,
    headlessPhysicsFrames: 120,
    assertions: 75,
    result: 'PASS',
  }, null, 2));
} finally {
  traffic?.dispose();
  manager?.dispose();
  if (physics) physics.free();
  await Promise.all([
    rm(graphTemp, { force: true }),
    rm(urbanTemp, { force: true }),
    rm(managerTemp, { force: true }),
    rm(trafficTemp, { force: true }),
  ]);
}
