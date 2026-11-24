export type CityDistrictKind =
  | 'financial'
  | 'lower-manhattan'
  | 'midtown'
  | 'residential'
  | 'west-waterfront'
  | 'east-waterfront'
  | 'industrial'
  | 'outer';

export interface CityDistrictProfile {
  kind: CityDistrictKind;
  columns: readonly [number, number];
  rows: readonly [number, number];
  minimumHeightM: number;
  maximumHeightM: number;
  parkChance: number;
  parcelGapM: number;
  footprintScale: readonly [number, number];
  palette: readonly number[];
}

export interface CityParcel {
  id: string;
  offsetX: number;
  offsetZ: number;
  width: number;
  depth: number;
  variation: number;
}

export interface CityBounds2D {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface CitySpatialRecord<T> {
  id: string;
  bounds: CityBounds2D;
  value: T;
}

export interface CityRoadQuery {
  getRoadProfile(axis: 'x' | 'z', lineIndex: number): { widthM: number };
  getSpecialSegmentsInBounds(minX: number, maxX: number, minZ: number, maxZ: number): Array<{
    id: string;
    lengthM: number;
    profile: { widthM: number };
    roadType: string;
  }>;
  getCenterlinePose(segmentId: string, distanceAlongM: number): {
    position: { x: number; z: number };
  };
}

export const CITY_SPATIAL_BLOCK_SPACING_M = 160;

const DISTRICTS: Record<CityDistrictKind, CityDistrictProfile> = {
  financial: {
    kind: 'financial', columns: [2, 3], rows: [2, 3],
    minimumHeightM: 58, maximumHeightM: 218, parkChance: 0.012,
    parcelGapM: 4.8, footprintScale: [0.84, 0.97],
    palette: [0x6c777c, 0x7c817e, 0x8d8174, 0x59666f, 0x9b968b, 0x626b70],
  },
  'lower-manhattan': {
    kind: 'lower-manhattan', columns: [2, 3], rows: [1, 3],
    minimumHeightM: 18, maximumHeightM: 104, parkChance: 0.035,
    parcelGapM: 5.4, footprintScale: [0.72, 0.94],
    palette: [0x8a7465, 0x9b8b78, 0x765f52, 0x777b78, 0x9a9b95, 0x59646a],
  },
  midtown: {
    kind: 'midtown', columns: [2, 3], rows: [2, 3],
    minimumHeightM: 32, maximumHeightM: 194, parkChance: 0.022,
    parcelGapM: 4.2, footprintScale: [0.83, 0.98],
    palette: [0x627985, 0x8b6556, 0xaaa69d, 0x59656a, 0x8b8b82, 0x777c80],
  },
  residential: {
    kind: 'residential', columns: [1, 2], rows: [1, 2],
    minimumHeightM: 11, maximumHeightM: 52, parkChance: 0.095,
    parcelGapM: 6.8, footprintScale: [0.68, 0.91],
    palette: [0x9a7968, 0x8a8174, 0x765b4e, 0x9a9a91, 0x777c7d, 0x6e7776],
  },
  'west-waterfront': {
    kind: 'west-waterfront', columns: [1, 2], rows: [1, 2],
    minimumHeightM: 8, maximumHeightM: 48, parkChance: 0.14,
    parcelGapM: 8.2, footprintScale: [0.62, 0.88],
    palette: [0x747a78, 0x817e73, 0x6c777c, 0x918b7e, 0x5e6a6e, 0x8c8c82],
  },
  'east-waterfront': {
    kind: 'east-waterfront', columns: [1, 2], rows: [1, 2],
    minimumHeightM: 9, maximumHeightM: 58, parkChance: 0.105,
    parcelGapM: 7.6, footprintScale: [0.65, 0.9],
    palette: [0x7d817c, 0x8f8c80, 0x68777b, 0x9a968a, 0x72736e, 0x5f6d74],
  },
  industrial: {
    kind: 'industrial', columns: [1, 2], rows: [1, 2],
    minimumHeightM: 7, maximumHeightM: 34, parkChance: 0.035,
    parcelGapM: 9.5, footprintScale: [0.76, 0.96],
    palette: [0x747a7b, 0x666d70, 0x8a8378, 0x77736b, 0x59666b, 0x8a8a83],
  },
  outer: {
    kind: 'outer', columns: [1, 2], rows: [1, 2],
    minimumHeightM: 9, maximumHeightM: 48, parkChance: 0.12,
    parcelGapM: 7.8, footprintScale: [0.64, 0.92],
    palette: [0x8b8174, 0x7c7c76, 0x777d7d, 0x917d6e, 0x69757a, 0x9a968c],
  },
};

/** Stable integer hash shared by city parcels and streamed environmental props. */
export function citySpatialHash(x: number, z: number, seed: number): number {
  let value = Math.imul((x | 0) ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ (z | 0), 0x45d9f3b);
  value ^= value >>> 16;
  return value >>> 0;
}

function unit(value: number): number {
  return (value >>> 0) / 0x100000000;
}

function inEllipse(x: number, z: number, centreX: number, centreZ: number, radiusX: number, radiusZ: number): boolean {
  const nx = (x - centreX) / radiusX;
  const nz = (z - centreZ) / radiusZ;
  return nx * nx + nz * nz <= 1;
}

/**
 * Returns a deterministic NYC-inspired district identity in the local ENU frame.
 * These are design zones, not surveyed neighbourhood or borough boundaries.
 */
export function getCityDistrictProfile(x: number, z: number): CityDistrictProfile {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new RangeError('District coordinates must be finite.');
  }
  if (inEllipse(x, z, 0, -2380, 1120, 760)) return DISTRICTS.financial;
  if (inEllipse(x, z, 0, -1320, 1450, 880)) return DISTRICTS['lower-manhattan'];
  if (x >= -1150 && x <= 1120 && z >= -920 && z <= 920) return DISTRICTS.midtown;
  if (x < -1320 && z >= -1850 && z <= 1700) {
    return z < -650 ? DISTRICTS.industrial : DISTRICTS['west-waterfront'];
  }
  if (x > 1350 && z >= -1600 && z <= 1850) return DISTRICTS['east-waterfront'];
  if (z > 820 && Math.abs(x) < 1750) return DISTRICTS.residential;
  if (Math.abs(x) > 2350 || z < -3200) return DISTRICTS.industrial;
  return DISTRICTS.outer;
}

