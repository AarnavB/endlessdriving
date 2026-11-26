export interface NYCBuildingTileBounds {
  minX: number; maxX: number; minZ: number; maxZ: number;
}
export interface NYCBuildingTileRecord {
  id: string; path: string; bounds: NYCBuildingTileBounds;
  sha256: string; bytes: number; buildingCount: number;
}
export interface NYCBuildingFootprint {
  id: string;
  bin: string | null;
  baseBbl: string | null;
  name: string | null;
  featureCode: number;
  constructionYear: number | null;
  geometrySource: string | null;
  sourceHeightFt: number | null;
  groundElevationM: number | null;
  heightM: number;
  heightSource: 'height_roof' | 'feature-code-median' | 'configurable-fallback';
  centroid: { x: number; z: number };
  /** MultiPolygon -> Polygon -> (outer ring, inner rings) -> local ENU points. */
  polygons: Array<Array<Array<{ x: number; z: number }>>>;
}
export interface NYCBuildingTile {
  schema: 'endless-driving.nyc-building-tile';
  schemaVersion: 1;
  id: string;
  bounds: NYCBuildingTileBounds;
  buildings: NYCBuildingFootprint[];
}
export interface NYCBuildingManifest {
  schema: 'endless-driving.nyc-building-network';
  schemaVersion: 2;
  generatedAt: string;
  retrievedAt: string;
  tileSizeM: number;
  source: {
    datasetId: string; title: string; provider: string; attribution: string;
    url: string; license: string; termsOfUse: string; sourceHorizontalCrs: string;
    runtimeCoordinateFrame: string; heightUnit: string; groundElevationUnit: string;
    groundElevationVerticalDatum: string;
  };
  coverage: { boroughCounts: Record<string, number> };
  bounds: { north: number; south: number; east: number; west: number };
  counts: {
    sourceFeatures: number; retainedBuildings: number; sourceHeightCount: number;
    inferredHeightCount: number; tiles: number; polygons: number; rings: number;
  };
  tiles: NYCBuildingTileRecord[];
}
export interface NYCBuildingBoundsRequest {
  minX: number; maxX: number; minZ: number; maxZ: number;
}
function overlaps(a: NYCBuildingTileBounds, b: NYCBuildingBoundsRequest): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Checksummed, cached loader for the official NYC OTI BUILDING footprint tiles. */
export class NYCBuildingFootprintLoader {
  private manifestPromise: Promise<NYCBuildingManifest> | null = null;
  private readonly cache = new Map<string, NYCBuildingTile>();
  private readonly pending = new Map<string, Promise<NYCBuildingTile>>();
  private disposed = false;
  private readonly baseUrl: string;

  constructor(baseUrl?: string, private readonly maxCachedTiles = 32) {
    const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    this.baseUrl = (baseUrl ?? viteBase).replace(/\/?$/, '/') + 'data/nyc/buildings/';
  }

  async loadTilesForBounds(bounds: NYCBuildingBoundsRequest): Promise<NYCBuildingTile[]> {
    this.assertActive();
    if (![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)
      || bounds.maxX < bounds.minX || bounds.maxZ < bounds.minZ) {
      throw new RangeError('Invalid NYC building tile bounds request.');
    }
    const manifest = await this.loadManifest();
    return Promise.all(manifest.tiles.filter((tile) => overlaps(tile.bounds, bounds))
      .map((record) => this.loadTile(record)));
  }

