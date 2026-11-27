import assert from 'node:assert/strict';
import {
  drapeAtGradeRoadVertex,
  sampleTriangulatedTerrainSurface,
} from '../src/world/nyc/nyc-road-surface-core.mjs';

const risingTerrain = (x, z) => 8 + x * 0.12 - z * 0.04;
const left = drapeAtGradeRoadVertex({ x: -5, z: 10 }, 0.035, risingTerrain);
const right = drapeAtGradeRoadVertex({ x: 5, z: 10 }, 0.035, risingTerrain);
assert.deepEqual(left, { x: -5, y: 7.035, z: 10 },
  'left road edge must use its own terrain elevation plus the surface lift');
assert.deepEqual(right, { x: 5, y: 8.235, z: 10 },
  'right road edge must use its own terrain elevation plus the surface lift');
assert.notEqual(left.y, right.y,
  'a cross-slope must be represented across the road ribbon, not flattened to centreline height');
assert.throws(
  () => drapeAtGradeRoadVertex({ x: 0, z: 0 }, 0, () => null),
  /No validated NYC DEM elevation/,
  'a missing DEM sample must not fabricate a flat road vertex',
);
assert.throws(
  () => drapeAtGradeRoadVertex({ x: 0, z: 0 }, 0, () => Number.NaN),
  /No validated NYC DEM elevation/,
  'a non-finite DEM sample must not fabricate a flat road vertex',
);

// The 16 m terrain mesh uses triangles (A,C,B) and (A,D,C), where:
// A=(0,0), B=(1,0), C=(1,1), D=(0,1).
// Deliberately non-coplanar corners prove that the sample follows that exact
// diagonal and not a bilinear or raw-raster interpolation.
const gridHeights = new Map([
  ['0:0', 0],
  ['1:0', 10],
  ['1:1', 20],
  ['0:1', 30],
]);
const sampleGrid = (x, z) => gridHeights.get(x + ':' + z);
assert.equal(sampleTriangulatedTerrainSurface(7, 3, 10, sampleGrid), 10,
  'the lower-right triangle uses A, C and B barycentric weights');
assert.equal(sampleTriangulatedTerrainSurface(3, 7, 10, sampleGrid), 18,
  'the upper-left triangle uses A, D and C barycentric weights');
assert.equal(sampleTriangulatedTerrainSurface(10, 0, 10, sampleGrid), 10,
  'cell-boundary samples resolve to the same shared grid vertex');
assert.throws(
  () => sampleTriangulatedTerrainSurface(7, 3, 10, () => Number.NaN),
  /No validated NYC DEM elevation/,
  'a missing grid-corner sample must not create a fabricated mesh surface',
);

console.log(JSON.stringify({
  suite: 'NYC at-grade road and triangulated terrain surface alignment',
  result: 'PASS',
}, null, 2));