export function isCityParkBlock(
  seed: number,
  gridX: number,
  gridZ: number,
  district: CityDistrictProfile = getCityDistrictProfile(
    (gridX + 0.5) * CITY_SPATIAL_BLOCK_SPACING_M,
    (gridZ + 0.5) * CITY_SPATIAL_BLOCK_SPACING_M,
  ),
): boolean {
  const roll = unit(citySpatialHash(gridX * 17 + 3, gridZ * 29 - 5, seed ^ 0x4f1bbcdc));
  return roll < district.parkChance;
}

/** Generate a repeatable but district-specific parcel subdivision for one city block. */
export function createCityParcelLayout(
  seed: number,
  gridX: number,
  gridZ: number,
  halfWidth: number,
  halfDepth: number,
  district: CityDistrictProfile = getCityDistrictProfile(
    (gridX + 0.5) * CITY_SPATIAL_BLOCK_SPACING_M,
    (gridZ + 0.5) * CITY_SPATIAL_BLOCK_SPACING_M,
  ),
): CityParcel[] {
  if (![halfWidth, halfDepth].every(Number.isFinite) || halfWidth <= 5 || halfDepth <= 5) {
    return [];
  }
  if (isCityParkBlock(seed, gridX, gridZ, district)) return [];

  const base = citySpatialHash(gridX * 13 + 7, gridZ * 19 - 11, seed ^ 0x51f2);
  const columns = district.columns[0] + (base % (district.columns[1] - district.columns[0] + 1));
  const rows = district.rows[0] + ((base >>> 8) % (district.rows[1] - district.rows[0] + 1));
  const gap = district.parcelGapM;
  const usableWidth = halfWidth * 2 - gap * (columns + 1);
  const usableDepth = halfDepth * 2 - gap * (rows + 1);
  if (usableWidth <= columns * 8 || usableDepth <= rows * 8) return [];

  const cellWidth = usableWidth / columns;
  const cellDepth = usableDepth / rows;
  const result: CityParcel[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const value = citySpatialHash(gridX * 101 + index * 7, gridZ * 103 - index * 11, seed ^ 0x73a91);
      const scale = district.footprintScale[0]
        + unit(value) * (district.footprintScale[1] - district.footprintScale[0]);
      const jitterX = (unit(citySpatialHash(gridX + index * 3, gridZ - index * 5, seed ^ 0x2d)) - 0.5) * Math.min(3.5, gap * 0.42);
      const jitterZ = (unit(citySpatialHash(gridX - index * 7, gridZ + index * 13, seed ^ 0x9b)) - 0.5) * Math.min(3.5, gap * 0.42);
      const width = cellWidth * scale;
      const depth = cellDepth * (district.kind === 'lower-manhattan'
        ? 0.76 + unit(value >>> 1) * 0.2
        : scale);
      result.push({
        id: String(gridX) + ':' + String(gridZ) + ':' + String(index),
        offsetX: -halfWidth + gap + cellWidth * (column + 0.5) + jitterX,
        offsetZ: -halfDepth + gap + cellDepth * (row + 0.5) + jitterZ,
        width: Math.min(width, cellWidth - 1),
        depth: Math.min(depth, cellDepth - 1),
        variation: unit(value >>> 2),
      });
    }
  }
  return result;
}

function validBounds(bounds: CityBounds2D): boolean {
  return [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite)
    && bounds.maxX >= bounds.minX && bounds.maxZ >= bounds.minZ;
}