  async loadManifest(): Promise<NYCBuildingManifest> {
    this.assertActive();
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchManifest().catch((error: unknown) => {
        this.manifestPromise = null;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.pending.clear();
    this.manifestPromise = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('NYC building footprint loader has been disposed.');
  }

  private async fetchManifest(): Promise<NYCBuildingManifest> {
    const response = await this.fetchWithRetry(this.baseUrl + 'manifest.json');
    const manifest = await response.json() as NYCBuildingManifest;
    if (!manifest || manifest.schema !== 'endless-driving.nyc-building-network'
      || manifest.schemaVersion !== 2 || !Array.isArray(manifest.tiles)
      || manifest.tiles.length === 0 || manifest.source?.datasetId !== '5zhs-2jue'
      || !Number.isFinite(manifest.tileSizeM) || manifest.tileSizeM <= 0) {
      throw new Error('NYC building manifest failed schema/source validation.');
    }
    const ids = new Set<string>();
    for (const tile of manifest.tiles) {
      if (!tile.id || !tile.path || ids.has(tile.id)
        || !/^[a-f0-9]{64}$/i.test(tile.sha256)
        || !Number.isInteger(tile.bytes) || tile.bytes <= 0
        || !Number.isInteger(tile.buildingCount) || tile.buildingCount <= 0
        || !tile.bounds || ![
          tile.bounds.minX, tile.bounds.maxX, tile.bounds.minZ, tile.bounds.maxZ,
        ].every(Number.isFinite)) {
        throw new Error('NYC building manifest contains an invalid or duplicate tile record.');
      }
      ids.add(tile.id);
    }
    return manifest;
  }

  private async loadTile(record: NYCBuildingTileRecord): Promise<NYCBuildingTile> {
    const existing = this.cache.get(record.id);
    if (existing) {
      this.cache.delete(record.id);
      this.cache.set(record.id, existing);
      return existing;
    }
    const pending = this.pending.get(record.id);
    if (pending) return pending;
    const request = (async () => {
      const response = await this.fetchWithRetry(this.baseUrl + record.path);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== record.bytes) {
        throw new Error('NYC building tile byte-count mismatch: ' + record.id);
      }
      if (!globalThis.crypto?.subtle) {
        throw new Error('Web Crypto is required to validate NYC building tile checksums.');
      }
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      if (hex(digest) !== record.sha256.toLowerCase()) {
        throw new Error('NYC building tile SHA-256 mismatch: ' + record.id);
      }
      const tile = JSON.parse(new TextDecoder().decode(bytes)) as NYCBuildingTile;
      if (tile.schema !== 'endless-driving.nyc-building-tile'
        || tile.schemaVersion !== 1 || tile.id !== record.id
        || !Array.isArray(tile.buildings) || tile.buildings.length !== record.buildingCount) {
        throw new Error('NYC building tile schema/count validation failed: ' + record.id);
      }
      const buildingIds = new Set<string>();
      for (const building of tile.buildings) {
        if (!building || typeof building.id !== 'string' || building.id.length === 0
          || buildingIds.has(building.id)
          || !Number.isInteger(building.featureCode)
          || !Number.isFinite(building.heightM) || building.heightM < 2.5 || building.heightM > 500
          || !building.centroid || !Number.isFinite(building.centroid.x)
          || !Number.isFinite(building.centroid.z)
          || !Array.isArray(building.polygons) || building.polygons.length === 0) {
          throw new Error('NYC building tile contains invalid footprint metadata: ' + record.id);
        }
        buildingIds.add(building.id);
        for (const polygon of building.polygons) {
          if (!Array.isArray(polygon) || polygon.length === 0) {
            throw new Error('NYC building tile contains an empty polygon: ' + building.id);
          }
          for (const ring of polygon) {
            if (!Array.isArray(ring) || ring.length < 4) {
              throw new Error('NYC building footprint ring is too short: ' + building.id);
            }
            for (const point of ring) {
              if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) {
                throw new Error('NYC building footprint contains a non-finite coordinate: ' + building.id);
              }
            }
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (Math.hypot(first.x - last.x, first.z - last.z) > 0.03) {
              throw new Error('NYC building footprint ring is not closed: ' + building.id);
            }
          }
        }
      }
      this.assertActive();
      this.cache.set(record.id, tile);
      while (this.cache.size > Math.max(1, this.maxCachedTiles)) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      return tile;
    })().finally(() => this.pending.delete(record.id));
    this.pending.set(record.id, request);
    return request;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw new Error('Unable to load required NYC building asset ' + url + ': '
      + (lastError instanceof Error ? lastError.message : String(lastError)));
  }
}
