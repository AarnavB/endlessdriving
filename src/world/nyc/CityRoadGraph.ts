export type CityRoadAxis = "x" | "z";
export type CityRoadCategory = "avenue" | "street" | "alley" | "bridge";
export type CityDirectionality = "both" | "forward" | "reverse";

export interface CityVector3 { x: number; y: number; z: number; }
export interface CityIntersection {
  id: string;
  gridX: number;
  gridZ: number;
  position: CityVector3;
  signalOffsetSeconds: number;
}
export interface CityRoadProfile {
  category: CityRoadCategory;
  axis: CityRoadAxis;
  lineIndex: number;
  lanesPerDirection: number;
  laneWidthM: number;
  widthM: number;
  speedLimitKmh: number;
  directionality: CityDirectionality;
}
export interface CityRoadSegment {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  start: CityVector3;
  end: CityVector3;
  axis: CityRoadAxis;
  lengthM: number;
  profile: CityRoadProfile;
}
export interface CityRoadEdge {
  segmentId: string;
  fromNodeId: string;
  toNodeId: string;
  direction: 1 | -1;
}
export interface CityLanePose {
  position: CityVector3;
  tangent: CityVector3;
  right: CityVector3;
  yaw: number;
  laneIndex: number;
  distanceAlongM: number;
}

