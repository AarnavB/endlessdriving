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

// Exercise the actual TypeScript GIS graph implementation against a directed fixture.
// Compile the two TypeScript modules into data URLs so the regression can run in Node
// without adding a test-only runtime dependency or importing the browser game bundle.
import ts from 'typescript';

const toModuleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');

const waterfrontSource = await readFile('src/world/nyc/NYCWaterfrontLayout.ts','utf8');
const waterfrontUrl = toModuleUrl(waterfrontSource);
const cityGraphSource = (await readFile('src/world/nyc/CityRoadGraph.ts','utf8'))
  .replace('"./NYCWaterfrontLayout"', JSON.stringify(waterfrontUrl));
const cityGraphUrl = toModuleUrl(cityGraphSource);
const gisGraphSource = (await readFile('src/world/nyc/NYCGISRoadGraph.ts','utf8'))
  .replace("'./CityRoadGraph'", JSON.stringify(cityGraphUrl));
const gisGraphUrl = toModuleUrl(gisGraphSource);
const { NYCGISRoadGraph } = await import(gisGraphUrl);

const makeNode = (id,x,z,degree) => ({
  id, position:{x,y:0,z}, levelCode:13, degree,
  incidentEdgeIds:[], incomingEdgeIds:[], outgoingEdgeIds:[],
});
const makeEdge = (id,fromNodeId,toNodeId,directionality,allowedDirections,geometry) => ({
  id, sourceFeatureId:id, physicalId:null, fromNodeId,toNodeId,
  fromLevelCode:13,toLevelCode:13,
  trafficDirection:directionality==='both'?'TW':directionality==='forward'?'FT':'TF',
  directionality, allowedDirections, roadwayType:'street', roadwayTypeCode:1,
  streetName:id, widthM:10, numberTravelLanes:1, numberTotalLanes:1,
  postedSpeedSourceValue:25, lengthM:geometry.reduce((sum,p,i)=>i
    ? sum+Math.hypot(p.x-geometry[i-1].x,p.y-geometry[i-1].y,p.z-geometry[i-1].z):0,0),
  geometry,
});
const fixture = {
  schema:'endless-driving.nyc-street-tile', schemaVersion:1, id:'fixture',
  bounds:{minX:-10,maxX:210,minZ:-10,maxZ:110},
  graph:{
    nodes:[
      makeNode('n0',0,0,1),makeNode('n1',100,0,2),makeNode('n2',100,100,1),
    ],
    edges:[
      makeEdge('one-way','n0','n1','forward',['forward'],[
        {x:0,y:0,z:0},{x:50,y:0,z:0},{x:100,y:0,z:0},
      ]),
      makeEdge('two-way','n1','n2','both',['forward','reverse'],[
        {x:100,y:0,z:0},{x:100,y:0,z:50},{x:100,y:0,z:100},
      ]),
    ],
  },
};
const runtimeGraph = new NYCGISRoadGraph([fixture],{x:0,y:0,z:0});
assert.equal(runtimeGraph.isGISBacked,true);
assert.equal(runtimeGraph.getSegment('one-way').geometry.length,3,
  'runtime graph must preserve every source polyline vertex');
assert.equal(runtimeGraph.getOutgoingEdges('n0').length,1);
assert.equal(runtimeGraph.getOutgoingEdges('n0')[0].direction,1);
assert.equal(runtimeGraph.getOutgoingEdges('n1').length,1,
  'one-way road must not be traversable in reverse');
assert.equal(runtimeGraph.findRoute('n0','n2').length,2,
  'A* route must use connected directed GIS edges');
assert.throws(() => runtimeGraph.findRoute('n2','n0'),
  /No directed route exists/,
  'routefinding must reject a prohibited reverse traversal');
assert.throws(() => runtimeGraph.getIntersectionId(0,0),
  /Grid intersection IDs are disabled/,
  'runtime GIS graph must not synthesize grid intersections');
const nearest = runtimeGraph.getNearestLanePose(47,2,1,0,0);
assert.ok(Math.abs(nearest.position.x-47)<1.5 && Math.abs(nearest.position.z)<1.5,
  'nearest drivable-lane query must resolve the source polyline');
assert.ok(runtimeGraph.getDirectedEdgesNear(40,0,100,8).some((edge)=>edge.segmentId==='one-way'),
  'traffic lookup must return directed road edges');

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
