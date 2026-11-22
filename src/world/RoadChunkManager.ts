import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getEnvironmentTransition, selectEnvironmentForFeature } from './EnvironmentProfiles';
import type { EnvironmentKind, EnvironmentProfile } from './EnvironmentProfiles';
import { RoadPath, RoadSample, ROAD_CHUNK_LENGTH, ROAD_HALF_WIDTH } from './RoadPath';
import { SeededRandom, hashSeed } from './SeededRandom';

interface RoadChunk {
  index: number;
  group: THREE.Group;
  rigidBody: RAPIER.RigidBody;
  ownedGeometries: THREE.BufferGeometry[];
  profile: EnvironmentKind;
}

export interface RoadWorldDiagnostics {
  activeChunks: number;
  minimumChunkIndex: number | null;
  maximumChunkIndex: number | null;
  worldSeed: number;
}

interface RoadGeometryData {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  indices: Uint32Array;
}

const ROAD_SEGMENTS = 30;
const TERRAIN_OFFSETS = [-140, -105, -70, -38, -18, -9, 9, 18, 38, 70, 105, 140];
const LANE_DASH_SPACING = 12;
const LANE_DASH_LENGTH = 5.2;
const RAIL_SEGMENT_LENGTH = 8;
const RAIL_OFFSET = ROAD_HALF_WIDTH + 0.55;
const MAX_ACTIVE_CHUNKS_BEHIND = 2;
const MAX_ACTIVE_CHUNKS_AHEAD = 6;

const ENVIRONMENT_KINDS: EnvironmentKind[] = [
  'countryside',
  'forest',
  'suburban',
  'industrial',
  'mountain',
];

function yawFromTangent(tangent: THREE.Vector3): number {
  return Math.atan2(tangent.x, tangent.z);
}

function terrainHeight(sample: RoadSample, offset: number, distance: number): number {
  const outsideRoad = Math.max(0, Math.abs(offset) - ROAD_HALF_WIDTH);
  const broad = Math.sin(distance * 0.0045 + offset * 0.008) * 0.72;
  const detail = Math.sin(distance * 0.017 - offset * 0.023) * 0.18;
  return sample.position.y - 0.34 - outsideRoad * 0.008 + (broad + detail) * Math.min(1, outsideRoad / 28);
}

function makeTransform(
  position: THREE.Vector3,
  yaw: number,
  scale: THREE.Vector3,
): THREE.Matrix4 {
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return new THREE.Matrix4().compose(position, rotation, scale);
}

/**
 * Rolling, deterministic highway world.
 *
 * Road and terrain surfaces are generated from the same global RoadPath. Chunk
 * boundaries therefore share identical endpoint samples. Only the active
 * window owns meshes and Rapier bodies; the path and chunk seeds are sufficient
 * to reconstruct any discarded section when the player reverses.
 */
