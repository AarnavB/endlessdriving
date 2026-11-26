import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY_BLOCK_SPACING_M,
  CITY_CHUNK_SIZE_M,
  CityRoadGraph,
} from './CityRoadGraph';
import type { CityRoadSegment } from './CityRoadGraph';
import { NYCGISRoadGraph } from './NYCGISRoadGraph';
import { NYCStreetNetworkLoader } from './NYCStreetNetworkLoader';
import { NYCBuildingFootprintLoader } from './NYCBuildingFootprintLoader';
import type { NYCBuildingFootprint } from './NYCBuildingFootprintLoader';
import {
  CitySpatialIndex,
  citySpatialHash,
  createCityParcelLayout,
  getCityDistrictProfile,
  isAabbClearOfRoadNetwork,
  isCityParkBlock,
} from './CityUrbanModel';
import type { CityBounds2D } from './CityUrbanModel';
import {
  HUDSON_RIVER_MIN_Z, HUDSON_RIVER_MAX_Z,
  getHudsonEastBankX, getHudsonWestBankX, getHudsonRiverDepthM,
  isHudsonWater, footprintTouchesHudson,
} from './NYCWaterfrontLayout';

interface CityChunk {
  key: string;
  group: THREE.Group;
  body: RAPIER.RigidBody;
  geometries: THREE.BufferGeometry[];
  buildings: number;
  buildingColliders: number;
  roads: number;
  environmentObjects: number;
  nightLights: THREE.PointLight[];
}
interface BuildingSpec {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  baseY: number;
  colour: THREE.Color;
}
interface CurbSpec {
  x: number;
  z: number;
  length: number;
  alongX: boolean;
}
interface RibbonBounds { minX: number; maxX: number; minZ: number; maxZ: number; }
interface InstanceSpec {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: THREE.Vector3;
}

const STREAM_RADIUS = 1;
const SIDEWALK_WIDTH_M = 3.1;
const SIDEWALK_LIFT_M = 0.13;
const CURB_HEIGHT_M = 0.18;
const CURB_WIDTH_M = 0.2;

function hash(x: number, z: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ z, 0x45d9f3b);
  value ^= value >>> 16;
  return value >>> 0;
}
function makeGeometry(positions: number[], indices: number[]): THREE.BufferGeometry | null {
  if (positions.length < 12 || indices.length < 6) return null;
  const geometry = new THREE.BufferGeometry();
  const uvs: number[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    // Eight-metre world-space texture tiles line up between 512 m chunks,
    // including curved ramps whose vertices are generated in chunk-local space.
    uvs.push(positions[index] / 8, positions[index + 2] / 8);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

interface AsphaltTextureSet {
  colour: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
}

/** Small deterministic PBR maps; one shared set serves every streamed chunk. */
function createAsphaltTextures(): AsphaltTextureSet {
  const size = 256;
  const pixelCount = size * size;
  const height = new Float32Array(pixelCount);
  const colourData = new Uint8Array(pixelCount * 4);
  const normalData = new Uint8Array(pixelCount * 4);
  const roughnessData = new Uint8Array(pixelCount * 4);
  const indexAt = (x: number, y: number): number =>
    (((y + size) % size) * size) + ((x + size) % size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = indexAt(x, y);
      const fine = hash(x, y, 0x41535048) & 0xff;
      const coarse = hash(x >> 3, y >> 3, 0x524f4144) & 0xff;
      const grain = ((fine - 127.5) * 0.075) + ((coarse - 127.5) * 0.11);
      height[index] = grain;
      const luminance = THREE.MathUtils.clamp(67 + grain, 42, 94);
      const offset = index * 4;
      colourData[offset] = luminance;
      colourData[offset + 1] = luminance + 2;
      colourData[offset + 2] = luminance + 4;
      colourData[offset + 3] = 255;
      const roughness = 225 + (fine & 0x0f);
      roughnessData[offset] = roughness;
      roughnessData[offset + 1] = roughness;
      roughnessData[offset + 2] = roughness;
      roughnessData[offset + 3] = 255;
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = indexAt(x, y);
      const dx = (height[indexAt(x + 1, y)] - height[indexAt(x - 1, y)]) * 0.035;
      const dy = (height[indexAt(x, y + 1)] - height[indexAt(x, y - 1)]) * 0.035;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);
      const offset = index * 4;
      normalData[offset] = Math.round((nx / length * 0.5 + 0.5) * 255);
      normalData[offset + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      normalData[offset + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
      normalData[offset + 3] = 255;
    }
  }

  const create = (data: Uint8Array, colourSpace?: THREE.ColorSpace): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (colourSpace) texture.colorSpace = colourSpace;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    colour: create(colourData, THREE.SRGBColorSpace),
    normal: create(normalData),
    roughness: create(roughnessData),
  };
}
function pushRect(
  positions: number[], indices: number[],
  centerX: number, centerZ: number,
  minX: number, maxX: number, minZ: number, maxZ: number, y: number,
): void {
  if (maxX <= minX || maxZ <= minZ) return;
  const base = positions.length / 3;
  positions.push(
    minX - centerX, y, minZ - centerZ,
    maxX - centerX, y, minZ - centerZ,
    maxX - centerX, y, maxZ - centerZ,
    minX - centerX, y, maxZ - centerZ,
  );
  indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}
function setInstance(
  mesh: THREE.InstancedMesh, index: number,
  x: number, y: number, z: number,
  width: number, height: number, depth: number,
  colour?: THREE.Color,
): void {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion(),
    new THREE.Vector3(width, height, depth),
  );
  mesh.setMatrixAt(index, matrix);
  if (colour) mesh.setColorAt(index, colour);
}

/**
 * Fictional Manhattan-inspired city mesh/collision streamer. This class
 * deliberately creates independent geometry from the deterministic road
 * graph; the optional Google 3D Tiles layer is never queried for game meshes.
 */
export class NYCCityChunkManager {
  private readonly chunks = new Map<string, CityChunk>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly desired = new Set<string>();
  private readonly originOffset = new THREE.Vector3();
  private centerKey: string | null = null;
  private disposed = false;