export const CITY_BLOCK_SPACING_M = 160;
export const CITY_CHUNK_SIZE_M = 512;
export const CITY_LANE_WIDTH_M = 3.4;
const SIGNAL_CYCLE_SECONDS = 56;

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
function hash(value: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function nodeId(x: number, z: number): string { return String(x) + ":" + String(z); }
function parseNodeId(id: string): { x: number; z: number } {
  const parts = id.split(":");
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (parts.length !== 2 || !Number.isInteger(x) || !Number.isInteger(z)) {
    throw new Error("Invalid city intersection id: " + id);
  }
  return { x, z };
}

export class CityRoadGraph {
  private readonly intersections = new Map<string, CityIntersection>();
  private readonly segments = new Map<string, CityRoadSegment>();

  constructor(readonly seed: number) {
    if (!Number.isFinite(seed)) throw new RangeError("City graph seed must be finite.");
  }

  getIntersectionId(gridX: number, gridZ: number): string {
    if (!Number.isInteger(gridX) || !Number.isInteger(gridZ)) throw new RangeError("Grid indices must be integers.");
    return nodeId(gridX, gridZ);
  }

  getIntersection(id: string): CityIntersection {
    const existing = this.intersections.get(id);
    if (existing) return existing;
    const grid = parseNodeId(id);
    const intersection: CityIntersection = {
      id,
      gridX: grid.x,
      gridZ: grid.z,
      position: { x: grid.x * CITY_BLOCK_SPACING_M, y: 0, z: grid.z * CITY_BLOCK_SPACING_M },
      signalOffsetSeconds: (hash(id, this.seed) % 4400) / 100,
    };
    this.intersections.set(id, intersection);
    return intersection;
  }

  getIntersectionAt(gridX: number, gridZ: number): CityIntersection {
    return this.getIntersection(nodeId(gridX, gridZ));
  }

  getRoadProfile(axis: CityRoadAxis, lineIndex: number): CityRoadProfile {
    let category: CityRoadCategory = "street";
    let lanesPerDirection = 2;
    let speedLimitKmh = 35;
    let directionality: CityDirectionality = "both";
    if (axis === "z" && mod(lineIndex, 3) === 0) {
      category = "avenue";
      lanesPerDirection = 3;
      speedLimitKmh = 50;
    } else if (axis === "x" && mod(lineIndex, 11) === 4) {
      category = "bridge";
      lanesPerDirection = 2;
      speedLimitKmh = 40;
    } else if (axis === "x" && mod(lineIndex, 7) === 5) {
      category = "alley";
      lanesPerDirection = 1;
      speedLimitKmh = 22;
      directionality = mod(lineIndex, 2) === 0 ? "forward" : "reverse";
    }
    const laneWidthM = CITY_LANE_WIDTH_M;
    const widthM = directionality === "both"
      ? lanesPerDirection * 2 * laneWidthM + 2.2
      : lanesPerDirection * laneWidthM + 2.2;
    return { category, axis, lineIndex, lanesPerDirection, laneWidthM, widthM, speedLimitKmh, directionality };
  }

  getSegmentBetween(fromId: string, toId: string): CityRoadSegment {
    const from = this.getIntersection(fromId);
    const to = this.getIntersection(toId);
    const dx = to.gridX - from.gridX;
    const dz = to.gridZ - from.gridZ;
    if (Math.abs(dx) + Math.abs(dz) !== 1) {
      throw new RangeError("City segments must join adjacent orthogonal intersections.");
    }
    const axis: CityRoadAxis = dx === 0 ? "z" : "x";
    const lowX = Math.min(from.gridX, to.gridX);
    const lowZ = Math.min(from.gridZ, to.gridZ);
    const id = axis + ":" + lowX + ":" + lowZ;
    const cached = this.segments.get(id);
    if (cached) return cached;

    const startNode = axis === "x" ? this.getIntersectionAt(lowX, from.gridZ) : this.getIntersectionAt(from.gridX, lowZ);
    const endNode = axis === "x" ? this.getIntersectionAt(lowX + 1, from.gridZ) : this.getIntersectionAt(from.gridX, lowZ + 1);
    const lineIndex = axis === "x" ? from.gridZ : from.gridX;
    const segment: CityRoadSegment = {
      id,
      fromNodeId: startNode.id,
      toNodeId: endNode.id,
      start: { ...startNode.position },
      end: { ...endNode.position },
      axis,
      lengthM: CITY_BLOCK_SPACING_M,
      profile: this.getRoadProfile(axis, lineIndex),
    };
    this.segments.set(id, segment);
    return segment;
  }

  getEdgeFromTo(fromId: string, toId: string): CityRoadEdge {
    const segment = this.getSegmentBetween(fromId, toId);
    const direction: 1 | -1 = fromId === segment.fromNodeId ? 1 : -1;
    const rule = segment.profile.directionality;
    if ((rule === "forward" && direction < 0) || (rule === "reverse" && direction > 0)) {
      throw new Error("This alley is one-way in the opposite direction.");
    }
    return { segmentId: segment.id, fromNodeId: fromId, toNodeId: toId, direction };
  }

  getSegment(segmentId: string): CityRoadSegment {
    const cached = this.segments.get(segmentId);
    if (cached) return cached;
    const parts = segmentId.split(":");
    if (parts.length !== 3) throw new Error("Unknown city road segment: " + segmentId);
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    if (!Number.isInteger(first) || !Number.isInteger(second)) throw new Error("Invalid segment id: " + segmentId);
    if (parts[0] === "x") return this.getSegmentBetween(nodeId(first, second), nodeId(first + 1, second));
    if (parts[0] === "z") return this.getSegmentBetween(nodeId(first, second), nodeId(first, second + 1));
    throw new Error("Invalid segment axis: " + segmentId);
  }

  getOutgoingEdges(intersectionId: string): CityRoadEdge[] {
    const node = this.getIntersection(intersectionId);
    const candidates = [
      [node.gridX + 1, node.gridZ],
      [node.gridX - 1, node.gridZ],
      [node.gridX, node.gridZ + 1],
      [node.gridX, node.gridZ - 1],
    ];
    const result: CityRoadEdge[] = [];
    for (const [x, z] of candidates) {
      try { result.push(this.getEdgeFromTo(intersectionId, nodeId(x, z))); } catch { /* prohibited one-way edge */ }
    }
    return result;
  }

  getLanePose(edge: CityRoadEdge, laneIndex: number, distanceAlongM: number): CityLanePose {
    const segment = this.getSegment(edge.segmentId);
    const lane = Math.max(0, Math.min(segment.profile.lanesPerDirection - 1, Math.trunc(laneIndex)));
    const distance = Math.max(0, Math.min(segment.lengthM, distanceAlongM));
    const direction = edge.direction;
    const tangent = {
      x: (segment.end.x - segment.start.x) / segment.lengthM * direction,
      y: 0,
      z: (segment.end.z - segment.start.z) / segment.lengthM * direction,
    };
    const right = { x: tangent.z, y: 0, z: -tangent.x };
    const isTwoWay = segment.profile.directionality === "both";
    const laneOffset = isTwoWay
      ? segment.profile.lanesPerDirection * segment.profile.laneWidthM
        - segment.profile.laneWidthM * 0.5 - lane * segment.profile.laneWidthM
      : (segment.profile.lanesPerDirection - 1) * segment.profile.laneWidthM * 0.5
        - lane * segment.profile.laneWidthM;
    const start = direction > 0 ? segment.start : segment.end;
    return {
      position: {
        x: start.x + tangent.x * distance + right.x * laneOffset,
        y: 0,
        z: start.z + tangent.z * distance + right.z * laneOffset,
      },
      tangent,
      right,
      yaw: Math.atan2(tangent.x, tangent.z),
      laneIndex: lane,
      distanceAlongM: distance,
    };
  }

  getSpawnPose(): CityLanePose {
    const edge = this.getEdgeFromTo(nodeId(0, 0), nodeId(0, 1));
    return this.getLanePose(edge, 0, 42);
  }

  getNearestLanePose(x: number, z: number, preferredX = 0, preferredZ = 1): CityLanePose {
    const verticalLine = Math.round(x / CITY_BLOCK_SPACING_M);
    const horizontalLine = Math.round(z / CITY_BLOCK_SPACING_M);
    const verticalProfile = this.getRoadProfile("z", verticalLine);
    const horizontalProfile = this.getRoadProfile("x", horizontalLine);
    const verticalDistance = Math.abs(x - verticalLine * CITY_BLOCK_SPACING_M);
    const horizontalDistance = Math.abs(z - horizontalLine * CITY_BLOCK_SPACING_M);
    const verticalFits = verticalDistance <= verticalProfile.widthM * 0.5 + 4;
    const horizontalFits = horizontalDistance <= horizontalProfile.widthM * 0.5 + 4;
    const useVertical = verticalFits && (!horizontalFits || verticalDistance <= horizontalDistance);

    const lanePose = (axis: CityRoadAxis): CityLanePose => {
      if (axis === "z") {
        const line = verticalLine;
        const index = Math.floor(z / CITY_BLOCK_SPACING_M);
        const from = nodeId(line, index);
        const to = nodeId(line, index + 1);
        const requested = preferredZ >= 0 ? [from, to] as const : [to, from] as const;
        const edge = this.getAllowedEdge(requested[0], requested[1]);
        const progress = edge.direction > 0
          ? z - index * CITY_BLOCK_SPACING_M
          : (index + 1) * CITY_BLOCK_SPACING_M - z;
        return this.closestLanePose(edge, x, z, progress);
      }
      const index = Math.floor(x / CITY_BLOCK_SPACING_M);
      const from = nodeId(index, horizontalLine);
      const to = nodeId(index + 1, horizontalLine);
      const requested = preferredX >= 0 ? [from, to] as const : [to, from] as const;
      const edge = this.getAllowedEdge(requested[0], requested[1]);
      const progress = edge.direction > 0
        ? x - index * CITY_BLOCK_SPACING_M
        : (index + 1) * CITY_BLOCK_SPACING_M - x;
      return this.closestLanePose(edge, x, z, progress);
    };
    return lanePose(useVertical ? "z" : horizontalFits ? "x" : verticalDistance <= horizontalDistance ? "z" : "x");
  }

  getNearestRoadHeading(x: number, z: number, preferredX = 0, preferredZ = 1): CityVector3 {
    return this.getNearestLanePose(x, z, preferredX, preferredZ).tangent;
  }

  findRoute(startNodeId: string, destinationNodeId: string): CityRoadEdge[] {
    if (startNodeId === destinationNodeId) return [];
    const queue = [startNodeId];
    const previous = new Map<string, { nodeId: string; edge: CityRoadEdge }>();
    const visited = new Set<string>([startNodeId]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      for (const edge of this.getOutgoingEdges(current)) {
        if (visited.has(edge.toNodeId)) continue;
        visited.add(edge.toNodeId);
        previous.set(edge.toNodeId, { nodeId: current, edge });
        if (edge.toNodeId === destinationNodeId) {
          const route: CityRoadEdge[] = [];
          let node = destinationNodeId;
          while (node !== startNodeId) {
            const item = previous.get(node);
            if (!item) throw new Error("City route reconstruction failed.");
            route.push(item.edge);
            node = item.nodeId;
          }
          return route.reverse();
        }
        queue.push(edge.toNodeId);
      }
    }
    throw new Error("No directed city route exists.");
  }

  chooseNextEdge(intersectionId: string, previousNodeId: string, routeSeed: number): CityRoadEdge | null {
    const candidates = this.getOutgoingEdges(intersectionId)
      .filter((edge) => edge.toNodeId !== previousNodeId)
      .sort((a, b) => a.segmentId.localeCompare(b.segmentId));
    if (candidates.length === 0) return null;
    return candidates[hash(intersectionId + "|" + previousNodeId, routeSeed) % candidates.length];
  }

  private getAllowedEdge(fromId: string, toId: string): CityRoadEdge {
    try { return this.getEdgeFromTo(fromId, toId); }
    catch { return this.getEdgeFromTo(toId, fromId); }
  }

  private closestLanePose(edge: CityRoadEdge, x: number, z: number, progress: number): CityLanePose {
    const lanes = this.getSegment(edge.segmentId).profile.lanesPerDirection;
    let best = this.getLanePose(edge, 0, progress);
    let bestDistance = Infinity;
    for (let lane = 0; lane < lanes; lane++) {
      const pose = this.getLanePose(edge, lane, progress);
      const distance = (pose.position.x - x) ** 2 + (pose.position.z - z) ** 2;
      if (distance < bestDistance) { best = pose; bestDistance = distance; }
    }
    return best;
  }
}

export class CityTrafficController {
  private elapsedSeconds = 0;
  private readonly queues = new Map<string, Set<string>>();

  constructor(private readonly graph: CityRoadGraph) {}
  advance(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.elapsedSeconds += Math.min(dt, 0.1);
  }
  getElapsedSeconds(): number { return this.elapsedSeconds; }
  reset(): void { this.elapsedSeconds = 0; this.queues.clear(); }

  getSignalState(intersectionId: string, axis: CityRoadAxis): "green" | "yellow" | "red" {
    const node = this.graph.getIntersection(intersectionId);
    const phase = mod(this.elapsedSeconds + node.signalOffsetSeconds, SIGNAL_CYCLE_SECONDS);
    if (axis === "z") return phase < 16 ? "green" : phase < 18 ? "yellow" : "red";
    return phase >= 20 && phase < 36 ? "green" : phase >= 36 && phase < 38 ? "yellow" : "red";
  }

  canEnterIntersection(intersectionId: string, incomingAxis: CityRoadAxis): boolean {
    return this.getSignalState(intersectionId, incomingAxis) === "green";
  }

  /**
   * Movement-aware permission: straight and right movements use their
   * protected axis phase; left turns receive a short exclusive approach phase.
   * This avoids releasing opposing left-turn paths simultaneously.
   */
  canEnterMovement(
    intersectionId: string,
    incoming: CityRoadEdge,
    outgoing: CityRoadEdge,
  ): boolean {
    const incomingSegment = this.graph.getSegment(incoming.segmentId);
    const outgoingSegment = this.graph.getSegment(outgoing.segmentId);
    const inVector = incomingSegment.axis === "z"
      ? { x: 0, z: incoming.direction }
      : { x: incoming.direction, z: 0 };
    const outVector = outgoingSegment.axis === "z"
      ? { x: 0, z: outgoing.direction }
      : { x: outgoing.direction, z: 0 };
    const incomingYaw = Math.atan2(inVector.x, inVector.z);
    const outgoingYaw = Math.atan2(outVector.x, outVector.z);
    const delta = Math.atan2(
      Math.sin(outgoingYaw - incomingYaw),
      Math.cos(outgoingYaw - incomingYaw),
    );
    const node = this.graph.getIntersection(intersectionId);
    const phase = mod(this.elapsedSeconds + node.signalOffsetSeconds, SIGNAL_CYCLE_SECONDS);
    if (delta < -0.5) {
      let approachIndex = 0;
      if (incomingSegment.axis === "z") approachIndex = incoming.direction > 0 ? 0 : 1;
      else approachIndex = incoming.direction > 0 ? 2 : 3;
      const leftStart = 40 + approachIndex * 4;
      return phase >= leftStart && phase < leftStart + 4;
    }
    return this.getSignalState(intersectionId, incomingSegment.axis) === "green";
  }
  enqueue(intersectionId: string, vehicleId: string): void {
    let queue = this.queues.get(intersectionId);
    if (!queue) { queue = new Set<string>(); this.queues.set(intersectionId, queue); }
    queue.add(vehicleId);
  }
  dequeue(intersectionId: string, vehicleId: string): void {
    const queue = this.queues.get(intersectionId);
    if (!queue) return;
    queue.delete(vehicleId);
    if (queue.size === 0) this.queues.delete(intersectionId);
  }
  getQueueLength(intersectionId: string): number { return this.queues.get(intersectionId)?.size ?? 0; }
  clearQueues(): void { this.queues.clear(); }
}

export function globalToLocalPosition(position: CityVector3, offset: CityVector3): CityVector3 {
  return { x: position.x - offset.x, y: position.y - offset.y, z: position.z - offset.z };
}
export function localToGlobalPosition(position: CityVector3, offset: CityVector3): CityVector3 {
  return { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z };
}
