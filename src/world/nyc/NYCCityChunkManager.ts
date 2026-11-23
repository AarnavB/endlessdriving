import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoadPath } from '../RoadPath';
import type { RoadSample } from '../RoadPath';
import {
  FEET_TO_METRES,
  NYC_CHUNK_SIZE_M,
  NYC_ORIGIN,
  geographicToLocal,
  getChunkIndex,
  getChunkKey,
  localBoundsToGeographic,
} from './NYCGeo';
import type { LocalBounds } from './NYCGeo';
import { NYCOpenDataClient } from './NYCOpenData';
import type { NYCGeoJSONFeature, NYCFeatureCollection } from './NYCOpenData';

interface CityChunk {
  key: string;
  group: THREE.Group;
  rigidBody: RAPIER.RigidBody | null;
  geometries: THREE.BufferGeometry[];
  buildingCount: number;
  roadCount: number;
}

type Position = [number, number];
const STREAM_RADIUS = 1;
const QUERY_MARGIN_M = 18;

function readPosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
  return [longitude, latitude];
}

function readLineParts(feature: NYCGeoJSONFeature): Position[][] {
  if (!feature.geometry) return [];
  const raw = feature.geometry.coordinates;
  const parts: unknown[] = feature.geometry.type === 'LineString'
    ? [raw]
    : feature.geometry.type === 'MultiLineString' && Array.isArray(raw) ? raw : [];
  return parts.map((part) => Array.isArray(part)
    ? part.map(readPosition).filter((point): point is Position => point !== null)
    : []).filter((part) => part.length >= 2);
}

function readPolygonParts(feature: NYCGeoJSONFeature): Position[][][] {
  if (!feature.geometry) return [];
  const raw = feature.geometry.coordinates;
  const parts: unknown[] = feature.geometry.type === 'Polygon'
    ? [raw]
    : feature.geometry.type === 'MultiPolygon' && Array.isArray(raw) ? raw : [];
  return parts.map((polygon) => {
    if (!Array.isArray(polygon)) return [];
    return polygon.map((ring) => Array.isArray(ring)
      ? ring.map(readPosition).filter((point): point is Position => point !== null)
      : []).filter((ring) => ring.length >= 4);
  }).filter((polygon) => polygon.length > 0);
}