  private readonly asphaltTextures = createAsphaltTextures();
  private readonly groundMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    side: THREE.DoubleSide, vertexColors: true,
  });
  private readonly roadMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: this.asphaltTextures.colour,
    normalMap: this.asphaltTextures.normal,
    normalScale: new THREE.Vector2(0.22, 0.22),
    roughnessMap: this.asphaltTextures.roughness,
    roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
  });
  private readonly sidewalkMaterial = new THREE.MeshStandardMaterial({
    color: 0x777c80, roughness: 0.96, side: THREE.DoubleSide,
  });
  private readonly lineMaterial = new THREE.MeshBasicMaterial({
    color: 0xe6e0d0, side: THREE.DoubleSide,
  });
  private readonly centreLineMaterial = new THREE.MeshBasicMaterial({
    color: 0xd5ac46, side: THREE.DoubleSide,
  });
  private readonly curbMaterial = new THREE.MeshStandardMaterial({
    color: 0xb1b3b1, roughness: 0.82,
  });
  private readonly buildingMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.76, metalness: 0.08,
  });
  private readonly storefrontMaterial = new THREE.MeshStandardMaterial({
    color: 0x263943, roughness: 0.24, metalness: 0.42,
    emissive: 0x10232d, emissiveIntensity: 0.18,
  });
  private readonly storefrontFrameMaterial = new THREE.MeshStandardMaterial({
    color: 0x252c31, roughness: 0.58, metalness: 0.72,
  });
  private readonly retailSignMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9b887, roughness: 0.7, metalness: 0.12,
    emissive: 0x3f2412, emissiveIntensity: 0.2,
  });
  private readonly windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x49616e, roughness: 0.3, metalness: 0.42,
    emissive: 0x152632, emissiveIntensity: 0.12,
  });
  private readonly rooftopMaterial = new THREE.MeshStandardMaterial({
    color: 0x555d61, roughness: 0.86, metalness: 0.18,
  });
  private readonly poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x343c41, roughness: 0.5, metalness: 0.62,
  });
  private readonly lampMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe0a8, emissive: 0xffbd70, emissiveIntensity: 0.25,
  });
  private readonly treeMaterial = new THREE.MeshStandardMaterial({ color: 0x42644f, roughness: 1 });
  private readonly treeTrunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x554438, roughness: 0.98, metalness: 0,
  });
  private readonly parkMaterial = new THREE.MeshStandardMaterial({
    color: 0x465b43, roughness: 1, metalness: 0,
  });
  private readonly bridgeConcreteMaterial = new THREE.MeshStandardMaterial({
    color: 0x777d80, roughness: 0.91, metalness: 0.03,
  });
  private readonly bridgeUndersideMaterial = new THREE.MeshStandardMaterial({
    color: 0x555d62, roughness: 0.96, side: THREE.DoubleSide,
  });
  private readonly bridgeBarrierMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8b9b5, roughness: 0.83, metalness: 0.04,
  });
  private readonly underpassMaterial = new THREE.MeshStandardMaterial({
    color: 0x343a3e, roughness: 0.92, metalness: 0.03, side: THREE.DoubleSide,
  });
  private readonly underpassLightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc77d, toneMapped: false,
  });
  private readonly bridgePierGeometry = new THREE.CylinderGeometry(0.7, 0.95, 1, 12);

  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly lampGeometry = new THREE.SphereGeometry(0.2, 8, 6);
  private readonly treeGeometry = new THREE.IcosahedronGeometry(1, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: RAPIER.World,
    readonly graph: CityRoadGraph,
    private readonly streetLoader: NYCStreetNetworkLoader | null = null,
    private readonly buildingLoader: NYCBuildingFootprintLoader | null = null,
  ) {
    this.scene.background = new THREE.Color(0x929fa6);
    this.scene.fog = new THREE.FogExp2(0x929fa6, 0.00085);
  }

  async initialize(playerPosition: THREE.Vector3): Promise<void> {
    const index = this.getChunkIndex(playerPosition);
    this.centerKey = this.key(index.x, index.z);
    this.updateDesired(index.x, index.z);
    await this.ensureChunk(index.x, index.z);
    this.scheduleNeighbours(index.x, index.z);
  }

  update(playerPosition: THREE.Vector3): void {
    if (this.disposed) return;
    const index = this.getChunkIndex(playerPosition);
    const nextKey = this.key(index.x, index.z);
    if (nextKey === this.centerKey) return;
    this.centerKey = nextKey;
    this.updateDesired(index.x, index.z);
    this.scheduleNeighbours(index.x, index.z);
  }

  reset(playerPosition: THREE.Vector3): void {
    this.update(playerPosition);
  }

  rebase(delta: THREE.Vector3): void {
    if (this.disposed || delta.lengthSq() === 0) return;
    this.originOffset.add(delta);
    for (const chunk of this.chunks.values()) {
      chunk.group.position.sub(delta);
      const p = chunk.body.translation();
      chunk.body.setTranslation({ x: p.x - delta.x, y: p.y - delta.y, z: p.z - delta.z }, true);
    }
  }

  setNightBlend(amount: number): void {
    const blend = THREE.MathUtils.clamp(amount, 0, 1);
    this.roadMaterial.emissive.setHex(0x101720);
    this.roadMaterial.emissiveIntensity = blend * 0.1;
    this.buildingMaterial.emissive.setHex(0x191b1c);
    this.buildingMaterial.emissiveIntensity = blend * 0.07;
    this.windowMaterial.emissiveIntensity = THREE.MathUtils.lerp(0.08, 0.55, blend);
    this.lampMaterial.emissiveIntensity = THREE.MathUtils.lerp(0.2, 2.0, blend);
    for (const chunk of this.chunks.values()) {
      for (const light of chunk.nightLights) {
        light.intensity = 22 * blend;
        light.visible = blend > 0.025;
      }
    }
  }

  /** Kept as a stable surface-sampling hook for reset/diagnostic callers. */
  sampleAtWorldZ(worldZ: number): { position: THREE.Vector3; tangent: THREE.Vector3; right: THREE.Vector3 } {
    return {
      position: new THREE.Vector3(0, 0, worldZ),
      tangent: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
    };
  }

  getDiagnostics(): {
    activeChunks: number;
    pendingChunks: number;
    buildings: number;
    buildingColliders: number;
    roadLines: number;
    environmentObjects: number;
  } {
    let buildings = 0;
    let buildingColliders = 0;
    let roadLines = 0;
    let environmentObjects = 0;
    for (const chunk of this.chunks.values()) {
      buildings += chunk.buildings;
      buildingColliders += chunk.buildingColliders;
      roadLines += chunk.roads;
      environmentObjects += chunk.environmentObjects;
    }
    return {
      activeChunks: this.chunks.size,
      pendingChunks: this.pending.size,
      buildings,
      buildingColliders,
      roadLines,
      environmentObjects,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chunk of this.chunks.values()) this.removeChunk(chunk);
    this.chunks.clear();
    this.pending.clear();
    this.desired.clear();
    for (const material of [
      this.groundMaterial, this.roadMaterial, this.sidewalkMaterial, this.lineMaterial, this.centreLineMaterial,
      this.curbMaterial, this.buildingMaterial, this.storefrontMaterial, this.storefrontFrameMaterial,
      this.retailSignMaterial, this.windowMaterial, this.rooftopMaterial,
      this.poleMaterial, this.lampMaterial, this.treeMaterial, this.treeTrunkMaterial, this.parkMaterial,
      this.bridgeConcreteMaterial, this.bridgeUndersideMaterial, this.bridgeBarrierMaterial,
      this.underpassMaterial, this.underpassLightMaterial,
    ]) material.dispose();
    this.asphaltTextures.colour.dispose();
    this.asphaltTextures.normal.dispose();
    this.asphaltTextures.roughness.dispose();
    this.bridgePierGeometry.dispose();
    this.unitBox.dispose();
    this.lampGeometry.dispose();
    this.treeGeometry.dispose();
  }

  private getLandIntervals(
    axis: 'x' | 'z',
    fixed: number,
    start: number,
    end: number,
  ): Array<[number, number]> {
    if (end <= start) return [];
    if (axis === 'x') {
      if (fixed < HUDSON_RIVER_MIN_Z || fixed > HUDSON_RIVER_MAX_Z) return [[start, end]];
      const westEdge = getHudsonWestBankX(fixed) - 2.5;
      const eastEdge = getHudsonEastBankX(fixed) + 2.5;
      const intervals: Array<[number, number]> = [];
      if (start < westEdge) intervals.push([start, Math.min(end, westEdge)]);
      if (end > eastEdge) intervals.push([Math.max(start, eastEdge), end]);
      return intervals.filter(([a, b]) => b - a > 1);
    }

    const step = 4;
    const intervals: Array<[number, number]> = [];
    let runStart: number | null = null;
    for (let station = start; station <= end + 1e-6; station += step) {
      const sample = Math.min(station, end);
      const land = !isHudsonWater(fixed, sample, 2.5);
      if (land && runStart === null) runStart = sample;
      if (!land && runStart !== null) {
        if (sample - runStart > 1) intervals.push([runStart, sample - 2.5]);
        runStart = null;
      }
      if (sample === end) break;
    }
    if (runStart !== null && end - runStart > 1) intervals.push([runStart, end]);
    return intervals.filter(([a, b]) => b - a > 1);
  }

  /**
   * Spatially coherent, low-amplitude urban topography. The smooth fade keeps
   * the graph-authored street grid level while block interiors follow broad
   * deterministic landform contours. This is generated terrain, not claimed
   * survey-grade New York elevation data.
   */
  private sampleTerrainHeight(worldX: number, worldZ: number): number {
    if (this.graph instanceof NYCGISRoadGraph) {
      // The currently integrated CSCL source is predominantly 2D. A flat
      // zero datum is explicit until a validated NYC DEM is added to the bake.
      return isHudsonWater(worldX, worldZ)
        ? -getHudsonRiverDepthM(worldX, worldZ) - 1.25 : 0;
    }
    if (isHudsonWater(worldX, worldZ)) {
      return -getHudsonRiverDepthM(worldX, worldZ) - 1.25;
    }
    const gridX = Math.round(worldX / CITY_BLOCK_SPACING_M);
    const gridZ = Math.round(worldZ / CITY_BLOCK_SPACING_M);
    const xRoadHalfWidth = this.graph.getRoadProfile('z', gridX).widthM * 0.5;
    const zRoadHalfWidth = this.graph.getRoadProfile('x', gridZ).widthM * 0.5;
    const xDistance = Math.abs(worldX - gridX * CITY_BLOCK_SPACING_M);
    const zDistance = Math.abs(worldZ - gridZ * CITY_BLOCK_SPACING_M);
    const xBlend = THREE.MathUtils.smoothstep(
      xDistance,
      xRoadHalfWidth + SIDEWALK_WIDTH_M + 2,
      64,
    );
    const zBlend = THREE.MathUtils.smoothstep(
      zDistance,
      zRoadHalfWidth + SIDEWALK_WIDTH_M + 2,
      64,
    );
    const blockBlend = Math.min(xBlend, zBlend);
    const elevation =
      1.4 * Math.sin(worldX / 560)
      + 1.05 * Math.cos(worldZ / 480)
      + 0.45 * Math.sin((worldX + worldZ) / 230);
    return -0.405 + elevation * blockBlend;
  }

  private getChunkIndex(position: THREE.Vector3): { x: number; z: number } {
    return {
      x: Math.floor((position.x + this.originOffset.x) / CITY_CHUNK_SIZE_M),
      z: Math.floor((position.z + this.originOffset.z) / CITY_CHUNK_SIZE_M),
    };
  }
  private key(x: number, z: number): string { return String(x) + ':' + String(z); }

  private updateDesired(cx: number, cz: number): void {
    this.desired.clear();
    for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) this.desired.add(this.key(cx + dx, cz + dz));
    }
    for (const [key, chunk] of this.chunks) {
      if (!this.desired.has(key)) {
        this.removeChunk(chunk);
        this.chunks.delete(key);
      }
    }
  }

  private scheduleNeighbours(cx: number, cz: number): void {
    const queue: Array<{ x: number; z: number; distance: number }> = [];
    for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue;
        queue.push({ x: cx + dx, z: cz + dz, distance: dx * dx + dz * dz });
      }
    }
    queue.sort((a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x);
    for (const item of queue) {
      void this.ensureChunk(item.x, item.z).catch((error: unknown) => {
        console.warn('City chunk build failed:', error);
      });
    }
  }

  private async ensureChunk(cx: number, cz: number): Promise<void> {
    const key = this.key(cx, cz);
    if (this.disposed || !this.desired.has(key) || this.chunks.has(key)) return;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const request = Promise.resolve().then(async () => {
      if (this.disposed || !this.desired.has(key) || this.chunks.has(key)) return;
      if (this.graph instanceof NYCGISRoadGraph) {
        if (!this.streetLoader) throw new Error('GIS chunk streaming requires NYC street tile loader.');
        const tiles = await this.streetLoader.loadTilesForBounds({
          minX: cx * CITY_CHUNK_SIZE_M - 24,
          maxX: (cx + 1) * CITY_CHUNK_SIZE_M + 24,
          minZ: cz * CITY_CHUNK_SIZE_M - 24,
          maxZ: (cz + 1) * CITY_CHUNK_SIZE_M + 24,
        });
        if (tiles.length === 0) {
          throw new Error('No authoritative NYC GIS tiles cover requested world chunk ' + key + '.');
        }
        this.graph.addTiles(tiles);
      }
      let buildingFootprints: NYCBuildingFootprint[] = [];
      if (this.graph instanceof NYCGISRoadGraph) {
        if (!this.buildingLoader) throw new Error('GIS world streaming requires NYC building footprint loader.');
        const buildingTiles = await this.buildingLoader.loadTilesForBounds({
          minX: cx * CITY_CHUNK_SIZE_M,
          maxX: (cx + 1) * CITY_CHUNK_SIZE_M,
          minZ: cz * CITY_CHUNK_SIZE_M,
          maxZ: (cz + 1) * CITY_CHUNK_SIZE_M,
        });
        if (buildingTiles.length === 0) {
          throw new Error('No authoritative NYC building tiles cover requested world chunk ' + key + '.');
        }
        buildingFootprints = buildingTiles.flatMap((tile) => tile.buildings);
      }
      if (this.disposed || !this.desired.has(key) || this.chunks.has(key)) return;
      const chunk = this.buildChunk(cx, cz, buildingFootprints);
      this.chunks.set(key, chunk);
      this.scene.add(chunk.group);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private buildChunk(
    cx: number,
    cz: number,
    buildingFootprints: NYCBuildingFootprint[] = [],
  ): CityChunk {
    const key = this.key(cx, cz);
    const centerX = (cx + 0.5) * CITY_CHUNK_SIZE_M;
    const centerZ = (cz + 0.5) * CITY_CHUNK_SIZE_M;
    const minX = cx * CITY_CHUNK_SIZE_M;
    const maxX = minX + CITY_CHUNK_SIZE_M;
    const minZ = cz * CITY_CHUNK_SIZE_M;
    const maxZ = minZ + CITY_CHUNK_SIZE_M;
    const group = new THREE.Group();
    group.name = 'nyc-gis-world-chunk-' + key;
    group.position.set(centerX - this.originOffset.x, -this.originOffset.y, centerZ - this.originOffset.z);

    const groundPositions: number[] = [], groundIndices: number[] = [];
    const groundColours: number[] = [];
    const roadPositions: number[] = [], roadIndices: number[] = [];
    const sidewalkPositions: number[] = [], sidewalkIndices: number[] = [];
    const whitePositions: number[] = [], whiteIndices: number[] = [];
    const yellowPositions: number[] = [], yellowIndices: number[] = [];
    const crosswalkPositions: number[] = [], crosswalkIndices: number[] = [];
    const curbs: CurbSpec[] = [];
    const roadLines = new Set<string>();
    const chunkBounds: RibbonBounds = { minX, maxX, minZ, maxZ };
    const elevatedRoadPositions: number[] = [], elevatedRoadIndices: number[] = [];
    const elevatedUndersidePositions: number[] = [], elevatedUndersideIndices: number[] = [];
    const elevatedWhitePositions: number[] = [], elevatedWhiteIndices: number[] = [];
    const elevatedYellowPositions: number[] = [], elevatedYellowIndices: number[] = [];
    const barrierSpecs: InstanceSpec[] = [];
    const pierSpecs: InstanceSpec[] = [];
    const capSpecs: InstanceSpec[] = [];

    // Deterministic heightfield: the mesh grid is aligned to world coordinates,
    // so adjacent streamed chunks share identical edge samples. Ground-road
    // corridors fade back to the established -0.405 m datum before the
    // surrounding block parcels rise and fall.
    const terrainStepM = 16;
    const terrainCells = Math.round(CITY_CHUNK_SIZE_M / terrainStepM);
    const terrainGrass = new THREE.Color(0x65715d);
    const terrainSoil = new THREE.Color(0x807666);
    const terrainColour = new THREE.Color();
    for (let gridZ = 0; gridZ <= terrainCells; gridZ++) {
      const worldZ = minZ + gridZ * terrainStepM;
      for (let gridX = 0; gridX <= terrainCells; gridX++) {
        const worldX = minX + gridX * terrainStepM;
        const height = this.sampleTerrainHeight(worldX, worldZ);
        groundPositions.push(worldX - centerX, height, worldZ - centerZ);

        const elevationTint = THREE.MathUtils.clamp((height + 0.405 + 1.1) / 5.5, 0, 0.42);
        const surfaceVariation = 0.95 + 0.05 * (
          0.5 + 0.5 * Math.sin(worldX * 0.031 + worldZ * 0.023)
        );
        terrainColour.copy(terrainGrass).lerp(terrainSoil, elevationTint)
          .multiplyScalar(surfaceVariation);
        groundColours.push(terrainColour.r, terrainColour.g, terrainColour.b);

        if (gridX < terrainCells && gridZ < terrainCells) {
          const a = gridZ * (terrainCells + 1) + gridX;
          const b = a + 1;
          const d = (gridZ + 1) * (terrainCells + 1) + gridX;
          const c = d + 1;
          groundIndices.push(a, c, b, a, d, c);
        }
      }
    }

    const firstX = Math.floor(minX / CITY_BLOCK_SPACING_M) - 1;
    const lastX = Math.ceil(maxX / CITY_BLOCK_SPACING_M) + 1;
    const firstZ = Math.floor(minZ / CITY_BLOCK_SPACING_M) - 1;
    const lastZ = Math.ceil(maxZ / CITY_BLOCK_SPACING_M) + 1;

    if (this.graph instanceof NYCGISRoadGraph) {
      const segments = this.graph.getSegmentsInBounds(minX - 8, maxX + 8, minZ - 8, maxZ + 8);
      for (const segment of segments) {
        roadLines.add(segment.id);
        const elevated = segment.roadType !== 'surface';
        if (elevated) {
          this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
            elevatedRoadPositions, elevatedRoadIndices, segment.profile.widthM, 0.035, 0);
          this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
            elevatedUndersidePositions, elevatedUndersideIndices, segment.profile.widthM, -1.2, 0);
        } else {
          this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
            roadPositions, roadIndices, segment.profile.widthM, 0.035, 0);
          for (const side of [-1, 1]) {
            this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
              sidewalkPositions, sidewalkIndices, 3.2, 0.12,
              side * (segment.profile.widthM * 0.5 + 2.0));
          }
        }
        if (segment.profile.directionality === 'both') {
          for (const offset of [-0.17, 0.17]) {
            this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
              yellowPositions, yellowIndices, 0.12, 0.065, offset);
          }
          for (const side of [-1, 1]) {
            for (let lane = 1; lane < segment.profile.lanesPerDirection; lane++) {
              const offset = side * (segment.profile.lanesPerDirection - lane)
                * segment.profile.laneWidthM;
              this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
                whitePositions, whiteIndices, 0.105, 0.065, offset);
            }
          }
        } else {
          for (let lane = 1; lane < segment.profile.lanesPerDirection; lane++) {
            const offset = (segment.profile.lanesPerDirection * 0.5 - lane)
              * segment.profile.laneWidthM;
            this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
              whitePositions, whiteIndices, 0.105, 0.065, offset);
          }
        }
        if (elevated) this.collectBridgeDetails(segment, chunkBounds, barrierSpecs, pierSpecs, capSpecs);
      }
    } else {
    for (let line = firstX; line <= lastX; line++) {
      const x = line * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('z', line);
      const half = profile.widthM * 0.5;
      if (x + half < minX - 1 || x - half > maxX + 1) continue;
      const landIntervals = this.getLandIntervals('z', x, minZ - 1, maxZ + 1);
      if (landIntervals.length > 0) roadLines.add('z:' + line);
      for (const [landStart, landEnd] of landIntervals) {
        pushRect(roadPositions, roadIndices, centerX, centerZ,
          x - half, x + half, landStart, landEnd, 0.012);
        for (let block = firstZ; block <= lastZ; block++) {
          const blockStart = block * CITY_BLOCK_SPACING_M;
          const blockEnd = blockStart + CITY_BLOCK_SPACING_M;
          const crossHalf = this.graph.getRoadProfile('x', block).widthM * 0.5;
          const segmentStart = Math.max(landStart, blockStart + crossHalf + 1);
          const segmentEnd = Math.min(landEnd, blockEnd - crossHalf - 1);
          if (segmentEnd <= segmentStart) continue;
          for (const side of [-1, 1]) {
            const near = half + 0.32;
            const far = half + SIDEWALK_WIDTH_M;
            pushRect(sidewalkPositions, sidewalkIndices, centerX, centerZ,
              Math.min(x + side * near, x + side * far), Math.max(x + side * near, x + side * far),
              segmentStart, segmentEnd, SIDEWALK_LIFT_M);
            curbs.push({
              x: x + side * (half + CURB_WIDTH_M * 0.5),
              z: (segmentStart + segmentEnd) * 0.5,
              length: segmentEnd - segmentStart,
              alongX: false,
            });
          }
        }
        this.addLineMarkings('z', x, landStart, landEnd, half, profile.lanesPerDirection,
          profile.directionality === 'both', centerX, centerZ,
          whitePositions, whiteIndices, yellowPositions, yellowIndices);
      }
    }

    for (let line = firstZ; line <= lastZ; line++) {
      const z = line * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('x', line);
      const half = profile.widthM * 0.5;
      if (z + half < minZ - 1 || z - half > maxZ + 1) continue;
      const landIntervals = this.getLandIntervals('x', z, minX - 1, maxX + 1);
      if (landIntervals.length > 0) roadLines.add('x:' + line);
      for (const [landStart, landEnd] of landIntervals) {
        pushRect(roadPositions, roadIndices, centerX, centerZ, landStart, landEnd,
          z - half, z + half, 0.014);
        for (let block = firstX; block <= lastX; block++) {
          const blockStart = block * CITY_BLOCK_SPACING_M;
          const blockEnd = blockStart + CITY_BLOCK_SPACING_M;
          const crossHalf = this.graph.getRoadProfile('z', block).widthM * 0.5;
          const segmentStart = Math.max(landStart, blockStart + crossHalf + 1);
          const segmentEnd = Math.min(landEnd, blockEnd - crossHalf - 1);
          if (segmentEnd <= segmentStart) continue;
          for (const side of [-1, 1]) {
            const near = half + 0.32;
            const far = half + SIDEWALK_WIDTH_M;
            pushRect(sidewalkPositions, sidewalkIndices, centerX, centerZ,
              segmentStart, segmentEnd,
              Math.min(z + side * near, z + side * far), Math.max(z + side * near, z + side * far),
              SIDEWALK_LIFT_M);
            curbs.push({
              x: (segmentStart + segmentEnd) * 0.5,
              z: z + side * (half + CURB_WIDTH_M * 0.5),
              length: segmentEnd - segmentStart,
              alongX: true,
            });
          }
        }
        this.addLineMarkings('x', z, landStart, landEnd, half, profile.lanesPerDirection,
          profile.directionality === 'both', centerX, centerZ,
          whitePositions, whiteIndices, yellowPositions, yellowIndices);
      }
    }

    if (!(this.graph instanceof NYCGISRoadGraph)) {
      this.addCrosswalks(firstX, lastX, firstZ, lastZ, centerX, centerZ, crosswalkPositions, crosswalkIndices);
    }

    }

    // Elevated decks and ramps are sampled from the authoritative graph. Each
    // chunk emits only the curve intervals whose centreline midpoint it owns.
    const specialSegments = this.graph instanceof NYCGISRoadGraph
      ? []
      : this.graph.getSpecialSegmentsInBounds(minX, maxX, minZ, maxZ);
    for (const segment of specialSegments) {
      this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
        elevatedRoadPositions, elevatedRoadIndices, segment.profile.widthM, 0, 0);
      this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
        elevatedUndersidePositions, elevatedUndersideIndices, segment.profile.widthM, -1.2, 0);
      if (segment.profile.directionality === 'both') {
        this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
          elevatedYellowPositions, elevatedYellowIndices, 0.12, 0.045, -0.17);
        this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
          elevatedYellowPositions, elevatedYellowIndices, 0.12, 0.045, 0.17);
      }
      for (const side of [-1, 1]) {
        for (let lane = 1; lane < segment.profile.lanesPerDirection; lane++) {
          this.appendRoadRibbon(segment, chunkBounds, centerX, centerZ,
            elevatedWhitePositions, elevatedWhiteIndices, 0.105, 0.05,
            side * lane * segment.profile.laneWidthM);
        }
      }
      this.collectBridgeDetails(segment, chunkBounds, barrierSpecs, pierSpecs, capSpecs);
    }

    const geometries: THREE.BufferGeometry[] = [];
    const groundGeometry = makeGeometry(groundPositions, groundIndices);
    if (groundGeometry) {
      groundGeometry.setAttribute('color', new THREE.Float32BufferAttribute(groundColours, 3));
      // Central-difference normals use global samples rather than one-sided
      // chunk-edge normals, avoiding lighting seams between streamed tiles.
      const terrainNormals = new Float32Array(groundPositions.length);
      const normal = new THREE.Vector3();
      for (let index = 0; index < groundPositions.length / 3; index++) {
        const gridX = index % (terrainCells + 1);
        const gridZ = Math.floor(index / (terrainCells + 1));
        const worldX = minX + gridX * terrainStepM;
        const worldZ = minZ + gridZ * terrainStepM;
        const gradientX = (
          this.sampleTerrainHeight(worldX + 1, worldZ)
          - this.sampleTerrainHeight(worldX - 1, worldZ)
        ) * 0.5;
        const gradientZ = (
          this.sampleTerrainHeight(worldX, worldZ + 1)
          - this.sampleTerrainHeight(worldX, worldZ - 1)
        ) * 0.5;
        normal.set(-gradientX, 1, -gradientZ).normalize();
        terrainNormals[index * 3] = normal.x;
        terrainNormals[index * 3 + 1] = normal.y;
        terrainNormals[index * 3 + 2] = normal.z;
      }
      groundGeometry.setAttribute('normal', new THREE.BufferAttribute(terrainNormals, 3));
    }
    const roadGeometry = makeGeometry(roadPositions, roadIndices);
    const sidewalkGeometry = makeGeometry(sidewalkPositions, sidewalkIndices);
    const whiteGeometry = makeGeometry(whitePositions, whiteIndices);
    const yellowGeometry = makeGeometry(yellowPositions, yellowIndices);
    const crosswalkGeometry = makeGeometry(crosswalkPositions, crosswalkIndices);
    const elevatedRoadGeometry = makeGeometry(elevatedRoadPositions, elevatedRoadIndices);
    const elevatedUndersideGeometry = makeGeometry(elevatedUndersidePositions, elevatedUndersideIndices);
    const elevatedWhiteGeometry = makeGeometry(elevatedWhitePositions, elevatedWhiteIndices);
    const elevatedYellowGeometry = makeGeometry(elevatedYellowPositions, elevatedYellowIndices);
    for (const [geometry, material, name] of [
      [groundGeometry, this.groundMaterial, 'terrain-heightfield'],
      [roadGeometry, this.roadMaterial, 'asphalt-road-network'],
      [sidewalkGeometry, this.sidewalkMaterial, 'raised-sidewalks'],
      [whiteGeometry, this.lineMaterial, 'lane-markings'],
      [yellowGeometry, this.centreLineMaterial, 'double-yellow-centrelines'],
      [crosswalkGeometry, this.lineMaterial, 'pedestrian-crossings'],
      [elevatedRoadGeometry, this.roadMaterial, 'elevated-highways-and-ramps'],
      [elevatedUndersideGeometry, this.bridgeUndersideMaterial, 'bridge-deck-undersides'],
      [elevatedWhiteGeometry, this.lineMaterial, 'elevated-lane-markings'],
      [elevatedYellowGeometry, this.centreLineMaterial, 'elevated-double-yellow-markings'],
    ] as Array<[THREE.BufferGeometry | null, THREE.Material, string]>) {
      if (!geometry) continue;
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    const buildingSpecs = this.graph instanceof NYCGISRoadGraph
      ? []
      : this.collectBuildings(minX, maxX, minZ, maxZ);
    const gisBuildingPositions: number[] = [];
    const gisBuildingIndices: number[] = [];
    if (this.graph instanceof NYCGISRoadGraph) {
      for (const building of buildingFootprints) {
        for (const polygon of building.polygons) {
          const outer = polygon[0];
          if (!outer || outer.length < 4) continue;
          const point2 = (point: { x: number; z: number }): [number, number] =>
            [point.x - centerX, -(point.z - centerZ)];
          const shape = new THREE.Shape();
          const first = point2(outer[0]);
          shape.moveTo(first[0], first[1]);
          for (let i = 1; i < outer.length - 1; i++) {
            const point = point2(outer[i]);
            shape.lineTo(point[0], point[1]);
          }
          shape.closePath();

          for (const ring of polygon.slice(1)) {
            if (ring.length < 4) continue;
            const hole = new THREE.Path();
            const holeFirst = point2(ring[0]);
            hole.moveTo(holeFirst[0], holeFirst[1]);
            for (let i = 1; i < ring.length - 1; i++) {
              const point = point2(ring[i]);
              hole.lineTo(point[0], point[1]);
            }
            hole.closePath();
            shape.holes.push(hole);
          }

          // HEIGHT_ROOF is authoritative where available. Missing values use
          // a feature-code median baked into the tile, with provenance preserved.
          // Buildings are placed on the same zero datum as current 2D CSCL roads;
          // GROUND_ELEVATION is retained but not applied until terrain DEM is loaded.
          const height = THREE.MathUtils.clamp(building.heightM, 2.5, 500);
          const extrusion = new THREE.ExtrudeGeometry(shape, {
            depth: height,
            bevelEnabled: false,
            steps: 1,
            curveSegments: 1,
          });
          extrusion.rotateX(-Math.PI / 2);
          const attribute = extrusion.getAttribute('position');
          const base = gisBuildingPositions.length / 3;
          for (let i = 0; i < attribute.count; i++) {
            gisBuildingPositions.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
          }
          const index = extrusion.getIndex();
          if (index) {
            for (let i = 0; i < index.count; i++) gisBuildingIndices.push(base + index.getX(i));
          } else {
            for (let i = 0; i < attribute.count; i++) gisBuildingIndices.push(base + i);
          }
          extrusion.dispose();
        }
      }
    }
    const gisBuildingGeometry = makeGeometry(gisBuildingPositions, gisBuildingIndices);
    if (gisBuildingGeometry) {
      geometries.push(gisBuildingGeometry);
      const mesh = new THREE.Mesh(gisBuildingGeometry, this.buildingMaterial);
      mesh.name = 'nyc-authoritative-building-footprints';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    // Neighbour footprints are indexed as well, so a prop generated at a chunk
    // edge cannot overlap a building owned by the adjacent streamed chunk.
    const nearbyBuildings = this.graph instanceof NYCGISRoadGraph
      ? []
      : this.collectBuildings(minX - 64, maxX + 64, minZ - 64, maxZ + 64);
    const propPlacementIndex = new CitySpatialIndex<string>(24);
    for (const building of nearbyBuildings) {
      propPlacementIndex.insert(
        'building:' + building.id,
        {
          minX: building.x - building.width * 0.5,
          maxX: building.x + building.width * 0.5,
          minZ: building.z - building.depth * 0.5,
          maxZ: building.z + building.depth * 0.5,
        },
        'building',
      );
    }
    const streetColliderSpecs: InstanceSpec[] = [];
    const nightLights: THREE.PointLight[] = [];
    const buildingMesh = new THREE.InstancedMesh(this.unitBox, this.buildingMaterial, buildingSpecs.length);
    const windows: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const storefronts: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const storefrontFrames: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const retailSigns: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const rooftops: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    for (let i = 0; i < buildingSpecs.length; i++) {
      const b = buildingSpecs[i];
      setInstance(buildingMesh, i, b.x - centerX, b.baseY + b.height * 0.5, b.z - centerZ, b.width, b.height, b.depth, b.colour);
      const floors = Math.min(25, Math.max(2, Math.floor(b.height / 3.6)));
      const colsX = Math.min(6, Math.max(2, Math.floor(b.width / 5)));
      const colsZ = Math.min(6, Math.max(2, Math.floor(b.depth / 5)));

      // Street-level shopfront glazing and sign bands are distinct from the
      // repeated upper-floor windows. These are attached to all four public
      // block faces, giving the sidewalk a readable ground-storey frontage.
      const shopPanelsX = Math.max(3, Math.floor(b.width / 12));
      const shopPanelsZ = Math.max(3, Math.floor(b.depth / 12));
      const shopWidthX = (b.width - 2.4) / shopPanelsX;
      const shopWidthZ = (b.depth - 2.4) / shopPanelsZ;
      for (let panel = 0; panel < shopPanelsX; panel++) {
        const x = b.x - centerX - b.width * 0.5 + 1.2 + (panel + 0.5) * shopWidthX;
        for (const side of [-1, 1]) {
          const z = b.z - centerZ + side * (b.depth * 0.5 + 0.055);
          storefronts.push({ x, y: 1.72 + b.baseY, z, w: shopWidthX - 0.55, h: 2.28, d: 0.09 });
          storefrontFrames.push({ x, y: 0.55 + b.baseY, z, w: shopWidthX - 0.3, h: 0.1, d: 0.16 });
          storefrontFrames.push({ x, y: 2.88 + b.baseY, z, w: shopWidthX - 0.3, h: 0.12, d: 0.16 });
        }
      }
      for (let panel = 0; panel < shopPanelsZ; panel++) {
        const z = b.z - centerZ - b.depth * 0.5 + 1.2 + (panel + 0.5) * shopWidthZ;
        for (const side of [-1, 1]) {
          const x = b.x - centerX + side * (b.width * 0.5 + 0.055);
          storefronts.push({ x, y: 1.72 + b.baseY, z, w: 0.09, h: 2.28, d: shopWidthZ - 0.55 });
          storefrontFrames.push({ x, y: 0.55 + b.baseY, z, w: 0.16, h: 0.1, d: shopWidthZ - 0.3 });
          storefrontFrames.push({ x, y: 2.88 + b.baseY, z, w: 0.16, h: 0.12, d: shopWidthZ - 0.3 });
        }
      }
      // A restrained continuous sign band gives each block a retail datum
      // without inventing copied brand names or storefront text.
      for (const side of [-1, 1]) {
        retailSigns.push({
          x: b.x - centerX, y: 3.18 + b.baseY,
          z: b.z - centerZ + side * (b.depth * 0.5 + 0.08),
          w: b.width * 0.72, h: 0.42, d: 0.12,
        });
        retailSigns.push({
          x: b.x - centerX + side * (b.width * 0.5 + 0.08), y: 3.18 + b.baseY,
          z: b.z - centerZ, w: 0.12, h: 0.42, d: b.depth * 0.72,
        });
      }

      for (let floor = 1; floor < floors; floor++) {
        const y = b.baseY + floor * 3.55;
        for (let col = 0; col < colsX; col++) {
          const x = b.x - centerX - b.width * 0.5 + (col + 0.5) * b.width / colsX;
          windows.push({ x, y, z: b.z - centerZ + b.depth * 0.5 + 0.045, w: 1.05, h: 1.25, d: 0.065 });
          windows.push({ x, y, z: b.z - centerZ - b.depth * 0.5 - 0.045, w: 1.05, h: 1.25, d: 0.065 });
        }
        for (let col = 0; col < colsZ; col++) {
          const z = b.z - centerZ - b.depth * 0.5 + (col + 0.5) * b.depth / colsZ;
          windows.push({ x: b.x - centerX + b.width * 0.5 + 0.045, y, z, w: 0.065, h: 1.25, d: 1.05 });
          windows.push({ x: b.x - centerX - b.width * 0.5 - 0.045, y, z, w: 0.065, h: 1.25, d: 1.05 });
        }
      }
      if (b.height > 48) {
        // Grouped rooftop plant reads as HVAC/utility equipment from street level.
        for (const unit of [-1, 0, 1]) rooftops.push({
          x: b.x - centerX + b.width * 0.12 + unit * Math.min(5, b.width * 0.13),
          y: b.baseY + b.height + 1.1,
          z: b.z - centerZ,
          w: Math.min(4.6, b.width * 0.2), h: 2.2, d: Math.min(4.8, b.depth * 0.18),
        });
        rooftops.push({
          x: b.x - centerX - b.width * 0.18, y: b.baseY + b.height + 4.1,
          z: b.z - centerZ + b.depth * 0.12, w: 0.24, h: 6.0, d: 0.24,
        });
      }
    }
    buildingMesh.name = 'fictional-city-buildings';
    buildingMesh.castShadow = true;
    buildingMesh.receiveShadow = true;
    if (buildingSpecs.length > 0) group.add(buildingMesh);

    if (storefronts.length > 0) {
      const mesh = new THREE.InstancedMesh(this.unitBox, this.storefrontMaterial, storefronts.length);
      for (let i = 0; i < storefronts.length; i++) {
        const pane = storefronts[i];
        setInstance(mesh, i, pane.x, pane.y, pane.z, pane.w, pane.h, pane.d);
      }
      mesh.name = 'street-level-retail-glazing';
      group.add(mesh);
    }
    if (storefrontFrames.length > 0) {
      const mesh = new THREE.InstancedMesh(this.unitBox, this.storefrontFrameMaterial, storefrontFrames.length);
      for (let i = 0; i < storefrontFrames.length; i++) {
        const frame = storefrontFrames[i];
        setInstance(mesh, i, frame.x, frame.y, frame.z, frame.w, frame.h, frame.d);
      }
      mesh.name = 'street-level-retail-frames';
      group.add(mesh);
    }
    if (retailSigns.length > 0) {
      const mesh = new THREE.InstancedMesh(this.unitBox, this.retailSignMaterial, retailSigns.length);
      for (let i = 0; i < retailSigns.length; i++) {
        const sign = retailSigns[i];
        setInstance(mesh, i, sign.x, sign.y, sign.z, sign.w, sign.h, sign.d);
      }
      mesh.name = 'street-level-retail-sign-bands';
      group.add(mesh);
    }

    if (windows.length > 0) {
      const mesh = new THREE.InstancedMesh(this.unitBox, this.windowMaterial, windows.length);
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        setInstance(mesh, i, w.x, w.y, w.z, w.w, w.h, w.d);
      }
      mesh.name = 'fictional-building-windows';
      group.add(mesh);
    }
    if (rooftops.length > 0) {
      const mesh = new THREE.InstancedMesh(this.unitBox, this.rooftopMaterial, rooftops.length);
      for (let i = 0; i < rooftops.length; i++) {
        const r = rooftops[i];
        setInstance(mesh, i, r.x, r.y, r.z, r.w, r.h, r.d);
      }
      group.add(mesh);
    }

    if (!(this.graph instanceof NYCGISRoadGraph)) {
      this.addStreetFurniture(
        group, centerX, centerZ, chunkBounds,
        propPlacementIndex, streetColliderSpecs, nightLights,
      );
    }
    this.addBridgeInstances(group, centerX, centerZ, barrierSpecs, pierSpecs, capSpecs);
    const hasUnderpassShell = !(this.graph instanceof NYCGISRoadGraph)
      && minX <= 0 && maxX > 0 && minZ <= 320 && maxZ > 320;
    if (hasUnderpassShell) this.addUnderpassShell(group, centerX, centerZ);

    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(group.position.x, group.position.y, group.position.z)
      .setCanSleep(true));
    // Visible base ground prevents the player and traffic from falling through
    // undeveloped block interiors; streets and sidewalks sit 0.4m above it.
    // The shallow foundation remains as a fail-safe below the heightfield;
    // the rendered terrain itself is the authoritative contact surface.
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(CITY_CHUNK_SIZE_M * 0.5, 0.18, CITY_CHUNK_SIZE_M * 0.5)
        .setTranslation(0, -4.585, 0).setFriction(0.78),
      body,
    );
    if (groundGeometry) this.addTrimeshCollider(body, groundGeometry, 0.84);
    if (roadGeometry) this.addTrimeshCollider(body, roadGeometry, 0.96);
    if (sidewalkGeometry) this.addTrimeshCollider(body, sidewalkGeometry, 0.82);
    if (gisBuildingGeometry) this.addTrimeshCollider(body, gisBuildingGeometry, 0.84);
    // Top and soffit collision surfaces are independent. The top catches
    // traffic on the deck; the lower surface only catches an over-height
    // vehicle passing below, never a normal ground-level vehicle.
    if (elevatedRoadGeometry) this.addTrimeshCollider(body, elevatedRoadGeometry, 0.96);
    if (elevatedUndersideGeometry) this.addTrimeshCollider(body, elevatedUndersideGeometry, 0.78);
    // Edge barriers are collidable as well as instanced visuals, so traffic
    // cannot leave the elevated deck or slide through ramp guardrails.
    for (const barrier of barrierSpecs) {
      const rotation = barrier.rotation;
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(
          barrier.scale.x * 0.5, barrier.scale.y * 0.5, barrier.scale.z * 0.5,
        )
          .setTranslation(
            barrier.position.x - centerX, barrier.position.y, barrier.position.z - centerZ,
          )
          .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
          .setFriction(0.82)
          .setRestitution(0),
        body,
      );
    }
    for (const pier of pierSpecs) {
      const height = pier.scale.y;
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(0.98, height * 0.5, 0.98)
          .setTranslation(pier.position.x - centerX, height * 0.5, pier.position.z - centerZ)
          .setFriction(0.82),
        body,
      );
    }
    for (const cap of capSpecs) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(cap.scale.x * 0.5, cap.scale.y * 0.5, cap.scale.z * 0.5)
          .setTranslation(cap.position.x - centerX, cap.position.y, cap.position.z - centerZ)
          .setFriction(0.82),
        body,
      );
    }
    if (hasUnderpassShell) this.addUnderpassColliders(body, centerX, centerZ);
    // Poles and tree trunks use the exact validated instance transforms; their
    // simplified static colliders therefore cannot drift from the visible props.
    for (const prop of streetColliderSpecs) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(
          prop.scale.x * 0.5, prop.scale.y * 0.5, prop.scale.z * 0.5,
        )
          .setTranslation(
            prop.position.x - centerX, prop.position.y, prop.position.z - centerZ,
          )
          .setFriction(0.72)
          .setRestitution(0),
        body,
      );
    }
    if (curbs.length > 0) {
      for (const curb of curbs) {
        const halfLength = curb.length * 0.5;
        const descriptor = curb.alongX
          ? RAPIER.ColliderDesc.cuboid(halfLength, CURB_HEIGHT_M * 0.5, CURB_WIDTH_M * 0.5)
          : RAPIER.ColliderDesc.cuboid(CURB_WIDTH_M * 0.5, CURB_HEIGHT_M * 0.5, halfLength);
        descriptor.setTranslation(curb.x - centerX, CURB_HEIGHT_M * 0.5, curb.z - centerZ).setFriction(0.72);
        this.physics.createCollider(descriptor, body);
      }
    }
    let buildingColliders = gisBuildingGeometry ? buildingFootprints.length : 0;
    for (const b of buildingSpecs) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(b.width * 0.5, b.height * 0.5, b.depth * 0.5)
          .setTranslation(b.x - centerX, b.baseY + b.height * 0.5, b.z - centerZ)
          .setFriction(0.78).setRestitution(0),
        body,
      );
      buildingColliders++;
    }
    if (buildingColliders !== buildingSpecs.length) {
      throw new Error('Building collision coverage mismatch in chunk ' + key);
    }

    buildingMesh.instanceMatrix.needsUpdate = true;
    group.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.InstancedMesh) object.instanceMatrix.needsUpdate = true;
    });

    return {
      key,
      group,
      body,
      geometries,
      buildings: this.graph instanceof NYCGISRoadGraph ? buildingFootprints.length : buildingSpecs.length,
      buildingColliders,
      roads: roadLines.size,
      environmentObjects: streetColliderSpecs.length,
      nightLights,
    };
  }

  private addTrimeshCollider(body: RAPIER.RigidBody, geometry: THREE.BufferGeometry, friction: number): void {
    const vertices = geometry.getAttribute('position').array as Float32Array;
    const indices = Uint32Array.from(geometry.getIndex()?.array ?? []);
    if (indices.length < 3) return;
    this.physics.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setFriction(friction).setRestitution(0),
      body,
    );
  }

  private appendRoadRibbon(
    segment: CityRoadSegment,
    bounds: RibbonBounds,
    centerX: number,
    centerZ: number,
    positions: number[],
    indices: number[],
    width: number,
    verticalOffset: number,
    lateralOffset: number,
  ): void {
    const sampleCount = Math.max(8, Math.ceil(segment.lengthM / 4));
    const samples: Array<{ left: THREE.Vector3; right: THREE.Vector3; center: THREE.Vector3 }> = [];
    for (let i = 0; i <= sampleCount; i++) {
      const distance = segment.lengthM * i / sampleCount;
      const pose = this.graph.getCenterlinePose(segment.id, distance);
      const center = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)
        .addScaledVector(new THREE.Vector3(pose.right.x, pose.right.y, pose.right.z), lateralOffset)
        .addScaledVector(new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z), verticalOffset);
      const right = new THREE.Vector3(pose.right.x, pose.right.y, pose.right.z);
      samples.push({
        center,
        left: center.clone().addScaledVector(right, -width * 0.5),
        right: center.clone().addScaledVector(right, width * 0.5),
      });
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const midX = (a.center.x + b.center.x) * 0.5;
      const midZ = (a.center.z + b.center.z) * 0.5;
      if (midX < bounds.minX || midX >= bounds.maxX || midZ < bounds.minZ || midZ >= bounds.maxZ) continue;
      const base = positions.length / 3;
      positions.push(
        a.left.x - centerX, a.left.y, a.left.z - centerZ,
        a.right.x - centerX, a.right.y, a.right.z - centerZ,
        b.left.x - centerX, b.left.y, b.left.z - centerZ,
        b.right.x - centerX, b.right.y, b.right.z - centerZ,
      );
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  /** Return the side of a highway deck occupied by a connected ramp. */
  private getHighwayRampBarrierSide(
    segment: CityRoadSegment,
    nodeId: string,
    endpointDistanceM: number,
  ): number | null {
    const deckPose = this.graph.getCenterlinePose(segment.id, endpointDistanceM);
    for (const edge of this.graph.getOutgoingEdges(nodeId)) {
      if (edge.segmentId === segment.id) continue;
      const ramp = this.graph.getSegment(edge.segmentId);
      if (ramp.roadType !== 'entrance-ramp' && ramp.roadType !== 'exit-ramp') continue;
      const rampPose = this.graph.getCenterlinePose(
        ramp.id, Math.min(40, ramp.lengthM), edge.direction,
      );
      const lateral = (rampPose.position.x - deckPose.position.x) * deckPose.right.x
        + (rampPose.position.y - deckPose.position.y) * deckPose.right.y
        + (rampPose.position.z - deckPose.position.z) * deckPose.right.z;
      if (Math.abs(lateral) > 0.75) return lateral > 0 ? 1 : -1;
    }
    return null;
  }

  /** Return the ramp-edge side facing an attached elevated carriageway. */
  private getRampHighwayBarrierSide(
    segment: CityRoadSegment,
    nodeId: string,
    endpointDistanceM: number,
  ): number | null {
    const rampSampleDistance = endpointDistanceM === 0
      ? Math.min(40, segment.lengthM)
      : Math.max(0, segment.lengthM - 40);
    const rampPose = this.graph.getCenterlinePose(segment.id, rampSampleDistance);
    for (const edge of this.graph.getOutgoingEdges(nodeId)) {
      if (edge.segmentId === segment.id) continue;
      const highway = this.graph.getSegment(edge.segmentId);
      if (highway.roadType !== 'elevated-highway') continue;
      const deckPose = this.graph.getCenterlinePose(highway.id, 0, edge.direction);
      const lateral = (deckPose.position.x - rampPose.position.x) * rampPose.right.x
        + (deckPose.position.y - rampPose.position.y) * rampPose.right.y
        + (deckPose.position.z - rampPose.position.z) * rampPose.right.z;
      if (Math.abs(lateral) > 0.75) return lateral > 0 ? 1 : -1;
    }
    return null;
  }

  private collectBridgeDetails(
    segment: CityRoadSegment,
    bounds: RibbonBounds,
    barriers: InstanceSpec[],
    piers: InstanceSpec[],
    caps: InstanceSpec[],
  ): void {
    if (segment.roadType === 'surface' || segment.roadType === 'underpass') return;
    const barrierRotation = new THREE.Quaternion();
    const barrierMatrix = new THREE.Matrix4();
    const barrierRight = new THREE.Vector3();
    const barrierUp = new THREE.Vector3();
    const barrierForward = new THREE.Vector3();
    const barrierCentre = new THREE.Vector3();
    const rampOpenings: Array<{ distanceM: number; side: number }> = [];
    const openingLengthM = 32;
    if (segment.roadType === 'elevated-highway') {
      const startSide = this.getHighwayRampBarrierSide(segment, segment.fromNodeId, 0);
      const endSide = this.getHighwayRampBarrierSide(segment, segment.toNodeId, segment.lengthM);
      if (startSide !== null) rampOpenings.push({ distanceM: 0, side: startSide });
      if (endSide !== null) rampOpenings.push({ distanceM: segment.lengthM, side: endSide });
    } else if (segment.roadType === 'entrance-ramp' || segment.roadType === 'exit-ramp') {
      const startSide = this.getRampHighwayBarrierSide(segment, segment.fromNodeId, 0);
      const endSide = this.getRampHighwayBarrierSide(segment, segment.toNodeId, segment.lengthM);
      if (startSide !== null) rampOpenings.push({ distanceM: 0, side: startSide });
      if (endSide !== null) rampOpenings.push({ distanceM: segment.lengthM, side: endSide });
    }
    for (let distance = 4; distance < segment.lengthM; distance += 8) {
      const pose = this.graph.getCenterlinePose(segment.id, distance);
      if (pose.position.x < bounds.minX || pose.position.x >= bounds.maxX
        || pose.position.z < bounds.minZ || pose.position.z >= bounds.maxZ) continue;
      barrierRight.set(pose.right.x, pose.right.y, pose.right.z).normalize();
      barrierUp.set(pose.up.x, pose.up.y, pose.up.z).normalize();
      barrierForward.set(pose.tangent.x, pose.tangent.y, pose.tangent.z).normalize();
      if (barrierForward.lengthSq() < 0.5) continue;
      barrierMatrix.makeBasis(barrierRight, barrierUp, barrierForward);
      barrierRotation.setFromRotationMatrix(barrierMatrix);
      for (const side of [-1, 1]) {
        const intersectsRampOpening = rampOpenings.some((opening) =>
          opening.side === side && Math.abs(distance - opening.distanceM) < openingLengthM);
        if (intersectsRampOpening) continue;
        const position = barrierCentre.set(pose.position.x, pose.position.y, pose.position.z)
          .addScaledVector(barrierRight, side * (segment.profile.widthM * 0.5 - 0.12))
          .addScaledVector(barrierUp, 0.56).clone();
        barriers.push({
          position,
          rotation: barrierRotation.clone(),
          scale: new THREE.Vector3(0.34, 1.12, 8.1),
        });
      }
    }

    if (segment.roadType !== 'elevated-highway') return;
    // Bents sit outside the carriageway and are omitted at street crossings.
    // A cross-head transfers deck loads to paired concrete piers.
    for (let distance = 32; distance < segment.lengthM; distance += 48) {
      const pose = this.graph.getCenterlinePose(segment.id, distance);
      if (pose.position.x < bounds.minX || pose.position.x >= bounds.maxX
        || pose.position.z < bounds.minZ || pose.position.z >= bounds.maxZ) continue;
      const nearestStreet = Math.round(pose.position.x / CITY_BLOCK_SPACING_M) * CITY_BLOCK_SPACING_M;
      if (Math.abs(pose.position.x - nearestStreet) < 23) continue;
      const undersideY = pose.position.y - 1.2;
      const pierHeight = Math.max(0, undersideY);
      if (pierHeight < 1.5) continue;
      for (const side of [-1, 1]) {
        const base = new THREE.Vector3(pose.position.x, 0, pose.position.z)
          .addScaledVector(new THREE.Vector3(pose.right.x, 0, pose.right.z),
            side * (segment.profile.widthM * 0.5 + 1.8));
        piers.push({
          position: new THREE.Vector3(base.x, pierHeight * 0.5, base.z),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(1.05, pierHeight, 1.05),
        });
      }
      caps.push({
        position: new THREE.Vector3(pose.position.x, undersideY - 0.42, pose.position.z),
        rotation: new THREE.Quaternion(),
        scale: new THREE.Vector3(1.9, 0.84, segment.profile.widthM + 4.4),
      });
    }
  }

  private addBridgeInstances(
    group: THREE.Group,
    centerX: number,
    centerZ: number,
    barriers: InstanceSpec[],
    piers: InstanceSpec[],
    caps: InstanceSpec[],
  ): void {
    const addInstances = (
      specs: InstanceSpec[],
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      name: string,
    ): void => {
      if (specs.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        matrix.compose(
          new THREE.Vector3(spec.position.x - centerX, spec.position.y, spec.position.z - centerZ),
          spec.rotation,
          spec.scale,
        );
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    addInstances(barriers, this.unitBox, this.bridgeBarrierMaterial, 'elevated-road-concrete-barriers');
    addInstances(piers, this.bridgePierGeometry, this.bridgeConcreteMaterial, 'expressway-concrete-piers');
    addInstances(caps, this.unitBox, this.bridgeConcreteMaterial, 'expressway-pier-cap-beams');
  }

  private addUnderpassShell(group: THREE.Group, centerX: number, centerZ: number): void {
    const halfWidth = this.graph.getRoadProfile('z', 0).widthM * 0.5 + 0.9;
    const fullWidth = halfWidth * 2;
    const addBox = (name: string, x: number, y: number, z: number,
      width: number, height: number, depth: number, material: THREE.Material): void => {
      const mesh = new THREE.Mesh(this.unitBox, material);
      mesh.name = name;
      mesh.position.set(x - centerX, y, z - centerZ);
      mesh.scale.set(width, height, depth);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    // A short concrete box underpass is aligned to the north/south street.
    // The bridge soffit is the overhead clearance surface; this liner provides
    // retaining walls, portal frames and low-intensity ceiling illumination.
    addBox('underpass-ceiling-liner', 0, 5.72, 320, fullWidth, 0.36, 80, this.underpassMaterial);
    // Retaining walls stop short of the at-grade crossing at z=320. The
    // transverse street stays open while the north/south underpass continues
    // beneath the deck; closing this gap would create an invisible roadblock.
    for (const [section, centreZ, length] of [
      ['north', 294, 28],
      ['south', 346, 28],
    ] as const) {
      addBox('underpass-west-retaining-wall-' + section, -halfWidth, 2.9, centreZ,
        0.65, 5.8, length, this.bridgeConcreteMaterial);
      addBox('underpass-east-retaining-wall-' + section, halfWidth, 2.9, centreZ,
        0.65, 5.8, length, this.bridgeConcreteMaterial);
    }
    addBox('underpass-north-portal-header', 0, 5.35, 280, fullWidth, 0.72, 0.8, this.bridgeConcreteMaterial);
    addBox('underpass-south-portal-header', 0, 5.35, 360, fullWidth, 0.72, 0.8, this.bridgeConcreteMaterial);
    for (let i = 0; i < 5; i++) {
      addBox('underpass-ceiling-luminaire-' + i, 0, 5.48, 292 + i * 14,
        1.2, 0.08, 0.34, this.underpassLightMaterial);
    }
  }

  private addUnderpassColliders(body: RAPIER.RigidBody, centerX: number, centerZ: number): void {
    const halfWidth = this.graph.getRoadProfile('z', 0).widthM * 0.5 + 0.9;
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(halfWidth, 0.18, 40)
        .setTranslation(-centerX, 5.72, 320 - centerZ).setFriction(0.65),
      body,
    );
    for (const side of [-1, 1]) {
      for (const wallCentreZ of [294, 346]) {
        this.physics.createCollider(
          RAPIER.ColliderDesc.cuboid(0.325, 2.9, 14)
            .setTranslation(side * halfWidth - centerX, 2.9, wallCentreZ - centerZ).setFriction(0.8),
          body,
        );
      }
    }
  }

  private addLineMarkings(
    axis: 'x' | 'z', fixed: number, minimum: number, maximum: number,
    halfWidth: number, lanes: number, twoWay: boolean, centerX: number, centerZ: number,
    whitePositions: number[], whiteIndices: number[],
    yellowPositions: number[], yellowIndices: number[],
  ): void {
    if (twoWay) for (const offset of [-0.17, 0.17]) {
      for (let along = Math.ceil(minimum / 12) * 12; along < maximum; along += 12) {
        if (Math.abs(along - Math.round(along / CITY_BLOCK_SPACING_M) * CITY_BLOCK_SPACING_M) < 14) continue;
        if (axis === 'z') pushRect(yellowPositions, yellowIndices, centerX, centerZ,
          fixed + offset - 0.055, fixed + offset + 0.055, along, along + 5, 0.035);
        else pushRect(yellowPositions, yellowIndices, centerX, centerZ,
          along, along + 5, fixed + offset - 0.055, fixed + offset + 0.055, 0.035);
      }
    }
    for (let lane = 1; lane < lanes * 2; lane++) {
      const offset = (lane - lanes) * 3.4;
      if (Math.abs(offset) < 0.45 || Math.abs(offset) > halfWidth - 0.4) continue;
      for (let along = Math.ceil(minimum / 15) * 15; along < maximum; along += 15) {
        if (Math.abs(along - Math.round(along / CITY_BLOCK_SPACING_M) * CITY_BLOCK_SPACING_M) < 14) continue;
        if (axis === 'z') pushRect(whitePositions, whiteIndices, centerX, centerZ,
          fixed + offset - 0.045, fixed + offset + 0.045, along, along + 5, 0.034);
        else pushRect(whitePositions, whiteIndices, centerX, centerZ,
          along, along + 5, fixed + offset - 0.045, fixed + offset + 0.045, 0.034);
      }
    }
  }

  private addCrosswalks(
    firstX: number, lastX: number, firstZ: number, lastZ: number,
    centerX: number, centerZ: number, positions: number[], indices: number[],
  ): void {
    for (let gx = firstX; gx <= lastX; gx++) {
      const x = gx * CITY_BLOCK_SPACING_M;
      const verticalHalf = this.graph.getRoadProfile('z', gx).widthM * 0.5;
      if (x < centerX - CITY_CHUNK_SIZE_M * 0.5 - 30 || x > centerX + CITY_CHUNK_SIZE_M * 0.5 + 30) continue;
      for (let gz = firstZ; gz <= lastZ; gz++) {
        const z = gz * CITY_BLOCK_SPACING_M;
        if (isHudsonWater(x, z)) continue;
        const horizontalHalf = this.graph.getRoadProfile('x', gz).widthM * 0.5;
        if (z < centerZ - CITY_CHUNK_SIZE_M * 0.5 - 30 || z > centerZ + CITY_CHUNK_SIZE_M * 0.5 + 30) continue;
        for (const side of [-1, 1]) {
          const crossZ = z + side * (horizontalHalf + 2.2);
          for (let stripe = -3; stripe <= 3; stripe++) {
            const stripeX = x + stripe * 1.35;
            pushRect(positions, indices, centerX, centerZ,
              stripeX - 0.38, stripeX + 0.38, crossZ - 2.3, crossZ + 2.3, 0.04);
          }
          const crossX = x + side * (verticalHalf + 2.2);
          for (let stripe = -3; stripe <= 3; stripe++) {
            const stripeZ = z + stripe * 1.35;
            pushRect(positions, indices, centerX, centerZ,
              crossX - 2.3, crossX + 2.3, stripeZ - 0.38, stripeZ + 0.38, 0.04);
          }
        }
      }
    }
  }

  private collectBuildings(minX: number, maxX: number, minZ: number, maxZ: number): BuildingSpec[] {
    const result: BuildingSpec[] = [];
    const firstGX = Math.floor(minX / CITY_BLOCK_SPACING_M);
    const lastGX = Math.ceil(maxX / CITY_BLOCK_SPACING_M);
    const firstGZ = Math.floor(minZ / CITY_BLOCK_SPACING_M);
    const lastGZ = Math.ceil(maxZ / CITY_BLOCK_SPACING_M);
    const rightOfWaySegments = this.graph.getSpecialSegmentsInBounds(
      minX - 80, maxX + 80, minZ - 80, maxZ + 80,
    ).filter((segment) => segment.roadType === 'elevated-highway'
      || segment.roadType === 'entrance-ramp' || segment.roadType === 'exit-ramp')
      .map((segment) => {
        const points = [segment.start, segment.end, ...(segment.controlPoints ?? [])];
        const margin = segment.profile.widthM * 0.5 + 1.5;
        return {
          minX: Math.min(...points.map((point) => point.x)) - margin,
          maxX: Math.max(...points.map((point) => point.x)) + margin,
          minZ: Math.min(...points.map((point) => point.z)) - margin,
          maxZ: Math.max(...points.map((point) => point.z)) + margin,
          minY: Math.min(...points.map((point) => point.y)),
          maxY: Math.max(...points.map((point) => point.y)),
        };
      });
    const footprints = new CitySpatialIndex<string>(32);

    for (let gx = firstGX; gx < lastGX; gx++) {
      for (let gz = firstGZ; gz < lastGZ; gz++) {
        const centreX = (gx + 0.5) * CITY_BLOCK_SPACING_M;
        const centreZ = (gz + 0.5) * CITY_BLOCK_SPACING_M;
        if (centreX < minX || centreX >= maxX || centreZ < minZ || centreZ >= maxZ) continue;

        const district = getCityDistrictProfile(centreX, centreZ);
        const eastBankX = getHudsonEastBankX(centreZ);
        if (isHudsonWater(centreX, centreZ)
          || (centreX > eastBankX && centreX < eastBankX + 300)) continue;
        if (isCityParkBlock(this.graph.seed, gx, gz, district)) continue;

        // Reserve the road, curb and sidewalk envelope on all four block edges.
        const xRoadHalf = Math.max(
          this.graph.getRoadProfile('z', gx).widthM,
          this.graph.getRoadProfile('z', gx + 1).widthM,
        ) * 0.5;
        const zRoadHalf = Math.max(
          this.graph.getRoadProfile('x', gz).widthM,
          this.graph.getRoadProfile('x', gz + 1).widthM,
        ) * 0.5;
        const halfWidth = 80 - xRoadHalf - SIDEWALK_WIDTH_M - 4;
        const halfDepth = 80 - zRoadHalf - SIDEWALK_WIDTH_M - 4;
        const parcels = createCityParcelLayout(
          this.graph.seed, gx, gz, halfWidth, halfDepth, district,
        );

        for (const parcel of parcels) {
          const value = citySpatialHash(gx * 7 + Number(parcel.id.split(':').at(-1)), gz * 11, this.graph.seed ^ 0x51f2);
          const style = value % district.palette.length;
          const shape = 0.78 + parcel.variation * 0.22;
          const height = district.minimumHeightM
            + Math.pow(parcel.variation, district.kind === 'financial' || district.kind === 'midtown' ? 0.72 : 1.18)
            * (district.maximumHeightM - district.minimumHeightM);
          const buildingX = centreX + parcel.offsetX;
          const buildingZ = centreZ + parcel.offsetZ;
          const width = parcel.width * shape;
          const depth = parcel.depth * shape;
          const buildingHeight = Math.min(220, height);
          const footprint: CityBounds2D = {
            minX: buildingX - width * 0.5,
            maxX: buildingX + width * 0.5,
            minZ: buildingZ - depth * 0.5,
            maxZ: buildingZ + depth * 0.5,
          };
          if (footprintTouchesHudson(
            footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ,
          )) continue;
          const intersectsElevatedRightOfWay = rightOfWaySegments.some((road) =>
            road.maxY > 0.25 && road.minY < buildingHeight + 0.5
            && road.maxX >= footprint.minX && road.minX <= footprint.maxX
            && road.maxZ >= footprint.minZ && road.minZ <= footprint.maxZ);
          if (intersectsElevatedRightOfWay
            || !isAabbClearOfRoadNetwork(footprint, this.graph, 0.75)
            || footprints.query(footprint).length > 0) continue;

          const id = parcel.id;
          footprints.insert(id, footprint, 'building');
          result.push({
            id,
            x: buildingX,
            z: buildingZ,
            width,
            depth,
            height: buildingHeight,
            baseY: this.sampleTerrainHeight(buildingX, buildingZ),
            colour: new THREE.Color(district.palette[style]),
          });
        }
      }
    }
    return result;
  }

  private addStreetFurniture(
    group: THREE.Group,
    centerX: number,
    centerZ: number,
    chunkBounds: RibbonBounds,
    placementIndex: CitySpatialIndex<string>,
    colliderSpecs: InstanceSpec[],
    nightLights: THREE.PointLight[],
  ): void {
    const poleSpecs: InstanceSpec[] = [];
    const parkSpecs: Array<{ x: number; z: number; width: number; depth: number; y: number }> = [];
    const treeSpecs: Array<{ x: number; z: number; y: number; scale: number }> = [];

    const reserve = (id: string, x: number, z: number, radius: number, kind: string): CityBounds2D | null => {
      const bounds: CityBounds2D = {
        minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius,
      };
      if (footprintTouchesHudson(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ)) return null;
      if (!isAabbClearOfRoadNetwork(bounds, this.graph, 0.15)) return null;
      if (placementIndex.query(bounds).length > 0) return null;
      placementIndex.insert(id, bounds, kind);
      return bounds;
    };

    // Streetlights are anchored to graph road edges and mid-block stations.
    // Their bases sit within the sidewalk envelope, never at arbitrary chunk offsets.
    const firstGridX = Math.floor(chunkBounds.minX / CITY_BLOCK_SPACING_M) - 1;
    const lastGridX = Math.ceil(chunkBounds.maxX / CITY_BLOCK_SPACING_M) + 1;
    const firstGridZ = Math.floor(chunkBounds.minZ / CITY_BLOCK_SPACING_M) - 1;
    const lastGridZ = Math.ceil(chunkBounds.maxZ / CITY_BLOCK_SPACING_M) + 1;
    for (let gx = firstGridX; gx <= lastGridX; gx++) {
      const roadX = gx * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('z', gx);
      for (let gz = firstGridZ; gz < lastGridZ; gz++) {
        const alongZ = (gz + 0.5) * CITY_BLOCK_SPACING_M;
        const side = (citySpatialHash(gx, gz, this.graph.seed ^ 0x6a71) & 1) === 0 ? -1 : 1;
        const x = roadX + side * (profile.widthM * 0.5 + SIDEWALK_WIDTH_M * 0.56);
        if (x < chunkBounds.minX || x >= chunkBounds.maxX
          || alongZ < chunkBounds.minZ || alongZ >= chunkBounds.maxZ) continue;
        if (!reserve('lamp:x:' + gx + ':' + gz, x, alongZ, 0.42, 'streetlight')) continue;
        const groundY = this.sampleTerrainHeight(x, alongZ);
        poleSpecs.push({
          position: new THREE.Vector3(x, groundY + 3.1, alongZ),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(0.15, 6.2, 0.15),
        });
        if ((citySpatialHash(gx, gz, this.graph.seed ^ 0x31a) % 4) === 0) {
          const light = new THREE.PointLight(0xffd2a0, 0, 30, 2);
          light.name = 'streetlight-point-source';
          light.position.set(x - centerX, groundY + 5.85, alongZ - centerZ);
          light.visible = false;
          group.add(light);
          nightLights.push(light);
        }
      }
    }
    for (let gz = firstGridZ; gz <= lastGridZ; gz++) {
      const roadZ = gz * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('x', gz);
      for (let gx = firstGridX; gx < lastGridX; gx++) {
        const alongX = (gx + 0.5) * CITY_BLOCK_SPACING_M;
        const side = (citySpatialHash(gx, gz, this.graph.seed ^ 0x7b91) & 1) === 0 ? -1 : 1;
        const z = roadZ + side * (profile.widthM * 0.5 + SIDEWALK_WIDTH_M * 0.56);
        if (alongX < chunkBounds.minX || alongX >= chunkBounds.maxX
          || z < chunkBounds.minZ || z >= chunkBounds.maxZ) continue;
        if (!reserve('lamp:z:' + gx + ':' + gz, alongX, z, 0.42, 'streetlight')) continue;
        const groundY = this.sampleTerrainHeight(alongX, z);
        poleSpecs.push({
          position: new THREE.Vector3(alongX, groundY + 3.1, z),
          rotation: new THREE.Quaternion(),
          scale: new THREE.Vector3(0.15, 6.2, 0.15),
        });
        if ((citySpatialHash(gx, gz, this.graph.seed ^ 0x31a) % 4) === 0) {
          const light = new THREE.PointLight(0xffd2a0, 0, 30, 2);
          light.name = 'streetlight-point-source';
          light.position.set(alongX - centerX, groundY + 5.85, z - centerZ);
          light.visible = false;
          group.add(light);
          nightLights.push(light);
        }
      }
    }

    if (poleSpecs.length > 0) {
      const poles = new THREE.InstancedMesh(this.unitBox, this.poleMaterial, poleSpecs.length);
      const lamps = new THREE.InstancedMesh(this.lampGeometry, this.lampMaterial, poleSpecs.length);
      for (let i = 0; i < poleSpecs.length; i++) {
        const pole = poleSpecs[i];
        setInstance(poles, i,
          pole.position.x - centerX, pole.position.y, pole.position.z - centerZ,
          pole.scale.x, pole.scale.y, pole.scale.z);
        setInstance(lamps, i,
          pole.position.x - centerX, pole.position.y + 3.15, pole.position.z - centerZ,
          0.42, 0.24, 0.42);
        colliderSpecs.push(pole);
      }
      poles.name = 'graph-aligned-streetlight-poles';
      lamps.name = 'graph-aligned-streetlight-emissive-lamps';
      poles.castShadow = true;
      group.add(poles, lamps);
    }

    // Park blocks are open parcels selected by stable district rules. Trees are
    // confined to those reserved green-space footprints, with trunk colliders.
    for (let gx = firstGridX; gx < lastGridX; gx++) {
      const blockCentreX = (gx + 0.5) * CITY_BLOCK_SPACING_M;
      for (let gz = firstGridZ; gz < lastGridZ; gz++) {
        const blockCentreZ = (gz + 0.5) * CITY_BLOCK_SPACING_M;
        if (blockCentreX < chunkBounds.minX || blockCentreX >= chunkBounds.maxX
          || blockCentreZ < chunkBounds.minZ || blockCentreZ >= chunkBounds.maxZ) continue;
        const district = getCityDistrictProfile(blockCentreX, blockCentreZ);
        if (!isCityParkBlock(this.graph.seed, gx, gz, district)) continue;
        const halfX = 80
          - Math.max(this.graph.getRoadProfile('z', gx).widthM, this.graph.getRoadProfile('z', gx + 1).widthM) * 0.5
          - SIDEWALK_WIDTH_M - 4;
        const halfZ = 80
          - Math.max(this.graph.getRoadProfile('x', gz).widthM, this.graph.getRoadProfile('x', gz + 1).widthM) * 0.5
          - SIDEWALK_WIDTH_M - 4;
        if (halfX < 12 || halfZ < 12) continue;
        const parkBounds: CityBounds2D = {
          minX: blockCentreX - halfX, maxX: blockCentreX + halfX,
          minZ: blockCentreZ - halfZ, maxZ: blockCentreZ + halfZ,
        };
        if (!isAabbClearOfRoadNetwork(parkBounds, this.graph, 1)) continue;
        parkSpecs.push({
          x: blockCentreX - centerX,
          z: blockCentreZ - centerZ,
          width: halfX * 2,
          depth: halfZ * 2,
          y: this.sampleTerrainHeight(blockCentreX, blockCentreZ) + 0.025,
        });
        for (let tree = 0; tree < 3; tree++) {
          const value = citySpatialHash(gx * 17 + tree, gz * 23 - tree, this.graph.seed ^ 0x8c31);
          const x = blockCentreX + ((value & 0xff) / 255 - 0.5) * halfX * 1.15;
          const z = blockCentreZ + (((value >>> 8) & 0xff) / 255 - 0.5) * halfZ * 1.15;
          const radius = 0.55;
          if (!reserve('tree:' + gx + ':' + gz + ':' + tree, x, z, radius, 'tree')) continue;
          const y = this.sampleTerrainHeight(x, z);
          const scale = 0.82 + ((value >>> 16) & 0xff) / 255 * 0.45;
          treeSpecs.push({ x: x - centerX, z: z - centerZ, y, scale });
          colliderSpecs.push({
            position: new THREE.Vector3(x, y + 1.35 * scale, z),
            rotation: new THREE.Quaternion(),
            scale: new THREE.Vector3(0.34 * scale, 2.7 * scale, 0.34 * scale),
          });
        }
      }
    }
    if (parkSpecs.length > 0) {
      const parks = new THREE.InstancedMesh(this.unitBox, this.parkMaterial, parkSpecs.length);
      for (let i = 0; i < parkSpecs.length; i++) {
        const park = parkSpecs[i];
        setInstance(parks, i, park.x, park.y, park.z, park.width, 0.05, park.depth);
      }
      parks.name = 'district-park-green-space';
      parks.receiveShadow = true;
      group.add(parks);
    }
    if (treeSpecs.length > 0) {
      const trees = new THREE.InstancedMesh(this.treeGeometry, this.treeMaterial, treeSpecs.length);
      const treeTrunks = new THREE.InstancedMesh(this.unitBox, this.treeTrunkMaterial, treeSpecs.length);
      for (let i = 0; i < treeSpecs.length; i++) {
        const tree = treeSpecs[i];
        setInstance(trees, i, tree.x, tree.y + 3.05 * tree.scale, tree.z,
          2.65 * tree.scale, 3.2 * tree.scale, 2.65 * tree.scale);
        setInstance(treeTrunks, i, tree.x, tree.y + 1.35 * tree.scale, tree.z,
          0.34 * tree.scale, 2.7 * tree.scale, 0.34 * tree.scale);
      }
      trees.name = 'park-tree-foliage';
      treeTrunks.name = 'park-tree-trunks';
      trees.castShadow = true;
      treeTrunks.castShadow = true;
      group.add(trees, treeTrunks);
    }
  }

  private removeChunk(chunk: CityChunk): void {
    this.scene.remove(chunk.group);
    this.physics.removeRigidBody(chunk.body);
    for (const geometry of chunk.geometries) geometry.dispose();
  }
}
