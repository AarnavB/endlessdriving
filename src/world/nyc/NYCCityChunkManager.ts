import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY_BLOCK_SPACING_M,
  CITY_CHUNK_SIZE_M,
  CityRoadGraph,
} from './CityRoadGraph';

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
      this.curbMaterial, this.buildingMaterial, this.windowMaterial, this.rooftopMaterial,
      this.poleMaterial, this.lampMaterial, this.treeMaterial,
    ]) material.dispose();
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

    const geometries: THREE.BufferGeometry[] = [];
    const groundGeometry = makeGeometry(groundPositions, groundIndices);
    const roadGeometry = makeGeometry(roadPositions, roadIndices);
    const sidewalkGeometry = makeGeometry(sidewalkPositions, sidewalkIndices);
    const whiteGeometry = makeGeometry(whitePositions, whiteIndices);
    const yellowGeometry = makeGeometry(yellowPositions, yellowIndices);
    const crosswalkGeometry = makeGeometry(crosswalkPositions, crosswalkIndices);
    for (const [geometry, material, name] of [
      [groundGeometry, this.groundMaterial, 'visible-city-block-ground'],
      [roadGeometry, this.roadMaterial, 'asphalt-road-network'],
      [sidewalkGeometry, this.sidewalkMaterial, 'raised-sidewalks'],
      [whiteGeometry, this.lineMaterial, 'lane-markings'],
      [yellowGeometry, this.centreLineMaterial, 'double-yellow-centrelines'],
      [crosswalkGeometry, this.lineMaterial, 'pedestrian-crossings'],
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
    const rooftops: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    for (let i = 0; i < buildingSpecs.length; i++) {
      const b = buildingSpecs[i];
      setInstance(buildingMesh, i, b.x - centerX, b.height * 0.5, b.z - centerZ, b.width, b.height, b.depth, b.colour);
      const floors = Math.min(25, Math.max(2, Math.floor(b.height / 3.6)));
      const colsX = Math.min(6, Math.max(2, Math.floor(b.width / 5)));
      const colsZ = Math.min(6, Math.max(2, Math.floor(b.depth / 5)));
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
      if (b.height > 48) rooftops.push({
        x: b.x - centerX + b.width * 0.12,
        y: b.height + 1.1,
        z: b.z - centerZ,
        w: Math.min(8, b.width * 0.3), h: 2.2, d: Math.min(7, b.depth * 0.25),
      });
    }
    buildingMesh.name = 'fictional-city-buildings';
    buildingMesh.castShadow = true;
    buildingMesh.receiveShadow = true;
    if (buildingSpecs.length > 0) group.add(buildingMesh);

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
    for (let gx = firstGX; gx < lastGX; gx++) {
      for (let gz = firstGZ; gz < lastGZ; gz++) {
        const centreX = (gx + 0.5) * CITY_BLOCK_SPACING_M;
        const centreZ = (gz + 0.5) * CITY_BLOCK_SPACING_M;
        if (centreX < minX || centreX >= maxX || centreZ < minZ || centreZ >= maxZ) continue;
        const blockHash = hash(gx, gz, this.graph.seed);
        const count = 2 + (blockHash % 2);
        for (let i = 0; i < count; i++) {
          const value = hash(gx * 7 + i, gz * 11 - i, this.graph.seed ^ 0x51f2);
          const offsetX = i === 0 ? -31 : i === 1 ? 31 : 0;
          const offsetZ = i === 0 ? 14 : i === 1 ? -15 : 43;
          const width = 22 + (value % 1300) / 100;
          const depth = 25 + ((value >>> 8) % 1050) / 100;
          const style = (value >>> 18) % 6;
          const height = style === 0 ? 66 + ((value >>> 5) % 1000) / 10
            : style === 1 ? 17 + ((value >>> 7) % 240) / 10
              : style === 2 ? 28 + ((value >>> 10) % 480) / 10
                : 11 + ((value >>> 12) % 180) / 10;
          result.push({
            x: centreX + offsetX,
            z: centreZ + offsetZ,
            width,
            depth,
            height: Math.min(165, height),
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
