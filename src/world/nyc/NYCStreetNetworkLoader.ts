export interface NYCStreetTileBounds {
  minX: number; maxX: number; minZ: number; maxZ: number;
}
export interface NYCStreetTileRecord {
  id: string; path: string; bounds: NYCStreetTileBounds; sha256: string;
  bytes: number; edgeCount: number; nodeCount: number;
}
export interface NYCStreetManifest {
  schema: 'endless-driving.nyc-street-network.tiles';
  schemaVersion: 1;
  generatedAt: string;
  tileSizeM: number;
  source: { datasetId: string; title: string; provider: string; url: string };
  bounds: { north: number; south: number; east: number; west: number };
  spawnPosition: { x: number; y: number; z: number };
  counts: { sourceFeatures: number; retainedFeatures: number; paths: number; vertices: number };
  graph: { nodeCount: number; edgeCount: number; drivableEdgeCount: number; connectedComponentCount: number };
  tiles: NYCStreetTileRecord[];
}
export interface NYCStreetTileNode {
  id: string; position: { x: number; y: number; z: number }; levelCode: number | null;
  degree: number; incidentEdgeIds: string[]; incomingEdgeIds: string[]; outgoingEdgeIds: string[];
}
export interface NYCStreetTileEdge {
  id: string; sourceFeatureId: string; physicalId: string | number | null;
  fromNodeId: string; toNodeId: string; fromLevelCode: number | null; toLevelCode: number | null;
  trafficDirection: string; directionality: 'both' | 'forward' | 'reverse';
  allowedDirections: Array<'forward' | 'reverse'>;
  roadwayType: string; roadwayTypeCode: number | null; streetName: string | null;
  widthM: number | null; numberTravelLanes: number | null; numberTotalLanes: number | null;
  postedSpeedSourceValue: number | null; lengthM: number;
  geometry: Array<{ x: number; y: number; z: number }>;
}
export interface NYCStreetTile {
  schema: 'endless-driving.nyc-street-tile'; schemaVersion: 1; id: string;
  bounds: NYCStreetTileBounds;
  graph: { nodes: NYCStreetTileNode[]; edges: NYCStreetTileEdge[] };
}
export interface NYCStreetBoundsRequest {
  minX: number; maxX: number; minZ: number; maxZ: number;
}
function intersects(a: NYCStreetTileBounds, b: NYCStreetBoundsRequest): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Checksummed runtime loader. Failed requests are evicted so subsequent chunk requests can retry. */
export class NYCStreetNetworkLoader {
  private manifestPromise: Promise<NYCStreetManifest> | null = null;
  private readonly cache = new Map<string, NYCStreetTile>();
  private readonly pending = new Map<string, Promise<NYCStreetTile>>();
  private disposed = false;
  private readonly baseUrl: string;

  constructor(baseUrl?: string, private readonly maxCachedTiles = 48) {
    const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    this.baseUrl = (baseUrl ?? viteBase).replace(/\/?$/, '/') + 'data/nyc/';
  }

