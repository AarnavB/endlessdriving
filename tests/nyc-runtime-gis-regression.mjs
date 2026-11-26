import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('public/data/nyc');
const manifestBytes = await readFile(resolve(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const networkBytes = await readFile(resolve(root, 'manhattan-street-network.json'));
const network = JSON.parse(networkBytes.toString('utf8'));

assert.equal(manifest.schema, network.schema);
assert.equal(manifest.schemaVersion, network.schemaVersion);
assert.deepEqual(manifest.bounds, network.bounds);
assert.equal(manifest.files.bytes, networkBytes.byteLength);
assert.equal(manifest.files.sha256, createHash('sha256').update(networkBytes).digest('hex'));
assert.ok(manifest.tiles.length > 0);
assert.ok(manifest.tileSizeM > 0);
assert.ok(manifest.graph.drivableEdgeCount > 0);
assert.ok(Number.isFinite(manifest.spawnPosition.x) && Number.isFinite(manifest.spawnPosition.z));

const expected = new Map(network.graph.edges
  .filter((edge) => Array.isArray(edge.allowedDirections) && edge.allowedDirections.length > 0)
  .map((edge) => [edge.id, edge]));
const actual = new Map();
const nodePositions = new Map();
let tileEdgeRows = 0;

for (const record of manifest.tiles) {
  const bytes = await readFile(resolve(root, record.path));
  assert.equal(bytes.byteLength, record.bytes, 'tile bytes: ' + record.id);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, 'tile checksum: ' + record.id);
  const tile = JSON.parse(bytes.toString('utf8'));
  assert.equal(tile.schema, 'endless-driving.nyc-street-tile');
  assert.equal(tile.schemaVersion, 1);
  assert.equal(tile.id, record.id);
  assert.equal(tile.graph.nodes.length, record.nodeCount);
  assert.equal(tile.graph.edges.length, record.edgeCount);
  const inTile = new Map(tile.graph.nodes.map((node) => [node.id, node]));
  for (const node of tile.graph.nodes) {
    const old = nodePositions.get(node.id);
    if (old) assert.ok(Math.hypot(old.x-node.position.x,old.y-node.position.y,old.z-node.position.z)<0.02);
    else nodePositions.set(node.id,node.position);
  }
  for (const edge of tile.graph.edges) {
    tileEdgeRows++;
    assert.ok(inTile.has(edge.fromNodeId) && inTile.has(edge.toNodeId), 'tile has both graph endpoints');
    assert.ok(edge.geometry.length >= 2, 'source polyline preserved');
    const from = inTile.get(edge.fromNodeId).position;
    const to = inTile.get(edge.toNodeId).position;
    assert.ok(Math.hypot(edge.geometry[0].x-from.x,edge.geometry[0].z-from.z)<2);
    const last = edge.geometry.at(-1);
    assert.ok(Math.hypot(last.x-to.x,last.z-to.z)<2);
    assert.ok(edge.allowedDirections.length > 0, 'runtime graph never includes undirected unknown edges');
    const old = actual.get(edge.id);
    if (old) assert.deepEqual(old,edge,'cross-tile duplicate must preserve identical full geometry');
    else actual.set(edge.id,edge);
  }
}
assert.equal(actual.size, expected.size, 'tile union reconstructs all known-direction CSCL edges');
for (const [id, edge] of expected) assert.ok(actual.has(id), 'missing drivable edge ' + id);
assert.ok(tileEdgeRows >= actual.size, 'boundary-spanning edges may be repeated, never lost');
assert.equal(manifest.graph.drivableEdgeCount, expected.size);

const game = await readFile('src/game/Game.ts','utf8');
const graph = await readFile('src/world/nyc/NYCGISRoadGraph.ts','utf8');
const manager = await readFile('src/world/nyc/NYCCityChunkManager.ts','utf8');
const traffic = await readFile('src/game/TrafficSystem.ts','utf8');
assert.match(game,/loadInitialTiles/,'Game startup must load GIS data before game construction');
assert.match(game,/new NYCGISRoadGraph/,'live Game graph must be GIS-backed');
assert.doesNotMatch(game,/new CityRoadGraph\(20261124\)/,'procedural seed graph is not the runtime source');
assert.match(graph,/super\(20261126,false\)/,'GIS graph must not build the procedural interchange');
assert.match(graph,/getIntersectionId\(_x:number,_z:number/,'grid intersection lookup is disabled');
assert.match(manager,/loadTilesForBounds/,'world streaming requests GIS tiles for chunks');
assert.match(manager,/instanceof NYCGISRoadGraph/,'physical road generation branches on authoritative GIS graph');
assert.match(traffic,/getDirectedEdgesNear/,'traffic spawn is selected from nearby directed GIS edges');
assert.match(traffic,/instanceof NYCGISRoadGraph/,'traffic has a dedicated GIS runtime path');

const distManifest = resolve('dist/data/nyc/manifest.json');
try {
  const builtManifestBytes = await readFile(distManifest);
  const builtManifest = JSON.parse(builtManifestBytes.toString('utf8'));
  assert.equal(builtManifest.files.sha256,manifest.files.sha256,'Vite bundle carries the exact baked manifest version');
  const builtTile = manifest.tiles[0];
  const builtTileBytes = await readFile(resolve('dist/data/nyc',builtTile.path));
  assert.equal(createHash('sha256').update(builtTileBytes).digest('hex'),builtTile.sha256,
    'Vite bundle carries a valid tile asset');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('Production dist is missing NYC GIS assets. Run npm run build:app after the bake.',{cause:error});
  }
  throw error;
}
console.log(JSON.stringify({result:'PASS',uniqueDrivableEdges:actual.size,tileCount:manifest.tiles.length,tileEdgeRows,distAssets:'verified'}));
