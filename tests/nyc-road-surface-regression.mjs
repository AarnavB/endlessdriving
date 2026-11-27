import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { drapeAtGradeRoadVertex } from '../src/world/nyc/nyc-road-surface-core.mjs';

const risingTerrain = (x, z) => 8 + x * 0.12 - z * 0.04;
const left = drapeAtGradeRoadVertex({ x: -5, z: 10 }, 0.035, risingTerrain);
const right = drapeAtGradeRoadVertex({ x: 5, z: 10 }, 0.035, risingTerrain);
assert.deepEqual(left, { x: -5, y: 7.035, z: 10 },
  'left road edge must use its own DEM elevation plus the surface lift');
assert.deepEqual(right, { x: 5, y: 8.235, z: 10 },
  'right road edge must use its own DEM elevation plus the surface lift');
assert.notEqual(left.y, right.y,
  'a cross-slope must be represented across the road ribbon, not flattened to centreline height');
assert.throws(
  () => drapeAtGradeRoadVertex({ x: 0, z: 0 }, 0, () => null),
  /No validated NYC DEM elevation/,
  'a missing DEM sample must fail rather than fabricate a flat road vertex',
);
assert.throws(
  () => drapeAtGradeRoadVertex({ x: 0, z: 0 }, 0, () => Number.NaN),
  /No validated NYC DEM elevation/,
  'a non-finite DEM sample must fail rather than fabricate a flat road vertex',
);

const manager = await readFile('src/world/nyc/NYCCityChunkManager.ts', 'utf8');
assert.match(manager, /drapeAtGradeRoadVertex/,
  'the chunk manager must use the tested terrain draping helper for its GIS road ribbons');
assert.match(manager, /segment\.roadType === 'surface'/,
  'only at-grade surface ribbons are draped to the ground DEM');

console.log(JSON.stringify({
  suite: 'NYC at-grade road cross-section DEM draping',
  result: 'PASS',
}, null, 2));