export function boundsIntersect(a: CityBounds2D, b: CityBounds2D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/** Deterministic uniform spatial hash for nearby buildings, props and clearance queries. */
export class CitySpatialIndex<T> {
  private readonly records = new Map<string, CitySpatialRecord<T>>();
  private readonly cells = new Map<string, Set<string>>();

  constructor(readonly cellSizeM = 32) {
    if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) {
      throw new RangeError('Spatial-index cell size must be positive and finite.');
    }
  }

  get size(): number { return this.records.size; }

  insert(id: string, bounds: CityBounds2D, value: T): void {
    if (!id || this.records.has(id)) throw new Error('Spatial record ID must be unique and non-empty: ' + id);
    if (!validBounds(bounds)) throw new RangeError('Spatial record bounds must be finite and ordered.');
    const record = { id, bounds: { ...bounds }, value };
    this.records.set(id, record);
    for (const key of this.keysFor(bounds)) {
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = new Set<string>(); this.cells.set(key, bucket); }
      bucket.add(id);
    }
  }

  remove(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    for (const key of this.keysFor(record.bounds)) {
      const bucket = this.cells.get(key);
      bucket?.delete(id);
      if (bucket?.size === 0) this.cells.delete(key);
    }
    this.records.delete(id);
    return true;
  }

  query(bounds: CityBounds2D): CitySpatialRecord<T>[] {
    if (!validBounds(bounds)) throw new RangeError('Spatial query bounds must be finite and ordered.');
    const ids = new Set<string>();
    for (const key of this.keysFor(bounds)) {
      for (const id of this.cells.get(key) ?? []) ids.add(id);
    }
    return [...ids]
      .map((id) => this.records.get(id)!)
      .filter((record) => boundsIntersect(record.bounds, bounds))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  clear(): void {
    this.records.clear();
    this.cells.clear();
  }

  private keysFor(bounds: CityBounds2D): string[] {
    const minCellX = Math.floor(bounds.minX / this.cellSizeM);
    const maxCellX = Math.floor(bounds.maxX / this.cellSizeM);
    const minCellZ = Math.floor(bounds.minZ / this.cellSizeM);
    const maxCellZ = Math.floor(bounds.maxZ / this.cellSizeM);
    const keys: string[] = [];
    for (let z = minCellZ; z <= maxCellZ; z++) {
      for (let x = minCellX; x <= maxCellX; x++) keys.push(String(x) + ':' + String(z));
    }
    return keys;
  }
}

function distanceSquaredToBounds(x: number, z: number, bounds: CityBounds2D): number {
  const nearestX = Math.max(bounds.minX, Math.min(bounds.maxX, x));
  const nearestZ = Math.max(bounds.minZ, Math.min(bounds.maxZ, z));
  return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

/**
 * Tests a transformed object's world-space footprint against every nearby grid
 * road and curved grade-separated segment. Bounds must already include its radius.
 */
export function isAabbClearOfRoadNetwork(
  bounds: CityBounds2D,
  graph: CityRoadQuery,
  paddingM = 0,
): boolean {
  if (!validBounds(bounds) || !Number.isFinite(paddingM) || paddingM < 0) {
    throw new RangeError('Road-clearance bounds and padding must be valid.');
  }
  const spacing = CITY_SPATIAL_BLOCK_SPACING_M;
  const firstX = Math.floor(bounds.minX / spacing) - 1;
  const lastX = Math.ceil(bounds.maxX / spacing) + 1;
  for (let line = firstX; line <= lastX; line++) {
    const centre = line * spacing;
    const halfWidth = graph.getRoadProfile('z', line).widthM * 0.5 + paddingM;
    if (bounds.minX <= centre + halfWidth && bounds.maxX >= centre - halfWidth) return false;
  }

  const firstZ = Math.floor(bounds.minZ / spacing) - 1;
  const lastZ = Math.ceil(bounds.maxZ / spacing) + 1;
  for (let line = firstZ; line <= lastZ; line++) {
    const centre = line * spacing;
    const halfWidth = graph.getRoadProfile('x', line).widthM * 0.5 + paddingM;
    if (bounds.minZ <= centre + halfWidth && bounds.maxZ >= centre - halfWidth) return false;
  }

  const nearbySpecials = graph.getSpecialSegmentsInBounds(
    bounds.minX - 64, bounds.maxX + 64, bounds.minZ - 64, bounds.maxZ + 64,
  ).filter((segment) => segment.roadType !== 'surface' && segment.roadType !== 'underpass');
  for (const segment of nearbySpecials) {
    const clearance = segment.profile.widthM * 0.5 + paddingM;
    const samples = Math.max(8, Math.ceil(segment.lengthM / 3));
    for (let sample = 0; sample <= samples; sample++) {
      const pose = graph.getCenterlinePose(segment.id, segment.lengthM * sample / samples);
      if (distanceSquaredToBounds(pose.position.x, pose.position.z, bounds) <= clearance * clearance) {
        return false;
      }
    }
  }
  return true;
}
