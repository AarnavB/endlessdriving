import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'src/world/nyc/CityUrbanModel.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
  reportDiagnostics: true,
});
const errors = (output.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0, 'urban model TypeScript transpilation has no diagnostics');
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
const urban = await import(moduleUrl);

assert.equal(urban.getCityDistrictProfile(0, -2380).kind, 'financial');
assert.equal(urban.getCityDistrictProfile(0, -1320).kind, 'lower-manhattan');
assert.equal(urban.getCityDistrictProfile(0, 0).kind, 'midtown');
assert.equal(urban.getCityDistrictProfile(0, 1500).kind, 'residential');
assert.equal(urban.getCityDistrictProfile(-1600, 200).kind, 'west-waterfront');
assert.equal(urban.getCityDistrictProfile(1600, 200).kind, 'east-waterfront');
assert.equal(urban.getCityDistrictProfile(-2600, -3500).kind, 'industrial');

const midtown = urban.getCityDistrictProfile(0, 0);
let chosenBlock = null;
for (let x = -8; x <= 8 && chosenBlock === null; x++) {
  for (let z = -8; z <= 8; z++) {
    const parcels = urban.createCityParcelLayout(20261124, x, z, 62, 62, midtown);
    if (parcels.length > 0) {
      chosenBlock = { x, z, parcels };
      break;
    }
  }
}
assert(chosenBlock, 'a deterministic sampled Midtown block has buildable parcels');
const repeated = urban.createCityParcelLayout(20261124, chosenBlock.x, chosenBlock.z, 62, 62, midtown);
assert.deepEqual(repeated, chosenBlock.parcels, 'parcel layout is stable across chunk reloads');
assert(chosenBlock.parcels.length >= 4, 'Midtown blocks use a multi-lot subdivision');
for (const parcel of chosenBlock.parcels) {
  assert(parcel.width > 8 && parcel.depth > 8, 'generated building parcels have usable dimensions');
  assert(Math.abs(parcel.offsetX) + parcel.width * 0.5 <= 62, 'parcel remains inside its block footprint on X');
  assert(Math.abs(parcel.offsetZ) + parcel.depth * 0.5 <= 62, 'parcel remains inside its block footprint on Z');
}

const index = new urban.CitySpatialIndex(16);
index.insert('near', { minX: 14, maxX: 18, minZ: -2, maxZ: 2 }, { kind: 'building' });
index.insert('wide', { minX: -24, maxX: 25, minZ: 28, maxZ: 34 }, { kind: 'park' });
assert.deepEqual(index.query({ minX: 13, maxX: 19, minZ: -3, maxZ: 3 }).map((item) => item.id), ['near']);
assert.equal(index.query({ minX: -30, maxX: 30, minZ: 20, maxZ: 40 }).length, 1,
  'multi-cell records are deduplicated during spatial queries');
assert.equal(index.remove('near'), true);
assert.equal(index.remove('near'), false);
assert.equal(index.size, 1);

const fakeGraph = {
  specials: [],
  getRoadProfile: () => ({ widthM: 20 }),
  getSpecialSegmentsInBounds() { return this.specials; },
  getCenterlinePose(segmentId, distance) {
    return { position: { x: 30, z: 30 + distance - 10 } };
  },
};
assert.equal(urban.isAabbClearOfRoadNetwork(
  { minX: -1, maxX: 1, minZ: 42, maxZ: 44 }, fakeGraph,
), false, 'protected road corridor blocks environmental placement');
assert.equal(urban.isAabbClearOfRoadNetwork(
  { minX: 11.3, maxX: 12.1, minZ: 42, maxZ: 44 }, fakeGraph, 0.1,
), true, 'sidewalk clearance outside the road edge remains placeable');
assert.equal(urban.isAabbClearOfRoadNetwork(
  { minX: 42, maxX: 46, minZ: 42, maxZ: 46 }, fakeGraph,
), true, 'a footprint outside all road corridors is clear');

fakeGraph.specials = [{
  id: 'test-ramp',
  lengthM: 20,
  profile: { widthM: 8 },
  roadType: 'entrance-ramp',
}];
assert.equal(urban.isAabbClearOfRoadNetwork(
  { minX: 29, maxX: 31, minZ: 39, maxZ: 41 }, fakeGraph,
), false, 'curved special-road clearance is checked in addition to the grid');

let parkBlocks = 0;
for (let x = -24; x < 24; x++) {
  for (let z = -24; z < 24; z++) {
    if (urban.isCityParkBlock(20261124, x, z, midtown)) parkBlocks++;
  }
}
assert(parkBlocks > 0 && parkBlocks < 120, 'park reservations are deterministic and district-proportional');

console.log(JSON.stringify({
  suite: 'NYC district parcel and spatial placement regression',
  districts: 7,
  parcelsChecked: chosenBlock.parcels.length,
  spatialIndexSize: index.size,
  parkBlocks,
  result: 'PASS',
}, null, 2));
