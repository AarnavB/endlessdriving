import assert from 'node:assert/strict';
import {
  buildBakedStreetNetwork,
  geographicToLocalENU,
  normalizeCSCLFeature,
} from '../scripts/nyc-street-data-core.mjs';

const origin = geographicToLocalENU(-73.9906, 40.7595, 0);
assert(Math.abs(origin.x) < 1e-6 && Math.abs(origin.y) < 1e-6 && Math.abs(origin.z) < 1e-6,
  'the NYC reference coordinate maps to the local origin');

const nearby = geographicToLocalENU(-73.9896, 40.7595, 0);
const elevated = geographicToLocalENU(-73.9906, 40.7595, 12);
assert.equal(elevated.y, 12, 'source height is preserved without tangent-plane curvature becoming artificial road grade');
assert(nearby.x > 80 && nearby.x < 90, 'one-thousandth longitude degree maps east by a realistic local distance');
assert(Math.abs(nearby.z) < 0.1, 'same-latitude coordinate has negligible northing difference');

const makeFeature = (overrides = {}) => ({
  type: 'Feature',
  id: 71,
  properties: {
    objectid: 71,
    physicalid: 7001,
    status: '2',
    rw_type: '1',
    trafdir: 'TW',
    st_width: '40',
    st_label: 'W 42 ST',
    frm_lvl_co: '13',
    to_lvl_co: '14',
    bike_lane: null,
    ...overrides,
  },
  geometry: {
    type: 'MultiLineString',
    coordinates: [[
      [-73.9906, 40.7595],
      [-73.9896, 40.7595],
      [-73.9896, 40.7595],
      [-73.9886, 40.7595],
    ]],
  },
});

const normalized = normalizeCSCLFeature(makeFeature());
assert.equal(normalized.reason, null);
assert.equal(normalized.feature.id, '71');
assert.equal(normalized.feature.physicalId, '7001');
assert.equal(normalized.feature.streetName, 'W 42 ST');
assert.equal(normalized.feature.roadwayType, 'street');
assert.equal(normalized.feature.trafficDirection, 'TW');
assert.equal(normalized.feature.fromLevelCode, 13);
assert.equal(normalized.feature.toLevelCode, 14);
assert(Math.abs(normalized.feature.widthM - 12.192) < 1e-9,
  'paved width is converted from feet to metres');
const aliased = normalizeCSCLFeature(makeFeature({
  st_label: null, stname_label: 'WEST 42 STREET', st_width: null, street_width: '50',
}));
assert.equal(aliased.feature.streetName, 'WEST 42 STREET');
assert(Math.abs(aliased.feature.widthM - 15.24) < 1e-9,
  'alternate source field names are normalized when supplied');

assert.equal(normalized.feature.paths.length, 1);
assert.equal(normalized.feature.paths[0].length, 3,
  'near-identical consecutive vertices are deduplicated');
assert(normalized.feature.paths[0][1].x > normalized.feature.paths[0][0].x,
  'road geometry retains its eastbound orientation');

assert.equal(normalizeCSCLFeature(makeFeature({ status: '3' })).reason, 'not-constructed');
assert.equal(normalizeCSCLFeature(makeFeature({ rw_type: '12' })).reason, 'non-drivable-roadway-type');
assert.equal(normalizeCSCLFeature(makeFeature({ trafdir: 'NV' })).reason, 'non-vehicular');

const network = buildBakedStreetNetwork([
  makeFeature(),
  makeFeature({ objectid: 72, rw_type: '2', trafdir: 'FT', st_width: '80' }),
  makeFeature({ objectid: 73, status: '4' }),
], { north: 40.83, south: 40.69, east: -73.92, west: -74.05 }, '2026-11-24T00:00:00.000Z');
assert.equal(network.schemaVersion, 2);
assert.equal(network.coordinateFrame.name, 'local-ENU');
assert.equal(network.coordinateFrame.verticalAxis, 'source third ordinate in metres; 2D coordinates use 0; not a terrain elevation model');
assert.equal(network.sourceFieldDiagnostics.attributes.streetName.nonNullFeatures, 1);
assert.equal(network.sourceFieldDiagnostics.attributes.widthFeet.nonNullFeatures, 2);
assert.equal(network.counts.sourceFeatures, 3);
assert.equal(network.counts.retainedFeatures, 2);
assert.equal(network.counts.rejectedByReason['not-constructed'], 1);
assert.equal(network.features.length, 2);
assert.deepEqual(network.features.map((item) => item.id), ['71', '72'],
  'network features sort deterministically by stable source ID');

console.log(JSON.stringify({
  suite: 'NYC CSCL offline-bake normalization regression',
  assertions: 29,
  result: 'PASS',
}));
