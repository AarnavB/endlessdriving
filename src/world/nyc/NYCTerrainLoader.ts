import { localToGeographic, type GeographicBounds } from './NYCGeo';
import { sampleNYCTerrainRaster } from './nyc-terrain-sampling-core.mjs';
export { sampleNYCTerrainRaster } from './nyc-terrain-sampling-core.mjs';

export interface NYCTerrainTileBounds {
  north: number; south: number; east: number; west: number;
}
export interface NYCTerrainTileRecord {
  id: string; xIndex: number; yIndex: number; path: string;
  bounds: NYCTerrainTileBounds; sha256: string; bytes: number;
  width: number; height: number; validPixelCount: number;
}
export interface NYCTerrainManifest {
  schema: 'endless-driving.nyc-terrain-network';
  schemaVersion: 1;
  generatedAt: string;
  retrievedAt: string;
  bounds: GeographicBounds;
  tileSizeDegrees: { longitude: number; latitude: number };
  grid: {
    width: number; height: number; bands: 1; pixelType: 'F32';
    outputFormat: string; approximateResolutionM: number;
    gameTerrainVertexSpacingM: number; noDataValue: string;
  };
  coordinateFrame: {
    sourceHorizontalCrs: string; rasterOutputHorizontalCrs: string;
    verticalDatum: string; verticalUnit: string; runtimeFrame: string;
    verticalOrigin: string; datumTransformation: string;
  };
  source: {
    datasetId: string; title: string; provider: string; attribution: string;
    url: string; metadataUrl: string; license: string; captureDates: string;
    sourceResolutionM: number; sourceHorizontalUnit: string;
    retrievalMethod: string; metadataChecks: {
      navd88: boolean; geoid12b: boolean; nad83: boolean; convertedToMeters: boolean;
    };
  };
  originElevationM: number;
  counts: {
    columns: number; rows: number; tiles: number;
    validPixels: number; noDataPixels: number; bytes: number;
  };
  tiles: NYCTerrainTileRecord[];
}
export interface NYCTerrainTile {
  id: string; width: number; height: number;
  bounds: NYCTerrainTileBounds; heights: Float32Array;
}

function intersects(a: NYCTerrainTileBounds, b: GeographicBounds): boolean {
  return a.north >= b.south && a.south <= b.north
    && a.east >= b.west && a.west <= b.east;
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}
/** Checksummed LRU loader for the NYC 2017 NAVD88 bare-earth elevation surface. */
export class NYCTerrainLoader {
  private manifestPromise: Promise<NYCTerrainManifest> | null = null;
  private manifestValue: NYCTerrainManifest | null = null;
  private readonly cache = new Map<string, NYCTerrainTile>();
  private readonly pending = new Map<string, Promise<NYCTerrainTile>>();
  private readonly recordsByGrid = new Map<string, NYCTerrainTileRecord>();
  private disposed = false;
  private readonly baseUrl: string;

  constructor(baseUrl?: string, private readonly maxCachedTiles = 64) {
    const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    this.baseUrl = (baseUrl ?? viteBase).replace(/\/?$/, '/') + 'data/nyc/terrain/';
  }

  async loadTilesForBounds(bounds: GeographicBounds): Promise<NYCTerrainTile[]> {
    this.assertActive();
    if (![bounds.north, bounds.south, bounds.east, bounds.west].every(Number.isFinite)
      || bounds.north < bounds.south || bounds.east < bounds.west) {
      throw new RangeError('Invalid NYC terrain geographic bounds.');
    }
    const manifest = await this.loadManifest();
    return Promise.all(manifest.tiles.filter((tile) => intersects(tile.bounds, bounds))
      .map((record) => this.loadTile(record)));
  }

