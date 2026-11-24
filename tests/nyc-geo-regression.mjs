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

console.log(JSON.stringify({
  suite: 'NYC geospatial regression',
  checks: 12,
  result: 'PASS',
  localCoordinateMetres: {
    east: Number(local.x.toFixed(3)),
    north: Number(local.z.toFixed(3)),
  },
  oneHundredMetreLongitudeDistanceM: Number(haversine.toFixed(3)),
}, null, 2));
