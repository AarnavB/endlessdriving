const WGS84_A = 6378137;
const WGS84_INV_F = 298.257223563;
const WGS84_F = 1 / WGS84_INV_F;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG_TO_RAD = Math.PI / 180;
const ORIGIN = { latitude: 40.7595, longitude: -73.9906, altitudeM: 10 };

const originLat = ORIGIN.latitude * DEG_TO_RAD;
const originLon = ORIGIN.longitude * DEG_TO_RAD;
const originSinLat = Math.sin(originLat);
const originCosLat = Math.cos(originLat);
const originSinLon = Math.sin(originLon);
const originCosLon = Math.cos(originLon);
const originRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * originSinLat ** 2);
const originEcef = [
  (originRadius + ORIGIN.altitudeM) * originCosLat * originCosLon,
  (originRadius + ORIGIN.altitudeM) * originCosLat * originSinLon,
  (originRadius * (1 - WGS84_E2) + ORIGIN.altitudeM) * originSinLat,
];

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Convert WGS84 longitude/latitude into the game's local ENU metre frame. */
export function geographicToLocalENU(longitude, latitude, altitudeM = 0) {
  if (![longitude, latitude, altitudeM].every(Number.isFinite)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new RangeError('Invalid WGS84 coordinate in NYC street source.');
  }
  const lat = latitude * DEG_TO_RAD;
  const lon = longitude * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const ecef = [
    (radius + altitudeM) * cosLat * Math.cos(lon),
    (radius + altitudeM) * cosLat * Math.sin(lon),
    (radius * (1 - WGS84_E2) + altitudeM) * sinLat,
  ];
  const delta = [
    ecef[0] - originEcef[0],
    ecef[1] - originEcef[1],
    ecef[2] - originEcef[2],
  ];
  const eastAxis = [-originSinLon, originCosLon, 0];
  const northAxis = [
    -originSinLat * originCosLon,
    -originSinLat * originSinLon,
    originCosLat,
  ];
  const upAxis = [
    originCosLat * originCosLon,
    originCosLat * originSinLon,
    originSinLat,
  ];
  return {
    x: dot(eastAxis, delta),
    y: dot(upAxis, delta),
    z: dot(northAxis, delta),
  };
}

const ROADWAY_TYPE_NAMES = new Map([
  [1, 'street'],
  [2, 'highway'],
  [3, 'bridge'],
  [4, 'tunnel'],
  [8, 'driveway'],
  [9, 'ramp'],
  [10, 'alley'],
  [13, 'u-turn'],
]);

function readProperty(properties, ...names) {
  const entries = Object.entries(properties ?? {});
  for (const name of names) {
    const key = name.toLowerCase();
    const entry = entries.find(([candidate]) => candidate.toLowerCase() === key);
    if (entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== '') return entry[1];
  }
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePath(coordinates) {
  if (!Array.isArray(coordinates)) return null;
  const path = [];
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const longitude = finiteNumber(coordinate[0]);
    const latitude = finiteNumber(coordinate[1]);
    const altitude = coordinate.length > 2 ? finiteNumber(coordinate[2]) ?? 0 : 0;
    if (longitude === null || latitude === null) continue;
    const local = geographicToLocalENU(longitude, latitude, altitude);
    const previous = path.at(-1);
    if (!previous || Math.hypot(local.x - previous.x, local.y - previous.y, local.z - previous.z) >= 0.15) {
      path.push(local);
    }
  }
  return path.length >= 2 ? path : null;
}

/**
 * Convert one constructed, motor-vehicle CSCL feature into compact local data.
 * Non-constructed, non-physical, path-only and non-vehicular rows are excluded.
 */
