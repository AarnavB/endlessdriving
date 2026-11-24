import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, '../src/world/nyc/NYCGeo.ts');
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(transpiled).toString('base64');
const geo = await import(moduleUrl);

const waterLayoutPath = resolve(here, '../src/world/nyc/NYCWaterfrontLayout.ts');
const waterLayoutSource = await readFile(waterLayoutPath, 'utf8');
const waterLayoutOutput = ts.transpileModule(waterLayoutSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const waterLayoutUrl = 'data:text/javascript;base64,' + Buffer.from(waterLayoutOutput).toString('base64');
const waterfront = await import(waterLayoutUrl);

const origin = geo.NYC_ORIGIN;
const atOrigin = geo.geographicToLocal(origin);
assert(Math.abs(atOrigin.x) < 1e-7, 'origin east coordinate must be zero');
assert(Math.abs(atOrigin.y) < 1e-7, 'origin up coordinate must be zero');
assert(Math.abs(atOrigin.z) < 1e-7, 'origin north coordinate must be zero');

const midtownPoint = { latitude: 40.761, longitude: -73.986, altitudeM: 16 };
const local = geo.geographicToLocal(midtownPoint);
const restored = geo.localToGeographic(local);
assert(Math.abs(restored.latitude - midtownPoint.latitude) < 1e-8, 'latitude round-trip');
assert(Math.abs(restored.longitude - midtownPoint.longitude) < 1e-8, 'longitude round-trip');
assert(Math.abs(restored.altitudeM - midtownPoint.altitudeM) < 0.02, 'altitude round-trip');

const nearbyPoint = { latitude: 40.7595, longitude: -73.9896, altitudeM: origin.altitudeM };
const nearby = geo.geographicToLocal(nearbyPoint);
const haversine = geo.haversineDistanceM(origin, nearbyPoint);
const enuHorizontalDistance = Math.hypot(nearby.x, nearby.z);
const latitudeRadians = origin.latitude * Math.PI / 180;
const flattening = 1 / geo.WGS84.inverseFlattening;
const eccentricitySquared = flattening * (2 - flattening);
const primeVerticalRadius = geo.WGS84.semiMajorAxisM
  / Math.sqrt(1 - eccentricitySquared * Math.sin(latitudeRadians) ** 2);
const expectedParallelDistance = primeVerticalRadius * Math.cos(latitudeRadians)
  * Math.abs((nearbyPoint.longitude - origin.longitude) * Math.PI / 180);
assert(Math.abs(enuHorizontalDistance - expectedParallelDistance) < 0.001,
  'local ENU horizontal distance should match the WGS84 ellipsoid scale');
assert(Math.abs(enuHorizontalDistance - haversine) < 0.3,
  'local ENU distance should remain within tolerance of the spherical haversine approximation');

assert.deepEqual(geo.getChunkIndex(-0.01, -0.01), { x: -1, z: -1 });
assert.deepEqual(geo.getChunkIndex(-512.01, -512.01), { x: -2, z: -2 });
assert.deepEqual(
  geo.parseChunkKey(geo.getChunkKey({ x: -12, z: 23 })),
  { x: -12, z: 23 },
  'chunk key round-trip',
);

const bounds = geo.localBoundsToGeographic({
  minX: -256, maxX: 256, minZ: -256, maxZ: 256,
});
assert(bounds.north > bounds.south, 'geographic bounds have a positive latitude span');
assert(bounds.east > bounds.west, 'geographic bounds have a positive longitude span');

for (const z of [-2800, -1400, 0, 1400, 2800]) {
  const east = waterfront.getHudsonEastBankX(z);
  const west = waterfront.getHudsonWestBankX(z);
  const centre = waterfront.getHudsonRiverCenterX(z);
  assert(west < centre && centre < east, 'Hudson bank ordering');
  assert(waterfront.getHudsonRiverWidthM(z) > 1700
    && waterfront.getHudsonRiverWidthM(z) < 2300, 'river remains substantial in width');
  assert(waterfront.isHudsonWater(centre, z), 'river centre is water');
  assert(!waterfront.isHudsonWater(east + 12, z), 'Manhattan bank is dry');
  assert(!waterfront.isHudsonWater(west - 12, z), 'New Jersey bank is dry');
  assert(!waterfront.isHudsonWater(waterfront.getHudsonShorelineRoadX(z), z),
    'scenic shoreline road is inland');
  assert(waterfront.getHudsonRiverDepthM(centre, z) > 4, 'riverbed remains below the surface');
}
assert(!waterfront.isHudsonWater(0, waterfront.HUDSON_RIVER_MAX_Z + 100),
  'river polygon has north/south bounds');
assert(waterfront.footprintTouchesHudson(-1900, -1800, -20, 20),
  'a footprint crossing the shoreline is rejected');
assert(!waterfront.footprintTouchesHudson(-1500, -1400, -20, 20),
  'an inland footprint remains valid');

console.log(JSON.stringify({
  suite: 'NYC geospatial and Hudson waterfront layout regression',
  checks: 50,
  result: 'PASS',
  localCoordinateMetres: {
    east: Number(local.x.toFixed(3)),
    north: Number(local.z.toFixed(3)),
  },
  oneHundredMetreLongitudeDistanceM: Number(haversine.toFixed(3)),
}, null, 2));
