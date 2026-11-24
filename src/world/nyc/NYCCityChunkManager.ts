import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY_BLOCK_SPACING_M,
  CITY_CHUNK_SIZE_M,
  CityRoadGraph,
} from './CityRoadGraph';
import type { CityRoadSegment } from './CityRoadGraph';

interface CityChunk {
  key: string;
  group: THREE.Group;
  body: RAPIER.RigidBody;
  geometries: THREE.BufferGeometry[];
  buildings: number;
  roads: number;
}
interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
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
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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
function colourForBuilding(style: number): THREE.Color {
  const colours = [0x627985, 0x8b6556, 0xaaa69d, 0x765447, 0x59656a, 0x8b8b82];
  return new THREE.Color(colours[style % colours.length]);
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

  private readonly groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x66705e, roughness: 1, metalness: 0, side: THREE.DoubleSide,
  });
  private readonly roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x292e33, roughness: 0.94, metalness: 0.02, side: THREE.DoubleSide,
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
  }

  /** Kept as a stable surface-sampling hook for reset/diagnostic callers. */
  sampleAtWorldZ(worldZ: number): { position: THREE.Vector3; tangent: THREE.Vector3; right: THREE.Vector3 } {
    return {
      position: new THREE.Vector3(0, 0, worldZ),
      tangent: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
    };
  }

  getDiagnostics(): { activeChunks: number; pendingChunks: number; buildings: number; roadLines: number } {
    let buildings = 0;
    let roadLines = 0;
    for (const chunk of this.chunks.values()) {
      buildings += chunk.buildings;
      roadLines += chunk.roads;
    }
    return { activeChunks: this.chunks.size, pendingChunks: this.pending.size, buildings, roadLines };
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
      this.poleMaterial, this.lampMaterial, this.treeMaterial,
      this.bridgeConcreteMaterial, this.bridgeUndersideMaterial, this.bridgeBarrierMaterial,
      this.underpassMaterial, this.underpassLightMaterial,
    ]) material.dispose();
    this.bridgePierGeometry.dispose();
    this.unitBox.dispose();
    this.lampGeometry.dispose();
    this.treeGeometry.dispose();
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
    const request = Promise.resolve().then(() => {
      if (this.disposed || !this.desired.has(key) || this.chunks.has(key)) return;
      const chunk = this.buildChunk(cx, cz);
      this.chunks.set(key, chunk);
      this.scene.add(chunk.group);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private buildChunk(cx: number, cz: number): CityChunk {
    const key = this.key(cx, cz);
    const centerX = (cx + 0.5) * CITY_CHUNK_SIZE_M;
    const centerZ = (cz + 0.5) * CITY_CHUNK_SIZE_M;
    const minX = cx * CITY_CHUNK_SIZE_M;
    const maxX = minX + CITY_CHUNK_SIZE_M;
    const minZ = cz * CITY_CHUNK_SIZE_M;
    const maxZ = minZ + CITY_CHUNK_SIZE_M;
    const group = new THREE.Group();
    group.name = 'fictional-city-chunk-' + key;
    group.position.set(centerX - this.originOffset.x, -this.originOffset.y, centerZ - this.originOffset.z);

    const groundPositions: number[] = [], groundIndices: number[] = [];
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

    pushRect(groundPositions, groundIndices, centerX, centerZ,
      minX, maxX, minZ, maxZ, -0.405);

    const firstX = Math.floor(minX / CITY_BLOCK_SPACING_M) - 1;
    const lastX = Math.ceil(maxX / CITY_BLOCK_SPACING_M) + 1;
    const firstZ = Math.floor(minZ / CITY_BLOCK_SPACING_M) - 1;
    const lastZ = Math.ceil(maxZ / CITY_BLOCK_SPACING_M) + 1;

    for (let line = firstX; line <= lastX; line++) {
      const x = line * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('z', line);
      const half = profile.widthM * 0.5;
      if (x + half < minX - 1 || x - half > maxX + 1) continue;
      pushRect(roadPositions, roadIndices, centerX, centerZ, x - half, x + half, minZ - 1, maxZ + 1, 0.012);
      roadLines.add('z:' + line);
      for (let block = firstZ; block <= lastZ; block++) {
        const blockStart = block * CITY_BLOCK_SPACING_M;
        const blockEnd = blockStart + CITY_BLOCK_SPACING_M;
        const crossHalf = this.graph.getRoadProfile('x', block).widthM * 0.5;
        const segmentStart = Math.max(minZ, blockStart + crossHalf + 1);
        const segmentEnd = Math.min(maxZ, blockEnd - crossHalf - 1);
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
      this.addLineMarkings('z', x, minZ, maxZ, half, profile.lanesPerDirection,
        profile.directionality === 'both', centerX, centerZ,
        whitePositions, whiteIndices, yellowPositions, yellowIndices);
    }

    for (let line = firstZ; line <= lastZ; line++) {
      const z = line * CITY_BLOCK_SPACING_M;
      const profile = this.graph.getRoadProfile('x', line);
      const half = profile.widthM * 0.5;
      if (z + half < minZ - 1 || z - half > maxZ + 1) continue;
      pushRect(roadPositions, roadIndices, centerX, centerZ, minX - 1, maxX + 1, z - half, z + half, 0.014);
      roadLines.add('x:' + line);
      for (let block = firstX; block <= lastX; block++) {
        const blockStart = block * CITY_BLOCK_SPACING_M;
        const blockEnd = blockStart + CITY_BLOCK_SPACING_M;
        const crossHalf = this.graph.getRoadProfile('z', block).widthM * 0.5;
        const segmentStart = Math.max(minX, blockStart + crossHalf + 1);
        const segmentEnd = Math.min(maxX, blockEnd - crossHalf - 1);
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
      this.addLineMarkings('x', z, minX, maxX, half, profile.lanesPerDirection,
        profile.directionality === 'both', centerX, centerZ,
        whitePositions, whiteIndices, yellowPositions, yellowIndices);
    }

    this.addCrosswalks(firstX, lastX, firstZ, lastZ, centerX, centerZ, crosswalkPositions, crosswalkIndices);

    // Elevated decks and ramps are sampled from the authoritative graph. Each
    // chunk emits only the curve intervals whose centreline midpoint it owns.
    const specialSegments = this.graph.getSpecialSegmentsInBounds(minX, maxX, minZ, maxZ);
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
      [groundGeometry, this.groundMaterial, 'visible-city-block-ground'],
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

    const buildingSpecs = this.collectBuildings(minX, maxX, minZ, maxZ);
    const buildingMesh = new THREE.InstancedMesh(this.unitBox, this.buildingMaterial, buildingSpecs.length);
    const windows: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const storefronts: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const storefrontFrames: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const retailSigns: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const rooftops: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    for (let i = 0; i < buildingSpecs.length; i++) {
      const b = buildingSpecs[i];
      setInstance(buildingMesh, i, b.x - centerX, b.height * 0.5, b.z - centerZ, b.width, b.height, b.depth, b.colour);
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
          storefronts.push({ x, y: 1.72, z, w: shopWidthX - 0.55, h: 2.28, d: 0.09 });
          storefrontFrames.push({ x, y: 0.55, z, w: shopWidthX - 0.3, h: 0.1, d: 0.16 });
          storefrontFrames.push({ x, y: 2.88, z, w: shopWidthX - 0.3, h: 0.12, d: 0.16 });
        }
      }
      for (let panel = 0; panel < shopPanelsZ; panel++) {
        const z = b.z - centerZ - b.depth * 0.5 + 1.2 + (panel + 0.5) * shopWidthZ;
        for (const side of [-1, 1]) {
          const x = b.x - centerX + side * (b.width * 0.5 + 0.055);
          storefronts.push({ x, y: 1.72, z, w: 0.09, h: 2.28, d: shopWidthZ - 0.55 });
          storefrontFrames.push({ x, y: 0.55, z, w: 0.16, h: 0.1, d: shopWidthZ - 0.3 });
          storefrontFrames.push({ x, y: 2.88, z, w: 0.16, h: 0.12, d: shopWidthZ - 0.3 });
        }
      }
      // A restrained continuous sign band gives each block a retail datum
      // without inventing copied brand names or storefront text.
      for (const side of [-1, 1]) {
        retailSigns.push({
          x: b.x - centerX, y: 3.18,
          z: b.z - centerZ + side * (b.depth * 0.5 + 0.08),
          w: b.width * 0.72, h: 0.42, d: 0.12,
        });
        retailSigns.push({
          x: b.x - centerX + side * (b.width * 0.5 + 0.08), y: 3.18,
          z: b.z - centerZ, w: 0.12, h: 0.42, d: b.depth * 0.72,
        });
      }

      for (let floor = 1; floor < floors; floor++) {
        const y = floor * 3.55;
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
          y: b.height + 1.1,
          z: b.z - centerZ,
          w: Math.min(4.6, b.width * 0.2), h: 2.2, d: Math.min(4.8, b.depth * 0.18),
        });
        rooftops.push({
          x: b.x - centerX - b.width * 0.18, y: b.height + 4.1,
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

    this.addStreetFurniture(group, cx, cz);
    this.addBridgeInstances(group, centerX, centerZ, barrierSpecs, pierSpecs, capSpecs);
    const hasUnderpassShell = minX <= 0 && maxX > 0 && minZ <= 320 && maxZ > 320;
    if (hasUnderpassShell) this.addUnderpassShell(group, centerX, centerZ);

    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(group.position.x, group.position.y, group.position.z)
      .setCanSleep(true));
    // Visible base ground prevents the player and traffic from falling through
    // undeveloped block interiors; streets and sidewalks sit 0.4m above it.
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(CITY_CHUNK_SIZE_M * 0.5, 0.18, CITY_CHUNK_SIZE_M * 0.5)
        .setTranslation(0, -0.585, 0).setFriction(0.78),
      body,
    );
    if (roadGeometry) this.addTrimeshCollider(body, roadGeometry, 0.96);
    if (sidewalkGeometry) this.addTrimeshCollider(body, sidewalkGeometry, 0.82);
    // Top and soffit collision surfaces are independent. The top catches
    // traffic on the deck; the lower surface only catches an over-height
    // vehicle passing below, never a normal ground-level vehicle.
    if (elevatedRoadGeometry) this.addTrimeshCollider(body, elevatedRoadGeometry, 0.96);
    if (elevatedUndersideGeometry) this.addTrimeshCollider(body, elevatedUndersideGeometry, 0.78);
    for (const pier of pierSpecs) {
      const height = pier.scale.y;
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(pier.scale.x * 0.5, height * 0.5, pier.scale.z * 0.5)
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
    for (const b of buildingSpecs) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(b.width * 0.5, b.height * 0.5, b.depth * 0.5)
          .setTranslation(b.x - centerX, b.height * 0.5, b.z - centerZ)
          .setFriction(0.78).setRestitution(0),
        body,
      );
    }

    buildingMesh.instanceMatrix.needsUpdate = true;
    group.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.InstancedMesh) object.instanceMatrix.needsUpdate = true;
    });

    return { key, group, body, geometries, buildings: buildingSpecs.length, roads: roadLines.size };
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

  private collectBridgeDetails(
    segment: CityRoadSegment,
    bounds: RibbonBounds,
    barriers: InstanceSpec[],
    piers: InstanceSpec[],
    caps: InstanceSpec[],
  ): void {
    if (segment.roadType === 'surface' || segment.roadType === 'underpass') return;
    const forward = new THREE.Vector3(0, 0, 1);
    const barrierRotation = new THREE.Quaternion();
    for (let distance = 4; distance < segment.lengthM; distance += 8) {
      const pose = this.graph.getCenterlinePose(segment.id, distance);
      if (pose.position.x < bounds.minX || pose.position.x >= bounds.maxX
        || pose.position.z < bounds.minZ || pose.position.z >= bounds.maxZ) continue;
      const tangent = new THREE.Vector3(pose.tangent.x, 0, pose.tangent.z).normalize();
      if (tangent.lengthSq() < 0.5) continue;
      barrierRotation.setFromUnitVectors(forward, tangent);
      for (const side of [-1, 1]) {
        const position = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)
          .addScaledVector(new THREE.Vector3(pose.right.x, pose.right.y, pose.right.z),
            side * (segment.profile.widthM * 0.5 - 0.12))
          .addScaledVector(new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z), 0.56);
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
    addBox('underpass-ceiling-liner', 0, 5.72, 320, 20.4, 0.36, 80, this.underpassMaterial);
    addBox('underpass-west-retaining-wall', -10.2, 2.9, 320, 0.65, 5.8, 80, this.bridgeConcreteMaterial);
    addBox('underpass-east-retaining-wall', 10.2, 2.9, 320, 0.65, 5.8, 80, this.bridgeConcreteMaterial);
    addBox('underpass-north-portal-header', 0, 5.35, 280, 20.4, 0.72, 0.8, this.bridgeConcreteMaterial);
    addBox('underpass-south-portal-header', 0, 5.35, 360, 20.4, 0.72, 0.8, this.bridgeConcreteMaterial);
    for (let i = 0; i < 5; i++) {
      addBox('underpass-ceiling-luminaire-' + i, 0, 5.48, 292 + i * 14,
        1.2, 0.08, 0.34, this.underpassLightMaterial);
    }
  }

  private addUnderpassColliders(body: RAPIER.RigidBody, centerX: number, centerZ: number): void {
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(10.2, 0.18, 40)
        .setTranslation(-centerX, 5.72, 320 - centerZ).setFriction(0.65),
      body,
    );
    for (const side of [-1, 1]) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(0.325, 2.9, 40)
          .setTranslation(side * 10.2 - centerX, 2.9, 320 - centerZ).setFriction(0.8),
        body,
      );
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

    // Keep parcels on a deterministic 2x2 block plan. The building fronts
    // face the surrounding streets, while the centre gap leaves service and
    // light-well space instead of a field of isolated random boxes.
    for (let gx = firstGX; gx < lastGX; gx++) {
      for (let gz = firstGZ; gz < lastGZ; gz++) {
        const centreX = (gx + 0.5) * CITY_BLOCK_SPACING_M;
        const centreZ = (gz + 0.5) * CITY_BLOCK_SPACING_M;
        if (centreX < minX || centreX >= maxX || centreZ < minZ || centreZ >= maxZ) continue;
        const blockHash = hash(gx, gz, this.graph.seed);
        const blockRadius = Math.hypot(gx, gz);
        const industrial = blockRadius > 16 && blockHash % 7 === 0;
        const district = blockRadius <= 4 ? 'core'
          : blockRadius <= 10 ? 'commercial'
            : blockRadius <= 20 ? 'residential'
              : industrial ? 'industrial' : 'outer';

        for (let i = 0; i < 4; i++) {
          const value = hash(gx * 7 + i, gz * 11 - i, this.graph.seed ^ 0x51f2);
          const offsetX = i % 2 === 0 ? -32 : 32;
          const offsetZ = i < 2 ? -32 : 32;
          const width = 46 + (value % 900) / 100;
          const depth = 45 + ((value >>> 8) % 1000) / 100;
          const style = (value >>> 18) % 6;
          const variation = ((value >>> 23) % 1000) / 100;

          let height: number;
          if (district === 'core') {
            height = style === 0 ? 118 + variation * 6.4
              : style === 1 ? 78 + variation * 4.1
                : style === 2 ? 48 + variation * 3.2
                  : 22 + variation * 3.4;
          } else if (district === 'commercial') {
            height = style === 0 ? 74 + variation * 4.1
              : style === 1 ? 42 + variation * 3.4
                : 20 + variation * 3.1;
          } else if (district === 'residential') {
            height = style === 0 ? 38 + variation * 2.6
              : style === 1 ? 21 + variation * 2.1
                : 11 + variation * 1.7;
          } else if (district === 'industrial') {
            height = 8 + variation * 1.5;
          } else {
            height = style === 0 ? 45 + variation * 2.8
              : 14 + variation * 2.9;
          }

          result.push({
            x: centreX + offsetX,
            z: centreZ + offsetZ,
            width,
            depth,
            height: Math.min(190, height),
            colour: colourForBuilding(style),
          });
        }
      }
    }
    return result;
  }

  private addStreetFurniture(group: THREE.Group, cx: number, cz: number): void {
    const poles = new THREE.InstancedMesh(this.unitBox, this.poleMaterial, 8);
    const lamps = new THREE.InstancedMesh(this.lampGeometry, this.lampMaterial, 8);
    for (let i = 0; i < 8; i++) {
      const x = (i % 2 === 0 ? -1 : 1) * (CITY_CHUNK_SIZE_M * 0.5 - 22);
      const z = (Math.floor(i / 2) - 1.5) * 104;
      setInstance(poles, i, x, 3.1, z, 0.15, 6.2, 0.15);
      setInstance(lamps, i, x, 6.25, z, 0.42, 0.24, 0.42);
    }
    group.add(poles, lamps);
    const trees = new THREE.InstancedMesh(this.treeGeometry, this.treeMaterial, 10);
    for (let i = 0; i < 10; i++) {
      const x = (hash(cx * 10 + i, cz, this.graph.seed) % 380) - 190;
      const z = (hash(cx, cz * 10 + i, this.graph.seed) % 380) - 190;
      setInstance(trees, i, x, 3, z, 2.7, 3.2, 2.7);
    }
    group.add(trees);
  }

  private removeChunk(chunk: CityChunk): void {
    this.scene.remove(chunk.group);
    this.physics.removeRigidBody(chunk.body);
    for (const geometry of chunk.geometries) geometry.dispose();
  }
}