function numberProperty(properties: Record<string, unknown>, ...keys: string[]): number | null {
  const normalized = new Map(
    Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const raw = normalized.get(key.toLowerCase());
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function textProperty(properties: Record<string, unknown>, ...keys: string[]): string {
  const normalized = new Map(
    Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const value = normalized.get(key.toLowerCase());
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return '';
}

function getFeatureCenter(feature: NYCGeoJSONFeature): { x: number; z: number } | null {
  const coordinates: Position[] = [];
  if (feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString') {
    for (const line of readLineParts(feature)) coordinates.push(...line);
  } else {
    for (const polygon of readPolygonParts(feature)) {
      if (polygon[0]) coordinates.push(...polygon[0]);
    }
  }
  if (coordinates.length === 0) return null;

  let x = 0;
  let z = 0;
  for (const coordinate of coordinates) {
    const local = geographicToLocal({ longitude: coordinate[0], latitude: coordinate[1] });
    x += local.x;
    z += local.z;
  }
  return { x: x / coordinates.length, z: z / coordinates.length };
}

function colourForId(value: string): THREE.Color {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hue = ((hash >>> 0) % 360) / 360;
  const saturation = 0.09 + ((hash >>> 9) % 9) / 100;
  const lightness = 0.48 + ((hash >>> 17) % 12) / 100;
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

function addRingToPath(
  path: THREE.Path,
  ring: Position[],
  chunkCenterX: number,
  chunkCenterZ: number,
): boolean {
  const converted = ring.map((coordinate) => {
    const local = geographicToLocal({ longitude: coordinate[0], latitude: coordinate[1] });
    return { x: local.x - chunkCenterX, y: -(local.z - chunkCenterZ) };
  });
  if (converted.length < 4) return false;
  path.moveTo(converted[0].x, converted[0].y);
  for (let index = 1; index < converted.length; index++) {
    path.lineTo(converted[index].x, converted[index].y);
  }
  path.closePath();
  return true;
}

function appendGeometry(
  source: THREE.BufferGeometry,
  positions: number[],
  indices: number[],
  colours?: number[],
  colour?: THREE.Color,
): void {
  const positionAttribute = source.getAttribute('position');
  const baseVertex = positions.length / 3;
  for (let index = 0; index < positionAttribute.count; index++) {
    positions.push(
      positionAttribute.getX(index),
      positionAttribute.getY(index),
      positionAttribute.getZ(index),
    );
    if (colours && colour) colours.push(colour.r, colour.g, colour.b);
  }
  const sourceIndex = source.getIndex();
  if (sourceIndex) {
    for (let index = 0; index < sourceIndex.count; index++) {
      indices.push(baseVertex + sourceIndex.getX(index));
    }
  } else {
    for (let index = 0; index < positionAttribute.count; index++) indices.push(baseVertex + index);
  }
}

function makeGeometry(positions: number[], indices: number[], colours?: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colours) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function inBounds(point: { x: number; z: number }, bounds: LocalBounds): boolean {
  return point.x >= bounds.minX && point.x < bounds.maxX
    && point.z >= bounds.minZ && point.z < bounds.maxZ;
}

/**
 * Streamed NYC Open Data world. Roads use published street-bed geometry/width,
 * and buildings use published footprints and roof height. No Google tile mesh
 * participates in rendering of these independent assets or in collision.
 */
export class NYCCityChunkManager {
  private readonly chunks = new Map<string, CityChunk>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly desiredKeys = new Set<string>();
  private readonly originOffset = new THREE.Vector3();
  private readonly client = new NYCOpenDataClient();
  private readonly roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x292e33,
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  private readonly buildingMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  private currentCenterKey: string | null = null;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: RAPIER.World,
    private readonly path: RoadPath,
  ) {}

  async initialize(playerPosition: THREE.Vector3): Promise<void> {
    const index = getChunkIndex(
      playerPosition.x + this.originOffset.x,
      playerPosition.z + this.originOffset.z,
    );
    this.currentCenterKey = getChunkKey(index);
    this.updateDesiredChunks(index);
    await this.ensureChunk(index.x, index.z);
    this.scheduleNeighbours(index);
  }

  update(playerPosition: THREE.Vector3): void {
    if (this.disposed) return;
    const index = getChunkIndex(
      playerPosition.x + this.originOffset.x,
      playerPosition.z + this.originOffset.z,
    );
    const key = getChunkKey(index);
    if (key === this.currentCenterKey) return;
    this.currentCenterKey = key;
    this.updateDesiredChunks(index);
    this.scheduleNeighbours(index);
  }

  reset(playerPosition: THREE.Vector3): void {
    this.update(playerPosition);
  }

  sampleAtWorldZ(worldZ: number): RoadSample {
    const sample = this.path.sampleAtWorldZ(worldZ);
    sample.position.sub(this.originOffset);
    return sample;
  }

  rebase(delta: THREE.Vector3): void {
    if (this.disposed || delta.lengthSq() === 0) return;
    this.originOffset.add(delta);
    for (const chunk of this.chunks.values()) {
      chunk.group.position.sub(delta);
      if (chunk.rigidBody) {
        chunk.rigidBody.setTranslation({
          x: chunk.group.position.x,
          y: chunk.group.position.y,
          z: chunk.group.position.z,
        }, true);
      }
    }
  }

  setNightBlend(amount: number): void {
    const blend = THREE.MathUtils.clamp(amount, 0, 1);
    this.roadMaterial.emissive.setHex(0x11161e);
    this.roadMaterial.emissiveIntensity = blend * 0.16;
    this.buildingMaterial.emissive.setHex(0x25201c);
    this.buildingMaterial.emissiveIntensity = blend * 0.12;
  }

  getDiagnostics(): {
    activeChunks: number;
    pendingChunks: number;
    activeBuildings: number;
    activeRoadSegments: number;
  } {
    let activeBuildings = 0;
    let activeRoadSegments = 0;
    for (const chunk of this.chunks.values()) {
      activeBuildings += chunk.buildingCount;
      activeRoadSegments += chunk.roadCount;
    }
    return {
      activeChunks: this.chunks.size,
      pendingChunks: this.pending.size,
      activeBuildings,
      activeRoadSegments,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chunk of this.chunks.values()) this.removeChunk(chunk);
    this.chunks.clear();
    this.pending.clear();
    this.desiredKeys.clear();
    this.roadMaterial.dispose();
    this.buildingMaterial.dispose();
  }

  private updateDesiredChunks(center: { x: number; z: number }): void {
    this.desiredKeys.clear();
    for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) {
        this.desiredKeys.add(getChunkKey({ x: center.x + dx, z: center.z + dz }));
      }
    }
    for (const [key, chunk] of this.chunks) {
      if (!this.desiredKeys.has(key)) {
        this.removeChunk(chunk);
        this.chunks.delete(key);
      }
    }
  }

  private scheduleNeighbours(center: { x: number; z: number }): void {
    for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue;
        void this.ensureChunk(center.x + dx, center.z + dz).catch((error: unknown) => {
          console.warn('NYC neighbouring chunk failed to load:', error);
        });
      }
    }
  }

  private async ensureChunk(chunkX: number, chunkZ: number): Promise<void> {
    const key = getChunkKey({ x: chunkX, z: chunkZ });
    if (this.chunks.has(key) || this.disposed || !this.desiredKeys.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.fetchAndBuildChunk(chunkX, chunkZ)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async fetchAndBuildChunk(chunkX: number, chunkZ: number): Promise<void> {
    const key = getChunkKey({ x: chunkX, z: chunkZ });
    const centerX = (chunkX + 0.5) * NYC_CHUNK_SIZE_M;
    const centerZ = (chunkZ + 0.5) * NYC_CHUNK_SIZE_M;
    const bounds: LocalBounds = {
      minX: chunkX * NYC_CHUNK_SIZE_M - QUERY_MARGIN_M,
      maxX: (chunkX + 1) * NYC_CHUNK_SIZE_M + QUERY_MARGIN_M,
      minZ: chunkZ * NYC_CHUNK_SIZE_M - QUERY_MARGIN_M,
      maxZ: (chunkZ + 1) * NYC_CHUNK_SIZE_M + QUERY_MARGIN_M,
    };
    const geographicBounds = localBoundsToGeographic(bounds);
    const [buildings, streets] = await Promise.all([
      this.client.loadBuildings(geographicBounds),
      this.client.loadStreetCenterlines(geographicBounds),
    ]);
    if (this.disposed || !this.desiredKeys.has(key)) return;
    const chunk = this.buildChunk(key, chunkX, chunkZ, centerX, centerZ, buildings, streets);
    this.chunks.set(key, chunk);
    this.scene.add(chunk.group);
  }

  private buildChunk(
    key: string,
    chunkX: number,
    chunkZ: number,
    centerX: number,
    centerZ: number,
    buildings: NYCFeatureCollection,
    streets: NYCFeatureCollection,
  ): CityChunk {
    const group = new THREE.Group();
    group.name = 'nyc-data-chunk-' + key;
    group.position.set(centerX - this.originOffset.x, -this.originOffset.y, centerZ - this.originOffset.z);
    const localBounds: LocalBounds = {
      minX: chunkX * NYC_CHUNK_SIZE_M,
      maxX: (chunkX + 1) * NYC_CHUNK_SIZE_M,
      minZ: chunkZ * NYC_CHUNK_SIZE_M,
      maxZ: (chunkZ + 1) * NYC_CHUNK_SIZE_M,
    };

    const roadPositions: number[] = [];
    const roadIndices: number[] = [];
    let roadCount = 0;
    for (const feature of streets.features) {
      if (!feature.geometry) continue;
      const featureCenter = getFeatureCenter(feature);
      if (!featureCenter || !inBounds(featureCenter, localBounds)) continue;
      const widthFeet = numberProperty(feature.properties, 'st_width');
      const widthM = widthFeet !== null && widthFeet > 0
        ? THREE.MathUtils.clamp(widthFeet * FEET_TO_METRES, 4, 70)
        : 12;
      const halfWidth = widthM / 2;
      for (const line of readLineParts(feature)) {
        const points = line.map((coordinate) => geographicToLocal({
          longitude: coordinate[0],
          latitude: coordinate[1],
        }));
        for (let index = 0; index < points.length - 1; index++) {
          const a = points[index];
          const b = points[index + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const length = Math.hypot(dx, dz);
          if (length < 0.1) continue;
          const sideX = dz / length;
          const sideZ = -dx / length;
          const base = roadPositions.length / 3;
          const ax = a.x - centerX;
          const az = a.z - centerZ;
          const bx = b.x - centerX;
          const bz = b.z - centerZ;
          roadPositions.push(
            ax + sideX * halfWidth, 0.035, az + sideZ * halfWidth,
            ax - sideX * halfWidth, 0.035, az - sideZ * halfWidth,
            bx + sideX * halfWidth, 0.035, bz + sideZ * halfWidth,
            bx - sideX * halfWidth, 0.035, bz - sideZ * halfWidth,
          );
          // Winding is upward-facing so both the renderer and Rapier see the road top.
          roadIndices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
      roadCount++;
    }

    const buildingPositions: number[] = [];
    const buildingIndices: number[] = [];
    const buildingColours: number[] = [];
    let buildingCount = 0;
    for (const feature of buildings.features) {
      if (!feature.geometry) continue;
      const featureCenter = getFeatureCenter(feature);
      if (!featureCenter || !inBounds(featureCenter, localBounds)) continue;
      const polygons = readPolygonParts(feature);
      if (polygons.length === 0) continue;

      const roofFeet = numberProperty(feature.properties, 'height_roof');
      const heightM = roofFeet !== null && roofFeet > 0
        ? THREE.MathUtils.clamp(roofFeet * FEET_TO_METRES, 3, 420)
        : 9; // Explicitly approximate where roof-height metadata is missing.
      const groundFeet = numberProperty(feature.properties, 'ground_elevation');
      const groundM = groundFeet !== null
        ? groundFeet * FEET_TO_METRES - (NYC_ORIGIN.altitudeM ?? 0)
        : 0;
      const featureId = textProperty(feature.properties, 'bin', 'doitt_id', 'objectid')
        || String(feature.id ?? buildingCount);
      const colour = colourForId(featureId);

      for (const polygon of polygons) {
        const shape = new THREE.Shape();
        if (!addRingToPath(shape, polygon[0], centerX, centerZ)) continue;
        for (let holeIndex = 1; holeIndex < polygon.length; holeIndex++) {
          const hole = new THREE.Path();
          if (addRingToPath(hole, polygon[holeIndex], centerX, centerZ)) shape.holes.push(hole);
        }
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: heightM,
          bevelEnabled: false,
          steps: 1,
          curveSegments: 1,
        });
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, groundM, 0);
        appendGeometry(geometry, buildingPositions, buildingIndices, buildingColours, colour);
        geometry.dispose();
      }
      buildingCount++;
    }

    const geometries: THREE.BufferGeometry[] = [];
    const roadGeometry = roadPositions.length > 0 ? makeGeometry(roadPositions, roadIndices) : null;
    if (roadGeometry) {
      geometries.push(roadGeometry);
      const roadMesh = new THREE.Mesh(roadGeometry, this.roadMaterial);
      roadMesh.name = 'nyc-street-surfaces';
      roadMesh.receiveShadow = true;
      roadMesh.frustumCulled = true;
      group.add(roadMesh);
    }

    const buildingGeometry = buildingPositions.length > 0
      ? makeGeometry(buildingPositions, buildingIndices, buildingColours)
      : null;
    if (buildingGeometry) {
      geometries.push(buildingGeometry);
      const buildingMesh = new THREE.Mesh(buildingGeometry, this.buildingMaterial);
      buildingMesh.name = 'nyc-building-footprints-extruded';
      buildingMesh.castShadow = true;
      buildingMesh.receiveShadow = true;
      buildingMesh.frustumCulled = true;
      group.add(buildingMesh);
    }

    const rigidBody = roadGeometry || buildingGeometry
      ? this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(
        group.position.x, group.position.y, group.position.z,
      ))
      : null;

    if (rigidBody && roadGeometry) {
      const vertices = roadGeometry.getAttribute('position').array as Float32Array;
      const triangles = Uint32Array.from(roadGeometry.getIndex()?.array ?? []);
      if (triangles.length >= 3) {
        this.physics.createCollider(
          RAPIER.ColliderDesc.trimesh(vertices, triangles, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
            .setFriction(0.95).setRestitution(0),
          rigidBody,
        );
      }
    }

    if (rigidBody && buildingGeometry) {
      const vertices = buildingGeometry.getAttribute('position').array as Float32Array;
      const triangles = Uint32Array.from(buildingGeometry.getIndex()?.array ?? []);
      if (triangles.length >= 3) {
        this.physics.createCollider(
          RAPIER.ColliderDesc.trimesh(vertices, triangles, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
            .setFriction(0.7).setRestitution(0),
          rigidBody,
        );
      }
    }

    return { key, group, rigidBody, geometries, buildingCount, roadCount };
  }

  private removeChunk(chunk: CityChunk): void {
    this.scene.remove(chunk.group);
    if (chunk.rigidBody) this.physics.removeRigidBody(chunk.rigidBody);
    for (const geometry of chunk.geometries) geometry.dispose();
  }
}
