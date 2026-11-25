import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = new URL('../public/data/nyc/manhattan-street-network.json', import.meta.url);
const network = JSON.parse(await readFile(path, 'utf8'));
const graph = network.graph;
assert.equal(network.schema, 'endless-driving.nyc-street-network');
assert.equal(network.schemaVersion, 3);
assert.equal(graph.schemaVersion, 1);
assert.equal(graph.topologySource, 'NYC CSCL PHYSICALID intersection-to-intersection centerlines');
assert(Array.isArray(graph.nodes) && graph.nodes.length > 0);
assert(Array.isArray(graph.edges) && graph.edges.length > 0);
assert.equal(graph.diagnostics.nodeCount, graph.nodes.length);
assert.equal(graph.diagnostics.edgeCount, graph.edges.length);
assert.equal(graph.edges.length, network.features.reduce((total, feature) => total + feature.paths.length, 0));
assert(graph.diagnostics.largestComponentShare > 0.9,
  'the largest connected street component must contain more than 90% of graph nodes');
assert.equal(graph.diagnostics.isolatedNodeCount, 0);
assert.equal(graph.diagnostics.unknownDirectionEdgeCount, 0,
  'every retained drivable centerline must have a known source traffic direction');
assert.equal(
  graph.diagnostics.oneWayEdgeCount + graph.diagnostics.twoWayEdgeCount,
  graph.edges.length,
  'all graph edges must carry a directed traffic rule',
);

const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const features = new Map(network.features.map((feature) => [String(feature.id), feature]));
assert.equal(nodes.size, graph.nodes.length, 'node IDs must be unique');
assert.equal(features.size, network.features.length, 'source feature IDs must be unique');
const edgeIds = new Set();
for (const edge of graph.edges) {
  assert(!edgeIds.has(edge.id), 'graph edge IDs must be unique');
  edgeIds.add(edge.id);
  assert(nodes.has(edge.fromNodeId), 'every edge must reference an existing from node');
  assert(nodes.has(edge.toNodeId), 'every edge must reference an existing to node');
  const feature = features.get(edge.geometryRef.featureId);
  assert(feature, 'every graph edge must reference a baked source feature');
  assert(feature.paths[edge.geometryRef.pathIndex], 'every graph edge must reference a baked geometry path');
  assert(['forward', 'reverse', 'both'].includes(edge.directionality),
    'every retained graph edge must have a usable source direction');
  assert(edge.lengthM > 1, 'every retained graph edge must have a plausible positive length');
  assert(Number.isInteger(edge.fromLevelCode) && Number.isInteger(edge.toLevelCode),
    'grade codes must be retained at both segment endpoints');
}
for (const node of graph.nodes) {
  for (const edgeId of node.outgoingEdgeIds) assert(edgeIds.has(edgeId));
  for (const edgeId of node.incomingEdgeIds) assert(edgeIds.has(edgeId));
}

console.log(JSON.stringify({
  suite: 'live NYC CSCL directed endpoint graph validation',
  nodeCount: graph.diagnostics.nodeCount,
  edgeCount: graph.diagnostics.edgeCount,
  connectedComponentCount: graph.diagnostics.connectedComponentCount,
  largestComponentShare: graph.diagnostics.largestComponentShare,
  oneWayEdgeCount: graph.diagnostics.oneWayEdgeCount,
  twoWayEdgeCount: graph.diagnostics.twoWayEdgeCount,
  result: 'PASS',
}, null, 2));