export class RoadChunkManager {
  private readonly chunks = new Map<number, RoadChunk>();
  private readonly roadMaterial: THREE.MeshStandardMaterial;
  private readonly terrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  private readonly roadMarkingWhite = new THREE.MeshBasicMaterial({ color: 0xe8e7db });
  private readonly roadMarkingYellow = new THREE.MeshBasicMaterial({ color: 0xe5bd51 });
  private readonly railMaterial = new THREE.MeshStandardMaterial({
    color: 0x969b9d,
    metalness: 0.72,
    roughness: 0.38,
  });
  private readonly streetPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0x343b40,
    metalness: 0.68,
    roughness: 0.42,
  });
  private readonly streetLampMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd69a,
    emissive: 0xffbc70,
    emissiveIntensity: 0.22,
    roughness: 0.42,
  });
  private readonly signPostMaterial = new THREE.MeshStandardMaterial({
    color: 0x51585c,
    metalness: 0.58,
    roughness: 0.55,
  });
  private readonly signBoardMaterial = new THREE.MeshStandardMaterial({
    color: 0x245d67,
    emissive: 0x10262b,
    emissiveIntensity: 0.18,
    roughness: 0.62,
  });

  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly treeTrunkGeometry = new THREE.CylinderGeometry(0.17, 0.25, 1, 7);
  private readonly treeCrownGeometry = new THREE.IcosahedronGeometry(1.45, 1);
  private readonly bushGeometry = new THREE.IcosahedronGeometry(0.82, 0);
  private readonly rockGeometry = new THREE.IcosahedronGeometry(1, 0);
  private readonly buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly poleGeometry = new THREE.CylinderGeometry(0.075, 0.11, 1, 7);
  private readonly postGeometry = new THREE.CylinderGeometry(0.055, 0.07, 1, 6);

  private readonly trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x594a39, roughness: 1 });
  private readonly treeCrownMaterials: Record<EnvironmentKind, THREE.MeshStandardMaterial>;
  private readonly bushMaterials: Record<EnvironmentKind, THREE.MeshStandardMaterial>;
  private readonly rockMaterials: Record<EnvironmentKind, THREE.MeshStandardMaterial>;
  private readonly buildingMaterials: Record<EnvironmentKind, THREE.MeshStandardMaterial>;
  private readonly asphaltTexture: THREE.CanvasTexture;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: RAPIER.World,
    readonly path: RoadPath,
    private readonly behindChunks = MAX_ACTIVE_CHUNKS_BEHIND,
    private readonly aheadChunks = MAX_ACTIVE_CHUNKS_AHEAD,
  ) {
    this.asphaltTexture = this.createAsphaltTexture();
    this.roadMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.asphaltTexture,
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.015,
    });

    this.treeCrownMaterials = this.makeEnvironmentMaterials((kind) => ({
      color: kind === 'forest' ? 0x28553a : kind === 'mountain' ? 0x526947 : 0x477343,
      roughness: 1,
    }));
    this.bushMaterials = this.makeEnvironmentMaterials((kind) => ({
      color: kind === 'forest' ? 0x315b3b : kind === 'mountain' ? 0x5f6e50 : 0x5c7846,
      roughness: 1,
    }));
    this.rockMaterials = this.makeEnvironmentMaterials((kind) => ({
      color: kind === 'mountain' ? 0x89877f : kind === 'forest' ? 0x686f69 : 0x817d72,
      roughness: 0.94,
    }));
    this.buildingMaterials = this.makeEnvironmentMaterials((kind) => ({
      color: kind === 'industrial' ? 0x68757b : kind === 'suburban' ? 0x958c7d : 0x777970,
      roughness: 0.84,
      metalness: kind === 'industrial' ? 0.16 : 0.04,
    }));

    this.scene.background = new THREE.Color(0x9badb6);
    this.scene.fog = new THREE.FogExp2(0x9badb6, 0.0011);
  }

  /** Ensure the rolling active window exists around the vehicle (forward or reverse). */
  update(playerPosition: THREE.Vector3): void {
    if (this.disposed) return;
    const currentIndex = this.path.getChunkIndexAtWorldZ(playerPosition.z);
    const minimum = currentIndex - this.behindChunks;
    const maximum = currentIndex + this.aheadChunks;

    // Build missing sections in index order. The ahead window is deliberately
    // generous relative to the vehicle's 58 m/s top speed.
    for (let index = minimum; index <= maximum; index++) {
      if (!this.chunks.has(index)) this.chunks.set(index, this.createChunk(index));
    }

    for (const [index, chunk] of this.chunks) {
      if (index < minimum || index > maximum) this.removeChunk(chunk);
    }
  }

  reset(playerPosition: THREE.Vector3): void {
    this.update(playerPosition);
  }

  sampleAtWorldZ(worldZ: number): RoadSample {
    return this.path.sampleAtWorldZ(worldZ);
  }

  getLanePositionAtWorldZ(
    worldZ: number,
    laneOffset: number,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    return this.path.getLanePositionAtWorldZ(worldZ, laneOffset, target);
  }

  setNightBlend(amount: number): void {
    const blend = THREE.MathUtils.clamp(amount, 0, 1);
    this.scene.background = new THREE.Color(0x9badb6).lerp(new THREE.Color(0x080d18), blend);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(this.scene.background as THREE.Color);
      this.scene.fog.density = THREE.MathUtils.lerp(0.0011, 0.002, blend);
    }
    this.streetLampMaterial.emissiveIntensity = THREE.MathUtils.lerp(0.18, 2.1, blend);
    this.signBoardMaterial.emissiveIntensity = THREE.MathUtils.lerp(0.08, 0.32, blend);
  }

  getDiagnostics(): RoadWorldDiagnostics {
    const indices = [...this.chunks.keys()];
    return {
      activeChunks: indices.length,
      minimumChunkIndex: indices.length ? Math.min(...indices) : null,
      maximumChunkIndex: indices.length ? Math.max(...indices) : null,
      worldSeed: this.path.seed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chunk of this.chunks.values()) this.removeChunk(chunk);
    this.chunks.clear();

    this.asphaltTexture.dispose();
    this.roadMaterial.dispose();
    this.terrainMaterial.dispose();
    this.roadMarkingWhite.dispose();
    this.roadMarkingYellow.dispose();
    this.railMaterial.dispose();
    this.streetPoleMaterial.dispose();
    this.streetLampMaterial.dispose();
    this.signPostMaterial.dispose();
    this.signBoardMaterial.dispose();
    this.unitBox.dispose();
    this.treeTrunkGeometry.dispose();
    this.treeCrownGeometry.dispose();
    this.bushGeometry.dispose();
    this.rockGeometry.dispose();
    this.buildingGeometry.dispose();
    this.poleGeometry.dispose();
    this.postGeometry.dispose();
    this.trunkMaterial.dispose();
    for (const kind of ENVIRONMENT_KINDS) {
      this.treeCrownMaterials[kind].dispose();
      this.bushMaterials[kind].dispose();
      this.rockMaterials[kind].dispose();
      this.buildingMaterials[kind].dispose();
    }
  }

  private makeEnvironmentMaterials(
    factory: (kind: EnvironmentKind) => THREE.MeshStandardMaterialParameters,
  ): Record<EnvironmentKind, THREE.MeshStandardMaterial> {
    return {
      countryside: new THREE.MeshStandardMaterial(factory('countryside')),
      forest: new THREE.MeshStandardMaterial(factory('forest')),
      suburban: new THREE.MeshStandardMaterial(factory('suburban')),
      industrial: new THREE.MeshStandardMaterial(factory('industrial')),
      mountain: new THREE.MeshStandardMaterial(factory('mountain')),
    };
  }

  private createAsphaltTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable for asphalt texture.');

    const rng = new SeededRandom(hashSeed(this.path.seed, 0x2a31f));
    context.fillStyle = '#363b3f';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < 6200; index++) {
      const value = rng.integer(38, 92);
      context.fillStyle = 'rgba(' + value + ',' + value + ',' + value + ',0.22)';
      const x = rng.integer(0, canvas.width - 1);
      const y = rng.integer(0, canvas.height - 1);
      const size = rng.range(1, 2.2);
      context.fillRect(x, y, size, size);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 7);
    texture.anisotropy = 4;
    return texture;
  }

  private createChunk(index: number): RoadChunk {
    const group = new THREE.Group();
    group.name = 'road-chunk-' + index;
    const ownedGeometries: THREE.BufferGeometry[] = [];
    const transition = getEnvironmentTransition(this.path.seed, index);
    const terrainColor = new THREE.Color(transition.primary.terrainColor)
      .lerp(new THREE.Color(transition.secondary.terrainColor), transition.blend);

    const roadData = this.buildRoadGeometry(index);
    ownedGeometries.push(roadData.geometry);
    const road = new THREE.Mesh(roadData.geometry, this.roadMaterial);
    road.receiveShadow = true;
    road.frustumCulled = true;
    group.add(road);

    const terrainGeometry = this.buildTerrainGeometry(index, terrainColor);
    ownedGeometries.push(terrainGeometry);
    const terrain = new THREE.Mesh(terrainGeometry, this.terrainMaterial);
    terrain.receiveShadow = true;
    terrain.frustumCulled = true;
    group.add(terrain);

    const rigidBody = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const roadCollider = RAPIER.ColliderDesc.trimesh(roadData.positions, roadData.indices)
      .setFriction(0.08)
      .setRestitution(0);
    this.physics.createCollider(roadCollider, rigidBody);

    this.addRoadMarkings(group, index, ownedGeometries);
    this.addGuardrails(group, index, rigidBody);
    this.addScenery(group, index, transition);

    this.scene.add(group);
    return {
      index,
      group,
      rigidBody,
      ownedGeometries,
      profile: transition.primary.kind,
    };
  }

  private buildRoadGeometry(index: number): RoadGeometryData {
    const vertexCount = (ROAD_SEGMENTS + 1) * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(ROAD_SEGMENTS * 6);
    const asphalt = new THREE.Color(0x343a3e);
    const shoulder = new THREE.Color(0x414649);
    const startDistance = index * ROAD_CHUNK_LENGTH;

    for (let station = 0; station <= ROAD_SEGMENTS; station++) {
      const distance = startDistance + (station / ROAD_SEGMENTS) * ROAD_CHUNK_LENGTH;
      const sample = this.path.sample(distance);
      const left = sample.position.clone().addScaledVector(sample.right, -ROAD_HALF_WIDTH);
      const right = sample.position.clone().addScaledVector(sample.right, ROAD_HALF_WIDTH);
      left.y += 0.025;
      right.y += 0.025;

      for (let side = 0; side < 2; side++) {
        const vertex = station * 2 + side;
        const point = side === 0 ? left : right;
        positions[vertex * 3] = point.x;
        positions[vertex * 3 + 1] = point.y;
        positions[vertex * 3 + 2] = point.z;
        const across = side === 0 ? -ROAD_HALF_WIDTH : ROAD_HALF_WIDTH;
        const color = Math.abs(across) > 7.2 ? shoulder : asphalt;
        const variation = 0.94 + (hashSeed(this.path.seed, index * 997 + station * 2 + side) / 0x100000000) * 0.11;
        colors[vertex * 3] = color.r * variation;
        colors[vertex * 3 + 1] = color.g * variation;
        colors[vertex * 3 + 2] = color.b * variation;
        uvs[vertex * 2] = side;
        uvs[vertex * 2 + 1] = distance * 0.07;
      }
      if (station < ROAD_SEGMENTS) {
        const base = station * 2;
        const offset = station * 6;
        indices[offset] = base;
        indices[offset + 1] = base + 2;
        indices[offset + 2] = base + 1;
        indices[offset + 3] = base + 1;
        indices[offset + 4] = base + 2;
        indices[offset + 5] = base + 3;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return { geometry, positions, indices };
  }

  private buildTerrainGeometry(index: number, baseColor: THREE.Color): THREE.BufferGeometry {
    const columns = TERRAIN_OFFSETS.length;
    const rows = ROAD_SEGMENTS + 1;
    const positions = new Float32Array(columns * rows * 3);
    const colors = new Float32Array(columns * rows * 3);
    const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
    const startDistance = index * ROAD_CHUNK_LENGTH;

    for (let row = 0; row < rows; row++) {
      const distance = startDistance + (row / ROAD_SEGMENTS) * ROAD_CHUNK_LENGTH;
      const sample = this.path.sample(distance);
      for (let column = 0; column < columns; column++) {
        const offset = TERRAIN_OFFSETS[column];
        const point = sample.position.clone().addScaledVector(sample.right, offset);
        point.y = terrainHeight(sample, offset, distance);
        const vertex = row * columns + column;
        positions[vertex * 3] = point.x;
        positions[vertex * 3 + 1] = point.y;
        positions[vertex * 3 + 2] = point.z;
        const variation = 0.94 + (hashSeed(this.path.seed, index * 331 + row * 19 + column) / 0x100000000) * 0.12;
        colors[vertex * 3] = baseColor.r * variation;
        colors[vertex * 3 + 1] = baseColor.g * variation;
        colors[vertex * 3 + 2] = baseColor.b * variation;
      }
    }

    let cursor = 0;
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const a = row * columns + column;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private addRoadMarkings(
    group: THREE.Group,
    index: number,
    ownedGeometries: THREE.BufferGeometry[],
  ): void {
    const start = index * ROAD_CHUNK_LENGTH;
    const laneDashes = new THREE.InstancedMesh(
      this.unitBox,
      this.roadMarkingWhite,
      Math.ceil(ROAD_CHUNK_LENGTH / LANE_DASH_SPACING) * 2,
    );
    laneDashes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    let dashIndex = 0;

    for (let distance = start + 3; distance < start + ROAD_CHUNK_LENGTH - 2; distance += LANE_DASH_SPACING) {
      const sample = this.path.sample(distance);
      const yaw = yawFromTangent(sample.tangent);
      for (const laneDividerOffset of [-3.6, 3.6]) {
        const position = sample.position.clone().addScaledVector(sample.right, laneDividerOffset);
        position.y += 0.052;
        const matrix = makeTransform(position, yaw, new THREE.Vector3(0.12, 0.025, LANE_DASH_LENGTH));
        laneDashes.setMatrixAt(dashIndex++, matrix);
      }
    }
    laneDashes.count = dashIndex;
    laneDashes.instanceMatrix.needsUpdate = true;
    laneDashes.computeBoundingSphere();
    group.add(laneDashes);

    for (const offset of [-7.2, 7.2]) {
      const edge = this.buildRibbon(start, offset, 0.13, ROAD_SEGMENTS, 0.052);
      ownedGeometries.push(edge);
      group.add(new THREE.Mesh(edge, this.roadMarkingWhite));
    }
    for (const offset of [-0.22, 0.22]) {
      const centre = this.buildRibbon(start, offset, 0.12, ROAD_SEGMENTS, 0.055);
      ownedGeometries.push(centre);
      group.add(new THREE.Mesh(centre, this.roadMarkingYellow));
    }
  }

  private buildRibbon(
    startDistance: number,
    lateralOffset: number,
    width: number,
    segments: number,
    height: number,
  ): THREE.BufferGeometry {
    const positions = new Float32Array((segments + 1) * 2 * 3);
    const indices = new Uint32Array(segments * 6);
    for (let station = 0; station <= segments; station++) {
      const distance = startDistance + station / segments * ROAD_CHUNK_LENGTH;
      const sample = this.path.sample(distance);
      for (let side = 0; side < 2; side++) {
        const offset = lateralOffset + (side === 0 ? -width / 2 : width / 2);
        const point = sample.position.clone().addScaledVector(sample.right, offset);
        point.y += height;
        const vertex = station * 2 + side;
        positions[vertex * 3] = point.x;
        positions[vertex * 3 + 1] = point.y;
        positions[vertex * 3 + 2] = point.z;
      }
      if (station < segments) {
        const base = station * 2;
        const cursor = station * 6;
        indices[cursor] = base;
        indices[cursor + 1] = base + 2;
        indices[cursor + 2] = base + 1;
        indices[cursor + 3] = base + 1;
        indices[cursor + 4] = base + 2;
        indices[cursor + 5] = base + 3;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  private addGuardrails(
    group: THREE.Group,
    index: number,
    rigidBody: RAPIER.RigidBody,
  ): void {
    const start = index * ROAD_CHUNK_LENGTH;
    const segmentCount = Math.ceil(ROAD_CHUNK_LENGTH / RAIL_SEGMENT_LENGTH);
    const beamMesh = new THREE.InstancedMesh(this.unitBox, this.railMaterial, segmentCount * 2);
    const postMesh = new THREE.InstancedMesh(this.postGeometry, this.railMaterial, (segmentCount + 1) * 2);
    let beamIndex = 0;
    let postIndex = 0;

    for (let segment = 0; segment < segmentCount; segment++) {
      const distance = start + (segment + 0.5) * RAIL_SEGMENT_LENGTH;
      const sample = this.path.sample(distance);
      const yaw = yawFromTangent(sample.tangent);
      for (const side of [-1, 1]) {
        const position = sample.position.clone().addScaledVector(sample.right, side * RAIL_OFFSET);
        position.y += 0.78;
        beamMesh.setMatrixAt(
          beamIndex++,
          makeTransform(position, yaw, new THREE.Vector3(0.16, 0.34, RAIL_SEGMENT_LENGTH + 0.16)),
        );
      }
    }

    for (let segment = 0; segment <= segmentCount; segment += 1) {
      const distance = start + Math.min(segment * RAIL_SEGMENT_LENGTH, ROAD_CHUNK_LENGTH);
      const sample = this.path.sample(distance);
      for (const side of [-1, 1]) {
        const position = sample.position.clone().addScaledVector(sample.right, side * RAIL_OFFSET);
        position.y += 0.48;
        postMesh.setMatrixAt(
          postIndex++,
          makeTransform(position, yawFromTangent(sample.tangent), new THREE.Vector3(0.13, 0.95, 0.13)),
        );
      }
    }

    beamMesh.instanceMatrix.needsUpdate = true;
    postMesh.count = postIndex;
    postMesh.instanceMatrix.needsUpdate = true;
    beamMesh.computeBoundingSphere();
    postMesh.computeBoundingSphere();
    group.add(beamMesh, postMesh);

    // One fixed body per chunk owns its road mesh and all short barrier boxes.
    // Removing that body releases every road/barrier collider in one operation.
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const distance = start + (segment + 0.5) * RAIL_SEGMENT_LENGTH;
      const sample = this.path.sample(distance);
      const yaw = yawFromTangent(sample.tangent);
      const halfLength = RAIL_SEGMENT_LENGTH / 2 + 0.15;
      for (const side of [-1, 1]) {
        const position = sample.position.clone().addScaledVector(sample.right, side * RAIL_OFFSET);
        const halfYaw = yaw / 2;
        const rotation = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) };
        const collider = RAPIER.ColliderDesc.cuboid(0.12, 0.34, halfLength)
          .setTranslation(position.x, position.y + 0.78, position.z)
          .setRotation(rotation)
          .setFriction(0.35);
        this.physics.createCollider(collider, rigidBody);
      }
    }
  }

  private addScenery(
    group: THREE.Group,
    index: number,
    transition: { primary: EnvironmentProfile; secondary: EnvironmentProfile; blend: number },
  ): void {
    const rng = new SeededRandom(hashSeed(this.path.seed, index * 0x45d9f3b));
    const start = index * ROAD_CHUNK_LENGTH;
    const trunkMatrices: THREE.Matrix4[] = [];
    const foliageMatrices: Record<EnvironmentKind, THREE.Matrix4[]> = {
      countryside: [], forest: [], suburban: [], industrial: [], mountain: [],
    };
    const bushMatrices: Record<EnvironmentKind, THREE.Matrix4[]> = {
      countryside: [], forest: [], suburban: [], industrial: [], mountain: [],
    };
    const rockMatrices: Record<EnvironmentKind, THREE.Matrix4[]> = {
      countryside: [], forest: [], suburban: [], industrial: [], mountain: [],
    };
    const buildingMatrices: Record<EnvironmentKind, THREE.Matrix4[]> = {
      countryside: [], forest: [], suburban: [], industrial: [], mountain: [],
    };
    const poleMatrices: THREE.Matrix4[] = [];
    const lampMatrices: THREE.Matrix4[] = [];
    const signPostMatrices: THREE.Matrix4[] = [];
    const signBoardMatrices: THREE.Matrix4[] = [];

    for (const side of [-1, 1]) {
      for (let item = 0; item < 7; item++) {
        const distance = start + rng.range(7, ROAD_CHUNK_LENGTH - 7);
        const sample = this.path.sample(distance);
        const offset = rng.range(14, 58);
        const position = sample.position.clone().addScaledVector(sample.right, side * offset);
        const groundY = terrainHeight(sample, side * offset, distance);
        const profile = selectEnvironmentForFeature(transition, rng);
        const yaw = yawFromTangent(sample.tangent) + rng.range(-0.75, 0.75);

        if (rng.chance(profile.treeChance)) {
          const scale = rng.range(0.72, 1.5);
          const trunkPosition = new THREE.Vector3(position.x, groundY + 1.55 * scale, position.z);
          const crownPosition = new THREE.Vector3(position.x, groundY + 3.15 * scale, position.z);
          const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          trunkMatrices.push(new THREE.Matrix4().compose(
            trunkPosition,
            rotation,
            new THREE.Vector3(scale, 3.1 * scale, scale),
          ));
          foliageMatrices[profile.kind].push(new THREE.Matrix4().compose(
            crownPosition,
            rotation,
            new THREE.Vector3(1.18 * scale, 1.45 * scale, 1.18 * scale),
          ));
        }

        if (rng.chance(profile.bushChance)) {
          const scale = rng.range(0.7, 1.5);
          const bushPosition = new THREE.Vector3(position.x, groundY + 0.52 * scale, position.z);
          bushMatrices[profile.kind].push(new THREE.Matrix4().compose(
            bushPosition,
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
            new THREE.Vector3(1.25 * scale, 0.78 * scale, 1.05 * scale),
          ));
        }

        if (rng.chance(profile.rockChance)) {
          const scale = rng.range(0.7, 2.2);
          const rockPosition = new THREE.Vector3(position.x, groundY + 0.45 * scale, position.z);
          rockMatrices[profile.kind].push(new THREE.Matrix4().compose(
            rockPosition,
            new THREE.Quaternion().setFromEuler(new THREE.Euler(
              rng.range(-0.2, 0.2),
              yaw,
              rng.range(-0.18, 0.18),
            )),
            new THREE.Vector3(scale * 1.3, scale, scale * 0.92),
          ));
        }

        if (rng.chance(profile.buildingChance)) {
          const width = rng.range(9, profile.kind === 'industrial' ? 25 : 18);
          const height = rng.range(7, profile.kind === 'industrial' ? 19 : 15);
          const depth = rng.range(9, 24);
          const buildingPosition = new THREE.Vector3(position.x, groundY + height / 2, position.z);
          buildingMatrices[profile.kind].push(new THREE.Matrix4().compose(
            buildingPosition,
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
            new THREE.Vector3(width, height, depth),
          ));
        }
      }

      const transitionProfile = rng.chance(transition.blend) ? transition.secondary : transition.primary;
      if (rng.chance(transitionProfile.streetlightChance)) {
        for (const along of [28, 88]) {
          const distance = start + along + rng.range(-5, 5);
          const sample = this.path.sample(distance);
          const position = sample.position.clone().addScaledVector(sample.right, side * (ROAD_HALF_WIDTH + 3.5));
          const polePosition = new THREE.Vector3(position.x, position.y + 3.2, position.z);
          const lampPosition = new THREE.Vector3(
            position.x - side * 0.52,
            position.y + 6.15,
            position.z,
          );
          poleMatrices.push(makeTransform(
            polePosition,
            yawFromTangent(sample.tangent),
            new THREE.Vector3(1, 6.4, 1),
          ));
          lampMatrices.push(makeTransform(
            lampPosition,
            yawFromTangent(sample.tangent),
            new THREE.Vector3(0.72, 0.13, 0.32),
          ));
        }
      }
    }

    this.addInstanced(group, this.treeTrunkGeometry, this.trunkMaterial, trunkMatrices);
    for (const kind of ENVIRONMENT_KINDS) {
      this.addInstanced(group, this.treeCrownGeometry, this.treeCrownMaterials[kind], foliageMatrices[kind]);
      this.addInstanced(group, this.bushGeometry, this.bushMaterials[kind], bushMatrices[kind]);
      this.addInstanced(group, this.rockGeometry, this.rockMaterials[kind], rockMatrices[kind]);
      this.addInstanced(group, this.buildingGeometry, this.buildingMaterials[kind], buildingMatrices[kind]);
    }
    this.addInstanced(group, this.poleGeometry, this.streetPoleMaterial, poleMatrices);
    this.addInstanced(group, this.unitBox, this.streetLampMaterial, lampMatrices);

    // Occasional directional information boards provide recognisable highway
    // infrastructure without introducing a dense, repetitive sign every chunk.
    if (rng.chance(0.48)) {
      const distance = start + rng.range(35, ROAD_CHUNK_LENGTH - 25);
      const sample = this.path.sample(distance);
      const side = rng.chance(0.5) ? -1 : 1;
      const position = sample.position.clone().addScaledVector(sample.right, side * (ROAD_HALF_WIDTH + 4.1));
      const yaw = yawFromTangent(sample.tangent);
      signPostMatrices.push(makeTransform(
        new THREE.Vector3(position.x, position.y + 2.0, position.z),
        yaw,
        new THREE.Vector3(1, 4.0, 1),
      ));
      signBoardMatrices.push(makeTransform(
        new THREE.Vector3(position.x, position.y + 3.35, position.z),
        yaw,
        new THREE.Vector3(2.6, 1.25, 0.16),
      ));
    }
    this.addInstanced(group, this.postGeometry, this.signPostMaterial, signPostMatrices);
    this.addInstanced(group, this.unitBox, this.signBoardMaterial, signBoardMatrices);
  }

  private addInstanced(
    group: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: THREE.Matrix4[],
  ): void {
    if (matrices.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  private removeChunk(chunk: RoadChunk): void {
    this.scene.remove(chunk.group);
    for (const geometry of chunk.ownedGeometries) geometry.dispose();
    this.physics.removeRigidBody(chunk.rigidBody);
    this.chunks.delete(chunk.index);
  }
}
