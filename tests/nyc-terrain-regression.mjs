import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('public/data/nyc/terrain');
const manifestBytes = await readFile(resolve(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.schema, 'endless-driving.nyc-terrain-network');
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.source.datasetId, 'NYC_TopoBathymetric_2017_1_meter');
assert.equal(manifest.coordinateFrame.sourceHorizontalCrs, 'EPSG:2263 - NAD83 / New York Long Island (US survey feet)');
assert.equal(manifest.coordinateFrame.rasterOutputHorizontalCrs, 'EPSG:4326 - WGS 84 longitude/latitude');
assert.equal(manifest.coordinateFrame.verticalDatum, 'NAVD88 / Geoid 12B');
assert.match(manifest.coordinateFrame.verticalUnit, /metres/i);
assert.ok(Number.isFinite(manifest.originElevationM));
assert.ok(manifest.tiles.length > 0);
assert.equal(manifest.counts.tiles, manifest.tiles.length);
assert.equal(manifest.grid.pixelType, 'F32');

const tileIds = new Set();
let validPixels = 0;
let totalBytes = 0;
for (const record of manifest.tiles) {
  assert.ok(!tileIds.has(record.id), 'terrain tile IDs are unique');
  tileIds.add(record.id);
  const bytes = await readFile(resolve(root, record.path));
  assert.equal(bytes.byteLength, record.bytes, 'terrain tile byte count: ' + record.id);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256,
    'terrain tile SHA-256: ' + record.id);
  assert.equal(bytes.byteLength, record.width * record.height * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let tileValid = 0;
  let minimum = Infinity, maximum = -Infinity;
  for (let i = 0; i < record.width * record.height; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) continue;
    tileValid++;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    assert.ok(value >= -500 && value <= 1000, 'plausible terrain elevation range');
  }
  assert.equal(tileValid, record.validPixelCount, 'terrain NoData normalization: ' + record.id);
  assert.ok(tileValid > 0, 'terrain tile has valid elevation samples');
  assert.ok(maximum >= minimum, 'terrain min/max range is ordered');
  validPixels += tileValid;
  totalBytes += bytes.byteLength;
}
assert.equal(validPixels, manifest.counts.validPixels);
assert.equal(totalBytes, manifest.counts.bytes);
assert.equal(totalBytes, manifest.tiles.reduce((sum, tile) => sum + tile.bytes, 0));

const coverageAnchors = [
  { borough: 'Manhattan', latitude: 40.7580, longitude: -73.9855 },
  { borough: 'The Bronx', latitude: 40.8249, longitude: -73.8760 },
  { borough: 'Brooklyn', latitude: 40.6782, longitude: -73.9442 },
  { borough: 'Queens', latitude: 40.7282, longitude: -73.7949 },
  { borough: 'Staten Island', latitude: 40.5795, longitude: -74.1502 },
];
for (const point of coverageAnchors) {
  const tile = manifest.tiles.find((item) => item.bounds.west <= point.longitude
    && item.bounds.east >= point.longitude
    && item.bounds.south <= point.latitude
    && item.bounds.north >= point.latitude);
  assert.ok(tile, 'terrain source coverage includes ' + point.borough);
}
const originTile = manifest.tiles.find((item) => item.bounds.west <= -73.9906
  && item.bounds.east >= -73.9906
  && item.bounds.south <= 40.7595
  && item.bounds.north >= 40.7595);
assert.ok(originTile, 'terrain tiles cover the shared local ENU origin');
console.log(JSON.stringify({
  suite: 'NYC 2017 DEM tile integrity, CRS and five-borough coverage',
  tileCount: manifest.tiles.length,
  validPixels,
  noDataPixels: manifest.counts.noDataPixels,
  bytes: totalBytes,
  originElevationM: manifest.originElevationM,
  result: 'PASS',
}, null, 2));
