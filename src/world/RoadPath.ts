import * as THREE from 'three';
import { hashSeed } from './SeededRandom';

export const ROAD_CHUNK_LENGTH = 120;
export const ROAD_WORLD_ORIGIN_Z = -120;
export const ROAD_HALF_WIDTH = 9;
export const ROAD_LANE_OFFSETS = [-5.4, -1.8, 1.8, 5.4] as const;

const CONTROL_POINT_SPACING = 360;
const ROAD_BASE_X = 1.8;
const ROAD_BASE_Y = 0;
const CURVE_AMPLITUDE = 6.5;
const ELEVATION_AMPLITUDE = 3.2;

export interface RoadSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
}

/**
 * A deterministic, globally addressable Catmull-Rom road centreline.
 *
 * Control points are derived from (world seed, control-point index), rather
 * than generated as chunks arrive. Any chunk can therefore be rebuilt after
 * reversing or resetting, while all neighbouring chunks sample exactly the
 * same continuous path at their shared boundary.
 */
export class RoadPath {
  constructor(readonly seed: number) {}

  getDistanceAtWorldZ(worldZ: number): number {
    return worldZ - ROAD_WORLD_ORIGIN_Z;
  }

  getWorldZAtDistance(distance: number): number {
    return ROAD_WORLD_ORIGIN_Z + distance;
  }

  getChunkIndexAtWorldZ(worldZ: number): number {
    return Math.floor(this.getDistanceAtWorldZ(worldZ) / ROAD_CHUNK_LENGTH);
  }

  sampleAtWorldZ(worldZ: number): RoadSample {
    return this.sample(this.getDistanceAtWorldZ(worldZ));
  }

  sample(distance: number): RoadSample {
    const pointIndex = Math.floor(distance / CONTROL_POINT_SPACING);
    const t = (distance - pointIndex * CONTROL_POINT_SPACING) / CONTROL_POINT_SPACING;
    const p0 = this.controlPoint(pointIndex - 1);
    const p1 = this.controlPoint(pointIndex);
    const p2 = this.controlPoint(pointIndex + 1);
    const p3 = this.controlPoint(pointIndex + 2);

    const position = this.catmullRom(p0, p1, p2, p3, t);
    const tangent = this.catmullRomTangent(p0, p1, p2, p3, t).normalize();
    const right = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();

    return { position, tangent, right };
  }

  getLanePositionAtWorldZ(
    worldZ: number,
    laneOffset: number,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    const sample = this.sampleAtWorldZ(worldZ);
    target.copy(sample.position).addScaledVector(sample.right, laneOffset);
    return target;
  }

  getLanePositionAtDistance(
    distance: number,
    laneOffset: number,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    const sample = this.sample(distance);
    target.copy(sample.position).addScaledVector(sample.right, laneOffset);
    return target;
  }

  private controlPoint(index: number): THREE.Vector3 {
    const seeded = hashSeed(this.seed, index);
    const normalized = seeded / 0x100000000;
    const secondary = hashSeed(this.seed ^ 0x5f356495, index + 0x1f123bb5) / 0x100000000;
    const xOffset = index === 0 ? 0 : (normalized * 2 - 1) * CURVE_AMPLITUDE;
    const yOffset = index === 0 ? 0 : (secondary * 2 - 1) * ELEVATION_AMPLITUDE;

    return new THREE.Vector3(
      ROAD_BASE_X + xOffset,
      ROAD_BASE_Y + yOffset,
      ROAD_WORLD_ORIGIN_Z + index * CONTROL_POINT_SPACING,
    );
  }

  private catmullRom(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t: number,
  ): THREE.Vector3 {
    const t2 = t * t;
    const t3 = t2 * t;
    return new THREE.Vector3(
      0.5 * (
        2 * p1.x
        + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      ),
      0.5 * (
        2 * p1.y
        + (-p0.y + p2.y) * t
        + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
        + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      ),
      0.5 * (
        2 * p1.z
        + (-p0.z + p2.z) * t
        + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2
        + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3
      ),
    );
  }

  private catmullRomTangent(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t: number,
  ): THREE.Vector3 {
    const t2 = t * t;
    return new THREE.Vector3(
      0.5 * (
        (-p0.x + p2.x)
        + 2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t
        + 3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t2
      ),
      0.5 * (
        (-p0.y + p2.y)
        + 2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t
        + 3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t2
      ),
      0.5 * (
        (-p0.z + p2.z)
        + 2 * (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t
        + 3 * (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t2
      ),
    );
  }
}
