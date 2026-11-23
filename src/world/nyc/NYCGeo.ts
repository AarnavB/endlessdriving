/**
 * WGS84 geodesy for the NYC local tangent frame.
 * The game uses metres, with +X east, +Y up and +Z north.
 */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
  altitudeM?: number;
}
export interface LocalCoordinate { x: number; y: number; z: number; }
export interface LocalBounds { minX: number; minZ: number; maxX: number; maxZ: number; }
export interface GeographicBounds { north: number; south: number; east: number; west: number; }
export interface ChunkIndex { x: number; z: number; }

export const WGS84 = { semiMajorAxisM: 6378137, inverseFlattening: 298.257223563 };
export const NYC_ORIGIN: GeoCoordinate = { latitude: 40.7595, longitude: -73.9906, altitudeM: 10 };

/** Broad five-borough discovery envelope; not an official borough boundary polygon. */
export const NYC_FIVE_BOROUGH_EXTENT: GeographicBounds = {
  north: 40.92, south: 40.48, east: -73.70, west: -74.26,
};
export const NYC_CHUNK_SIZE_M = 512;
export const FEET_TO_METRES = 0.3048;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const flattening = 1 / WGS84.inverseFlattening;
const eccentricitySquared = flattening * (2 - flattening);
const semiMinorAxisM = WGS84.semiMajorAxisM * (1 - flattening);

function geodeticToEcef(coordinate: GeoCoordinate): [number, number, number] {
  const latitude = coordinate.latitude * DEG_TO_RAD;
  const longitude = coordinate.longitude * DEG_TO_RAD;
  const altitude = coordinate.altitudeM ?? 0;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const primeVerticalRadius = WGS84.semiMajorAxisM
    / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
  return [
    (primeVerticalRadius + altitude) * cosLatitude * Math.cos(longitude),
    (primeVerticalRadius + altitude) * cosLatitude * Math.sin(longitude),
    (primeVerticalRadius * (1 - eccentricitySquared) + altitude) * sinLatitude,
  ];
}

const originEcef = geodeticToEcef(NYC_ORIGIN);
const originLatitude = NYC_ORIGIN.latitude * DEG_TO_RAD;
const originLongitude = NYC_ORIGIN.longitude * DEG_TO_RAD;
const eastAxis: [number, number, number] = [-Math.sin(originLongitude), Math.cos(originLongitude), 0];
const northAxis: [number, number, number] = [
  -Math.sin(originLatitude) * Math.cos(originLongitude),
  -Math.sin(originLatitude) * Math.sin(originLongitude),
  Math.cos(originLatitude),
];
const upAxis: [number, number, number] = [
  Math.cos(originLatitude) * Math.cos(originLongitude),
  Math.cos(originLatitude) * Math.sin(originLongitude),
  Math.sin(originLatitude),
];

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Convert WGS84 longitude/latitude/height into local ENU metres. */
export function geographicToLocal(coordinate: GeoCoordinate): LocalCoordinate {
  const ecef = geodeticToEcef(coordinate);
  const delta: [number, number, number] = [
    ecef[0] - originEcef[0], ecef[1] - originEcef[1], ecef[2] - originEcef[2],
  ];
  return { x: dot(eastAxis, delta), y: dot(upAxis, delta), z: dot(northAxis, delta) };
}

/** Convert local ENU metres back to WGS84 using an iterative ellipsoid solve. */
export function localToGeographic(local: LocalCoordinate): GeoCoordinate {
  const ecef: [number, number, number] = [
    originEcef[0] + eastAxis[0] * local.x + upAxis[0] * local.y + northAxis[0] * local.z,
    originEcef[1] + eastAxis[1] * local.x + upAxis[1] * local.y + northAxis[1] * local.z,
    originEcef[2] + eastAxis[2] * local.x + upAxis[2] * local.y + northAxis[2] * local.z,
  ];
  const p = Math.hypot(ecef[0], ecef[1]);
  const longitude = Math.atan2(ecef[1], ecef[0]);
  let latitude = Math.atan2(ecef[2], p * (1 - eccentricitySquared));
  let altitude = 0;
  for (let iteration = 0; iteration < 12; iteration++) {
    const sinLatitude = Math.sin(latitude);
    const primeVerticalRadius = WGS84.semiMajorAxisM
      / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
    const cosLatitude = Math.cos(latitude);
    altitude = Math.abs(cosLatitude) > 1e-12
      ? p / cosLatitude - primeVerticalRadius
      : Math.abs(ecef[2]) - semiMinorAxisM;
    const denominator = p * (1 - eccentricitySquared
      * primeVerticalRadius / (primeVerticalRadius + altitude));
    const nextLatitude = Math.atan2(ecef[2], denominator);
    if (Math.abs(nextLatitude - latitude) < 1e-13) {
      latitude = nextLatitude;
      break;
    }
    latitude = nextLatitude;
  }
  return {
    latitude: latitude * RAD_TO_DEG,
    longitude: longitude * RAD_TO_DEG,
    altitudeM: altitude,
  };
}

/** Convert a local axis-aligned chunk rectangle to a WGS84 query envelope. */
export function localBoundsToGeographic(bounds: LocalBounds): GeographicBounds {
  const corners = [
    localToGeographic({ x: bounds.minX, y: 0, z: bounds.minZ }),
    localToGeographic({ x: bounds.minX, y: 0, z: bounds.maxZ }),
    localToGeographic({ x: bounds.maxX, y: 0, z: bounds.minZ }),
    localToGeographic({ x: bounds.maxX, y: 0, z: bounds.maxZ }),
  ];
  return {
    north: Math.max(...corners.map((point) => point.latitude)),
    south: Math.min(...corners.map((point) => point.latitude)),
    east: Math.max(...corners.map((point) => point.longitude)),
    west: Math.min(...corners.map((point) => point.longitude)),
  };
}

/** Stable, globally addressable chunk index for local metre coordinates. */
export function getChunkIndex(x: number, z: number, chunkSizeM = NYC_CHUNK_SIZE_M): ChunkIndex {
  if (!Number.isFinite(x) || !Number.isFinite(z) || chunkSizeM <= 0) {
    throw new RangeError('Chunk coordinates and chunk size must be finite; chunk size must be positive.');
  }
  return { x: Math.floor(x / chunkSizeM), z: Math.floor(z / chunkSizeM) };
}
export function getChunkKey(index: ChunkIndex): string {
  return String(index.x) + ':' + String(index.z);
}
export function parseChunkKey(key: string): ChunkIndex {
  const parts = key.split(':');
  if (parts.length !== 2) throw new Error('Invalid NYC chunk key: ' + key);
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error('Invalid NYC chunk key: ' + key);
  return { x, z };
}

/** Great-circle distance, useful for validating source coordinates and tests. */
export function haversineDistanceM(a: GeoCoordinate, b: GeoCoordinate): number {
  const lat1 = a.latitude * DEG_TO_RAD;
  const lat2 = b.latitude * DEG_TO_RAD;
  const deltaLat = (b.latitude - a.latitude) * DEG_TO_RAD;
  const deltaLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}