  async loadManifest(): Promise<NYCTerrainManifest> {
    this.assertActive();
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchManifest().catch((error: unknown) => {
        this.manifestPromise = null;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  getHeightAtLocal(worldX: number, worldZ: number): number | null {
    this.assertActive();
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return null;
    const manifest = this.manifestValue;
    if (!manifest) return null;
    const geographic = localToGeographic({ x: worldX, y: 0, z: worldZ });
    const column = Math.floor(
      (geographic.longitude - manifest.bounds.west) / manifest.tileSizeDegrees.longitude,
    );
    const row = Math.floor(
      (geographic.latitude - manifest.bounds.south) / manifest.tileSizeDegrees.latitude,
    );
    const candidates: NYCTerrainTileRecord[] = [];
    for (let x = column - 1; x <= column + 1; x++) {
      for (let y = row - 1; y <= row + 1; y++) {
        const record = this.recordsByGrid.get(x + ':' + y);
        if (record && intersects(record.bounds, {
          north: geographic.latitude, south: geographic.latitude,
          east: geographic.longitude, west: geographic.longitude,
        })) candidates.push(record);
      }
    }
    candidates.sort((a, b) => a.yIndex - b.yIndex || a.xIndex - b.xIndex);
    for (const record of candidates) {
      const tile = this.cache.get(record.id);
      if (!tile) continue;
      const value = sampleNYCTerrainRaster(
        tile.heights, tile.width, tile.height, tile.bounds,
        geographic.longitude, geographic.latitude,
      );
      if (value !== null) {
        this.cache.delete(record.id);
        this.cache.set(record.id, tile);
        return value - manifest.originElevationM;
      }
    }
    return null;
  }

  getCachedTileCount(): number {
    return this.cache.size;
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.pending.clear();
    this.recordsByGrid.clear();
    this.manifestPromise = null;
    this.manifestValue = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('NYC terrain loader has been disposed.');
  }

  private async fetchManifest(): Promise<NYCTerrainManifest> {
    const response = await this.fetchWithRetry(this.baseUrl + 'manifest.json');
    const manifest = await response.json() as NYCTerrainManifest;
    if (!manifest || manifest.schema !== 'endless-driving.nyc-terrain-network'
      || manifest.schemaVersion !== 1 || !Array.isArray(manifest.tiles)
      || manifest.source?.datasetId !== 'NYC_TopoBathymetric_2017_1_meter'
      || manifest.coordinateFrame?.verticalDatum !== 'NAVD88 / Geoid 12B'
      || !Number.isFinite(manifest.originElevationM)
      || !manifest.tileSizeDegrees
      || !Number.isFinite(manifest.tileSizeDegrees.longitude)
      || !Number.isFinite(manifest.tileSizeDegrees.latitude)
      || manifest.grid?.pixelType !== 'F32'
      || manifest.counts?.tiles !== manifest.tiles.length) {
      throw new Error('NYC terrain manifest failed source, datum or schema validation.');
    }
    const ids = new Set<string>();
    for (const tile of manifest.tiles) {
      if (!tile.id || ids.has(tile.id) || !tile.path
        || !/^[a-f0-9]{64}$/i.test(tile.sha256)
        || !Number.isInteger(tile.bytes) || tile.bytes !== tile.width * tile.height * 4
        || tile.width !== manifest.grid.width || tile.height !== manifest.grid.height
        || !Number.isInteger(tile.xIndex) || !Number.isInteger(tile.yIndex)
        || !Number.isInteger(tile.validPixelCount)
        || !tile.bounds || ![
          tile.bounds.north, tile.bounds.south, tile.bounds.east, tile.bounds.west,
        ].every(Number.isFinite)) {
        throw new Error('NYC terrain manifest contains an invalid or duplicate tile record.');
      }
      ids.add(tile.id);
      this.recordsByGrid.set(tile.xIndex + ':' + tile.yIndex, tile);
    }
    this.manifestValue = manifest;
    return manifest;
  }

  private async loadTile(record: NYCTerrainTileRecord): Promise<NYCTerrainTile> {
    const cached = this.cache.get(record.id);
    if (cached) {
      this.cache.delete(record.id);
      this.cache.set(record.id, cached);
      return cached;
    }
    const pending = this.pending.get(record.id);
    if (pending) return pending;
    const request = (async () => {
      const response = await this.fetchWithRetry(this.baseUrl + record.path);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== record.bytes) throw new Error('NYC terrain byte-count mismatch: ' + record.id);
      if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required for NYC terrain checksums.');
      const actual = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      if (hex(actual) !== record.sha256.toLowerCase()) throw new Error('NYC terrain SHA-256 mismatch: ' + record.id);
      const view = new DataView(bytes);
      const heights = new Float32Array(record.width * record.height);
      let validCount = 0;
      for (let i = 0; i < heights.length; i++) {
        const value = view.getFloat32(i * 4, true);
        heights[i] = value;
        if (Number.isFinite(value)) validCount++;
      }
      if (validCount !== record.validPixelCount) {
        throw new Error('NYC terrain valid-pixel count mismatch: ' + record.id);
      }
      const tile: NYCTerrainTile = {
        id: record.id, width: record.width, height: record.height,
        bounds: record.bounds, heights,
      };
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
        if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
      }
    }
    throw new Error('Unable to load required NYC terrain asset ' + url + ': '
      + (lastError instanceof Error ? lastError.message : String(lastError)));
  }
}
