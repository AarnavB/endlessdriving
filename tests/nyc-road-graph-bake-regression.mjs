import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const path = new URL('../public/data/nyc/nyc-street-network.json', import.meta.url);
const networkBytes = await readFile(path);
const network = JSON.parse(networkBytes.toString('utf8'));
const manifestPath = new URL('../public/data/nyc/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.schema, network.schema);
assert.equal(manifest.schemaVersion, network.schemaVersion);
assert.equal(manifest.generatedAt, network.generatedAt);
assert.deepEqual(manifest.bounds, network.bounds);
assert.equal(manifest.counts.sourceFeatures, network.counts.sourceFeatures);
assert.equal(manifest.counts.retainedFeatures, network.counts.retainedFeatures);
assert.equal(manifest.files.streetNetwork, 'nyc-street-network.json');
assert.deepEqual(
  Object.fromEntries(network.boroughCoverage.map((entry) => [entry.borough, entry.covered])),
  { 'Manhattan': true, 'The Bronx': true, 'Brooklyn': true, 'Queens': true, 'Staten Island': true },
  'five-borough coverage must be measured from baked source geometry, not inferred from the query envelope',
);
assert.equal(manifest.files.bytes, networkBytes.byteLength,
  'manifest byte count must match the exact baked file on disk');
assert.equal(manifest.files.sha256, createHash('sha256').update(networkBytes).digest('hex'),
  'manifest SHA-256 must cover the exact baked file bytes, including its final newline');
const graph = network.graph;
assert.equal(network.schema, 'endless-driving.nyc-street-network');
assert.equal(network.schemaVersion, 3);
assert.equal(graph.schemaVersion, 1);
assert.equal(graph.topologySource, 'NYC CSCL source line-feature endpoints with same-level planar intersection noding');
assert(graph.diagnostics.intersectionNoding.sameLevelEndpointInteriorCount > 0);
assert(graph.diagnostics.intersectionNoding.sameLevelInteriorInteriorCount > 0);
assert(Array.isArray(graph.nodes) && graph.nodes.length > 0);
assert(Array.isArray(graph.edges) && graph.edges.length > 0);
assert.equal(graph.diagnostics.nodeCount, graph.nodes.length);
assert.equal(graph.diagnostics.edgeCount, graph.edges.length);
assert.equal(graph.edges.length, network.features.reduce((total, feature) => total + feature.paths.length, 0));
assert(graph.diagnostics.largestComponentShare > 0.9,
  'the largest connected street component must contain more than 90% of graph nodes');
assert.equal(graph.diagnostics.isolatedNodeCount, 0);
const unknownDirectionEdges = graph.edges.filter((edge) =>
  !Array.isArray(edge.allowedDirections) || edge.allowedDirections.length === 0);
const drivableGraphEdges = graph.edges.filter((edge) =>
  Array.isArray(edge.allowedDirections) && edge.allowedDirections.length > 0);
assert.equal(graph.diagnostics.unknownDirectionEdgeCount, unknownDirectionEdges.length,
  'unknown-direction diagnostics must match the actual audit-edge records');
assert.equal(
  graph.diagnostics.oneWayEdgeCount + graph.diagnostics.twoWayEdgeCount,
  drivableGraphEdges.length,
  'one-way and two-way counts must cover every and only directionally drivable edge',
);
assert.equal(manifest.graph.drivableEdgeCount, drivableGraphEdges.length,
  'the runtime drivable-edge count must exclude all unknown-direction audit records');
assert.equal(
  graph.diagnostics.oneWayEdgeCount + graph.diagnostics.twoWayEdgeCount
    + graph.diagnostics.unknownDirectionEdgeCount,
  graph.edges.length,
  'every audit edge must be classified as one-way, two-way, or non-drivable unknown direction',
);

const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const features = new Map(network.features.map((feature) => [String(feature.id), feature]));
assert.equal(nodes.size, graph.nodes.length, 'node IDs must be unique');
assert.equal(features.size, network.features.length, 'source feature IDs must be unique');
const edgeById = new Map();
for (const edge of graph.edges) {
  assert(!edgeById.has(edge.id), 'graph edge IDs must be unique');
  edgeById.set(edge.id, edge);
  assert(nodes.has(edge.fromNodeId), 'every edge must reference an existing from node');
  assert(nodes.has(edge.toNodeId), 'every edge must reference an existing to node');
  const feature = features.get(edge.geometryRef.featureId);
  assert(feature, 'every graph edge must reference a baked source feature');
  assert(feature.paths[edge.geometryRef.pathIndex], 'every graph edge must reference a baked geometry path');
  assert(edge.lengthM > 1, 'every retained graph edge must have a plausible positive length');
  assert(Number.isInteger(edge.fromLevelCode) && Number.isInteger(edge.toLevelCode),
    'grade codes must be retained at both segment endpoints');

  if (!Array.isArray(edge.allowedDirections) || edge.allowedDirections.length === 0) {
    assert.equal(edge.directionality, 'unknown',
      'an edge with no source traffic direction must remain explicitly non-drivable');
  } else {
    assert(edge.allowedDirections.every((direction) => direction === 'forward' || direction === 'reverse'),
      'runtime direction rules must contain only forward or reverse');
    assert(['forward', 'reverse', 'both'].includes(edge.directionality),
      'every drivable edge must have a known source direction');
    assert.equal(edge.directionality, edge.allowedDirections.length === 2
      ? 'both' : edge.allowedDirections[0],
    'directionality labels must agree with the allowed travel directions');
  }
}

// Inspect the actual spatial tile payloads. Unknown-direction CSCL audit edges may
// remain in the source graph for diagnostics, but none may enter a runtime tile.
const runtimeEdgeIds = new Set();
let runtimeTileEdgeRows = 0;
for (let offset = 0; offset < manifest.tiles.length; offset += 32) {
  const batch = manifest.tiles.slice(offset, offset + 32);
  const tileBytes = await Promise.all(batch.map((record) =>
    readFile(new URL('../public/data/nyc/' + record.path, import.meta.url))));
  for (let index = 0; index < batch.length; index++) {
    const record = batch[index];
    const bytes = tileBytes[index];
    assert.equal(bytes.byteLength, record.bytes, 'runtime road tile byte count: ' + record.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256,
      'runtime road tile SHA-256: ' + record.id);
    const tile = JSON.parse(bytes.toString('utf8'));
    assert.equal(tile.schema, 'endless-driving.nyc-street-tile');
    assert.equal(tile.schemaVersion, 1);
    assert.equal(tile.id, record.id);
    assert.equal(tile.graph.edges.length, record.edgeCount);
    for (const edge of tile.graph.edges) {
      runtimeTileEdgeRows++;
      runtimeEdgeIds.add(edge.id);
      const sourceEdge = edgeById.get(edge.id);
      assert(sourceEdge, 'every runtime tile edge must exist in the authoritative source graph');
      assert(Array.isArray(sourceEdge.allowedDirections) && sourceEdge.allowedDirections.length > 0,
        'unknown-direction audit edges must never be copied into runtime road tiles');
      assert.deepEqual(edge.allowedDirections, sourceEdge.allowedDirections,
        'runtime tile directionality must preserve the source graph rule');
      assert.equal(edge.directionality, sourceEdge.directionality,
        'runtime tile directionality label must preserve the source graph');
    }
  }
}
for (const edge of graph.edges) {
  if (!Array.isArray(edge.allowedDirections) || edge.allowedDirections.length === 0) {
    assert(!runtimeEdgeIds.has(edge.id),
      'unknown-direction edges must not be reachable from the runtime tile index');
  } else {
    assert(runtimeEdgeIds.has(edge.id),
      'every directionally drivable graph edge must appear in the runtime tile index');
  }
}
assert.equal(runtimeEdgeIds.size, manifest.graph.drivableEdgeCount,
  'unique runtime tile edge IDs must equal the manifest drivable edge count');
assert.equal(runtimeTileEdgeRows, manifest.tiles.reduce((total, tile) => total + tile.edgeCount, 0),
  'runtime tile edge row count must match the tile manifest');

for (const node of graph.nodes) {
  for (const edgeId of node.outgoingEdgeIds) assert(edgeById.has(edgeId));
  for (const edgeId of node.incomingEdgeIds) assert(edgeById.has(edgeId));
}

console.log(JSON.stringify({
  suite: 'live NYC CSCL directed endpoint graph validation',
  nodeCount: graph.diagnostics.nodeCount,
  edgeCount: graph.diagnostics.edgeCount,
  connectedComponentCount: graph.diagnostics.connectedComponentCount,
  largestComponentShare: graph.diagnostics.largestComponentShare,
  intersectionNoding: graph.diagnostics.intersectionNoding,
  oneWayEdgeCount: graph.diagnostics.oneWayEdgeCount,
  twoWayEdgeCount: graph.diagnostics.twoWayEdgeCount,
  unknownDirectionEdgeCount: graph.diagnostics.unknownDirectionEdgeCount,
  drivableEdgeCount: manifest.graph.drivableEdgeCount,
  runtimeTileEdgeCount: runtimeEdgeIds.size,
  runtimeTileEdgeRows,
  result: 'PASS',
}, null, 2));