  async loadManifest(): Promise<NYCStreetManifest> {
    this.assertActive();
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchManifest().catch((error: unknown) => {
        this.manifestPromise = null;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  async loadInitialTiles(): Promise<{
    manifest: NYCStreetManifest;
    spawnPosition: { x: number; y: number; z: number };
    tiles: NYCStreetTile[];
  }> {
    const manifest = await this.loadManifest();
    const spawnPosition = manifest.spawnPosition;
    if (![spawnPosition.x, spawnPosition.y, spawnPosition.z].every(Number.isFinite)) {
      throw new Error('NYC GIS manifest has an invalid spawn position.');
    }
    const radius = manifest.tileSizeM * 1.51;
    const tiles = await this.loadTilesForBounds({
      minX: spawnPosition.x - radius, maxX: spawnPosition.x + radius,
      minZ: spawnPosition.z - radius, maxZ: spawnPosition.z + radius,
    });
    if (tiles.length === 0) throw new Error('No checksummed GIS tiles cover the declared spawn position.');
    return { manifest, spawnPosition, tiles };
  }

  async loadTilesForBounds(bounds: NYCStreetBoundsRequest): Promise<NYCStreetTile[]> {
    this.assertActive();
    if (![bounds.minX,bounds.maxX,bounds.minZ,bounds.maxZ].every(Number.isFinite)
      || bounds.maxX < bounds.minX || bounds.maxZ < bounds.minZ) {
      throw new RangeError('Invalid GIS tile bounds request.');
    }
    const manifest = await this.loadManifest();
    return Promise.all(manifest.tiles.filter((tile) => intersects(tile.bounds,bounds))
      .map((tile) => this.loadTile(tile)));
  }

  dispose(): void {
    this.disposed = true; this.cache.clear(); this.pending.clear(); this.manifestPromise = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('NYC street network loader has been disposed.');
  }

  private async fetchManifest(): Promise<NYCStreetManifest> {
    const response = await this.fetchWithRetry(this.baseUrl + 'manifest.json');
    const manifest = await response.json() as NYCStreetManifest;
    if (!manifest || manifest.schema !== 'endless-driving.nyc-street-network'
      || manifest.schemaVersion !== 3 || !Array.isArray(manifest.tiles)
      || !Number.isFinite(manifest.tileSizeM) || manifest.tileSizeM <= 0
      || !manifest.graph || manifest.graph.drivableEdgeCount <= 0 || manifest.tiles.length === 0) {
      throw new Error('NYC GIS tile manifest failed schema or graph validation.');
    }
    const ids = new Set<string>();
    for (const tile of manifest.tiles) {
      if (!tile.id || !tile.path || ids.has(tile.id) || !/^[a-f0-9]{64}$/i.test(tile.sha256)
        || !Number.isInteger(tile.bytes) || tile.bytes <= 0
        || !Number.isInteger(tile.edgeCount) || tile.edgeCount < 0
        || !Number.isInteger(tile.nodeCount) || tile.nodeCount < 0
        || !tile.bounds || ![tile.bounds.minX,tile.bounds.maxX,tile.bounds.minZ,tile.bounds.maxZ].every(Number.isFinite)) {
        throw new Error('NYC GIS manifest contains an invalid or duplicate tile record.');
      }
      ids.add(tile.id);
    }
    return manifest;
  }

  private async loadTile(record: NYCStreetTileRecord): Promise<NYCStreetTile> {
    const existing = this.cache.get(record.id);
    if (existing) { this.cache.delete(record.id); this.cache.set(record.id,existing); return existing; }
    const pending = this.pending.get(record.id);
    if (pending) return pending;
    const request = (async () => {
      const response = await this.fetchWithRetry(this.baseUrl + record.path);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== record.bytes) throw new Error('GIS tile byte count mismatch: ' + record.id);
      if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required for GIS tile checksum validation.');
      const digest = await globalThis.crypto.subtle.digest('SHA-256',bytes);
      if (toHex(digest) !== record.sha256.toLowerCase()) throw new Error('GIS tile SHA-256 mismatch: ' + record.id);
      const tile = JSON.parse(new TextDecoder().decode(bytes)) as NYCStreetTile;
      if (tile.schema !== 'endless-driving.nyc-street-tile' || tile.schemaVersion !== 1
        || tile.id !== record.id || !tile.graph || !Array.isArray(tile.graph.nodes)
        || !Array.isArray(tile.graph.edges) || tile.graph.nodes.length !== record.nodeCount
        || tile.graph.edges.length !== record.edgeCount) {
        throw new Error('GIS tile schema/count validation failed: ' + record.id);
      }
      this.cache.set(record.id,tile);
      while (this.cache.size > Math.max(1,this.maxCachedTiles)) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      return tile;
    })().finally(() => this.pending.delete(record.id));
    this.pending.set(record.id,request);
    return request;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt=0; attempt<3; attempt++) {
      try {
        const response = await fetch(url,{cache:'no-cache'});
        if (!response.ok) throw new Error('HTTP '+response.status+' for '+url);
        return response;
      } catch (error) {
        lastError=error;
        if (attempt<2) await new Promise((resolve) => setTimeout(resolve,250*(attempt+1)));
      }
    }
    throw new Error('Unable to load required NYC GIS asset '+url+': '
      +(lastError instanceof Error ? lastError.message : String(lastError)));
  }
}