export function normalizeCSCLFeature(feature, fallbackIndex = 0) {
  if (!feature || feature.type !== 'Feature' || !feature.properties || !feature.geometry) {
    return { feature: null, reason: 'invalid-feature' };
  }

  const properties = feature.properties;
  const statusCode = finiteNumber(readProperty(properties, 'status'));
  if (statusCode !== 2) return { feature: null, reason: 'not-constructed' };

  const roadwayTypeCode = finiteNumber(readProperty(properties, 'rw_type'));
  const roadwayType = ROADWAY_TYPE_NAMES.get(roadwayTypeCode);
  if (!roadwayType) return { feature: null, reason: 'non-drivable-roadway-type' };

  const trafficCode = String(readProperty(properties, 'trafdir') ?? 'UN').trim().toUpperCase();
  if (trafficCode === 'NV') return { feature: null, reason: 'non-vehicular' };
  const trafficDirection = trafficCode === 'FT' || trafficCode === 'TF' || trafficCode === 'TW'
    ? trafficCode
    : 'UN';

  const geometry = feature.geometry;
  let rawPaths;
  if (geometry.type === 'LineString') rawPaths = [geometry.coordinates];
  else if (geometry.type === 'MultiLineString') rawPaths = geometry.coordinates;
  else return { feature: null, reason: 'unsupported-geometry' };

  if (!Array.isArray(rawPaths)) return { feature: null, reason: 'invalid-geometry' };
  const paths = rawPaths.map(normalizePath).filter(Boolean);
  if (paths.length === 0) return { feature: null, reason: 'empty-path' };

  const objectId = readProperty(properties, 'objectid');
  const physicalId = readProperty(properties, 'physicalid');
  const segmentId = readProperty(properties, 'segmentid');
  const sourceId = objectId ?? segmentId ?? physicalId ?? feature.id ?? fallbackIndex;
  const widthFeet = finiteNumber(readProperty(properties, 'st_width'));
  const widthM = widthFeet !== null && widthFeet > 0 ? widthFeet * 0.3048 : null;
  const streetName = readProperty(properties, 'st_label', 'st_name', 'streetname', 'name');

  return {
    feature: {
      id: String(sourceId),
      physicalId: physicalId === null ? null : String(physicalId),
      streetName: streetName === null ? null : String(streetName).trim(),
      roadwayType,
      roadwayTypeCode,
      trafficDirection,
      widthM,
      bikeLane: readProperty(properties, 'bike_lane'),
      paths,
    },
    reason: null,
  };
}

export function buildBakedStreetNetwork(features, bounds, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(features)) throw new TypeError('CSCL source features must be an array.');
  const normalized = [];
  const rejected = {};
  const seenIds = new Set();

  for (let index = 0; index < features.length; index++) {
    const result = normalizeCSCLFeature(features[index], index);
    if (!result.feature) {
      rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
      continue;
    }
    const item = result.feature;
    if (seenIds.has(item.id)) {
      rejected.duplicate-source-id = (rejected.duplicate-source-id ?? 0) + 1;
      continue;
    }
    seenIds.add(item.id);
    normalized.push(item);
  }

  normalized.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return {
    schema: 'endless-driving.nyc-street-network',
    schemaVersion: 1,
    generatedAt,
    source: {
      datasetId: 'inkn-q76z',
      title: 'NYC Street Centerline (CSCL)',
      provider: 'NYC Office of Technology and Innovation',
      url: 'https://data.cityofnewyork.us/City-Government/NYC-Street-Centerline-CSCL-/inkn-q76z',
      trafficDirectionSemantics: {
        FT: 'with the segment address range',
        TF: 'against the segment address range',
        TW: 'two-way',
        NV: 'non-vehicular; excluded from this drivable network',
      },
      roadwayTypeSemantics: Object.fromEntries(ROADWAY_TYPE_NAMES),
    },
    coordinateFrame: {
      name: 'local-ENU',
      units: 'metres',
      axes: '+X east, +Y up, +Z north',
      origin: ORIGIN,
      sourceCoordinates: 'WGS84 longitude/latitude',
    },
    bounds,
    counts: {
      sourceFeatures: features.length,
      retainedFeatures: normalized.length,
      rejectedFeatures: features.length - normalized.length,
      rejectedByReason: rejected,
      paths: normalized.reduce((total, item) => total + item.paths.length, 0),
      vertices: normalized.reduce((total, item) =>
        total + item.paths.reduce((sum, path) => sum + path.length, 0), 0),
    },
    features: normalized,
  };
}

export const CSCL_DEFAULT_BOUNDS = Object.freeze({
  // Lower Manhattan through central / upper Manhattan, the Hudson edge and
  // the East River. The exact polygon will be clipped against source geometry.
  north: 40.835,
  south: 40.694,
  east: -73.927,
  west: -74.055,
});
