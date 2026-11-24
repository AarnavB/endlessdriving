import { isHudsonWater } from "./NYCWaterfrontLayout";

export type CityRoadAxis = "x" | "z";
export type CityRoadCategory = "avenue" | "street" | "alley" | "bridge" | "expressway" | "ramp" | "underpass";
export type CityDirectionality = "both" | "forward" | "reverse";
export type CityRoadType = "surface" | "elevated-highway" | "entrance-ramp" | "exit-ramp" | "underpass";
export type CityRoadLevelKind = "ground" | "elevated" | "ramp" | "underpass";
export type CityIntersectionType = "at-grade" | "merge" | "diverge" | "grade-separated";

export interface CityVector3 { x: number; y: number; z: number; }
export interface CityIntersection {
  id: string;
  gridX: number;
  gridZ: number;
  position: CityVector3;
  elevationM: number;
  level: number;
  kind: CityRoadLevelKind;
  intersectionType: CityIntersectionType;
  signalControlled: boolean;
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
  level: number;
  roadType: CityRoadType;
  maxGradient: number;
  horizontalCurvature: number;
  verticalCurvature: number;
  controlPoints?: [CityVector3, CityVector3];
  label?: string;
}
export interface CityRoadEdge {
  segmentId: string;
  fromNodeId: string;
  toNodeId: string;
  direction: 1 | -1;
}
export interface CityCenterlinePose {
  position: CityVector3;
  tangent: CityVector3;
  right: CityVector3;
  up: CityVector3;
  yaw: number;
  pitch: number;
}
export interface CityLanePose extends CityCenterlinePose {
  laneIndex: number;
  distanceAlongM: number;
}

/** A legal transition between two road segments at a specific lane. */
export interface CityLaneConnection {
  edge: CityRoadEdge;
  fromLaneIndex: number;
  toLaneIndex: number;
  movement: "through" | "ramp-entry" | "ramp-exit";
}

export interface CityInterchangeDescriptor {
  groundEntryNodeId: string;
  groundExitNodeId: string;
  deckCrossingNodeId: string;
  entryRampSegmentIds: string[];
  exitRampSegmentIds: string[];
  highwaySegmentIds: string[];
  underpassSegmentIds: string[];
}

export const CITY_BLOCK_SPACING_M = 160;
export const CITY_CHUNK_SIZE_M = 512;
export const CITY_LANE_WIDTH_M = 3.4;
export const CITY_HIGHWAY_ELEVATION_M = 7.2;
const SIGNAL_CYCLE_SECONDS = 56;
const CURVE_SAMPLE_COUNT = 48;

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
function levelNodeId(level: number, x: number, z: number): string {
  return "level:" + String(level) + ":" + String(x) + ":" + String(z);
}
function parseNodeId(id: string): { x: number; z: number } {
  const parts = id.split(":");
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (parts.length !== 2 || !Number.isInteger(x) || !Number.isInteger(z)) {
    throw new Error("Invalid city intersection id: " + id);
  }
  return { x, z };
}
function vectorLength(v: CityVector3): number {
  return Math.hypot(v.x, v.y, v.z);
}
function normalize(v: CityVector3): CityVector3 {
  const length = vectorLength(v) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
function subtract(a: CityVector3, b: CityVector3): CityVector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function addScaled(a: CityVector3, b: CityVector3, scale: number): CityVector3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}
function cross(a: CityVector3, b: CityVector3): CityVector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

interface CurveSample {
  distance: number;
  t: number;
  position: CityVector3;
}

export class CityRoadGraph {
  private readonly intersections = new Map<string, CityIntersection>();
  private readonly segments = new Map<string, CityRoadSegment>();
  private readonly customSegments = new Map<string, CityRoadSegment>();
  private readonly customAdjacency = new Map<string, CityRoadEdge[]>();
  private readonly curveTables = new Map<string, CurveSample[]>();
  private interchange!: CityInterchangeDescriptor;

  constructor(readonly seed: number) {
    if (!Number.isFinite(seed)) throw new RangeError("City graph seed must be finite.");
    this.buildRepresentativeInterchange();
  }

  /**
   * Ground-level IDs retain their established x:z form. A non-zero level is
   * part of the identity, so coincident X/Z coordinates never imply a link.
   */
  getIntersectionId(gridX: number, gridZ: number, level = 0): string {
    if (!Number.isInteger(gridX) || !Number.isInteger(gridZ) || !Number.isInteger(level)) {
      throw new RangeError("Grid indices and road levels must be integers.");
    }
    return level === 0 ? nodeId(gridX, gridZ) : levelNodeId(level, gridX, gridZ);
  }

  getIntersection(id: string): CityIntersection {
    const existing = this.intersections.get(id);
    if (existing) return existing;
    if (id.startsWith("level:")) {
      const parts = id.split(":");
      const level = Number(parts[1]);
      const gridX = Number(parts[2]);
      const gridZ = Number(parts[3]);
      if (parts.length === 4 && level === 1 && Number.isInteger(gridX) && gridZ === 2) {
        this.ensureHighwayNode(gridX);
        return this.intersections.get(id)!;
      }
      throw new Error("Unknown elevated road node; register it with addRoadNode first: " + id);
    }
    const grid = parseNodeId(id);
    const intersection: CityIntersection = {
      id,
      gridX: grid.x,
      gridZ: grid.z,
      position: { x: grid.x * CITY_BLOCK_SPACING_M, y: 0, z: grid.z * CITY_BLOCK_SPACING_M },
      elevationM: 0,
      level: 0,
      kind: "ground",
      intersectionType: "at-grade",
      signalControlled: true,
      signalOffsetSeconds: (hash(id, this.seed) % 4400) / 100,
    };
    this.intersections.set(id, intersection);
    return intersection;
  }

  getIntersectionAt(gridX: number, gridZ: number, level = 0): CityIntersection {
    return this.getIntersection(this.getIntersectionId(gridX, gridZ, level));
  }

  /**
   * Register an additional graph node on any integer road layer. Level zero
   * IDs remain compatible with the original grid; every other level is part
   * of the ID, preventing grade-separated intersections from aliasing.
   */
  addRoadNode(
    gridX: number,
    gridZ: number,
    position: CityVector3,
    level: number,
    kind: CityRoadLevelKind,
    intersectionType: CityIntersectionType = "grade-separated",
    signalControlled = false,
  ): string {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      throw new RangeError("Road-node position must contain finite world coordinates.");
    }
    if (!Number.isInteger(level)) throw new RangeError("Road-node level must be an integer.");
    const id = this.getIntersectionId(gridX, gridZ, level);
    if (this.intersections.has(id)) throw new Error("Road node already exists: " + id);
    this.registerNode(id, gridX, gridZ, position, level, kind, intersectionType, signalControlled);
    return id;
  }

  /**
   * Add a connected curve-based road segment between previously registered
   * nodes. This is the supported extension point for future interchanges,
   * frontage roads, flyovers, underpasses and streamed connector ramps.
   */
  addRoadSegment(
    id: string,
    fromNodeId: string,
    toNodeId: string,
    roadType: CityRoadType,
    profile: CityRoadProfile,
    controlPoints: [CityVector3, CityVector3],
    label = id,
    maxGradient = 0.045,
  ): CityRoadSegment {
    if (!id || this.customSegments.has(id) || this.segments.has(id)) {
      throw new Error("Road segment ID must be unique and non-empty: " + id);
    }
    if (!this.intersections.has(fromNodeId) || !this.intersections.has(toNodeId)) {
      throw new Error("Both endpoint nodes must be registered before adding a road segment.");
    }
    if (fromNodeId === toNodeId) throw new RangeError("Road segment endpoints must be distinct.");
    if (!Number.isFinite(maxGradient) || maxGradient <= 0 || maxGradient > 0.2) {
      throw new RangeError("Maximum road gradient must be between 0 and 0.2.");
    }
    if (!Number.isFinite(profile.widthM) || profile.widthM <= 0
      || !Number.isInteger(profile.lanesPerDirection) || profile.lanesPerDirection < 1
      || !Number.isFinite(profile.laneWidthM) || profile.laneWidthM <= 0) {
      throw new RangeError("Road profile must provide positive width, lane width and lane count.");
    }
    for (const point of controlPoints) {
      if (![point.x, point.y, point.z].every(Number.isFinite)) {
        throw new RangeError("Road control points must contain finite world coordinates.");
      }
    }
    return this.registerCustomSegment(
      id, fromNodeId, toNodeId, roadType, profile, controlPoints, label, maxGradient,
    );
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
    if (from.level !== 0 || to.level !== 0) {
      throw new RangeError("Grid segments are ground-level only; use an explicit levelled connection.");
    }
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
    const profile = this.getRoadProfile(axis, lineIndex);
    // The north/south street through grid line zero is the designated
    // grade-separated underpass beneath the east/west expressway.
    const roadType: CityRoadType = axis === "z" && lineIndex === 0 ? "underpass" : "surface";
    const segment: CityRoadSegment = {
      id,
      fromNodeId: startNode.id,
      toNodeId: endNode.id,
      start: { ...startNode.position },
      end: { ...endNode.position },
      axis,
      lengthM: CITY_BLOCK_SPACING_M,
      // Keep the street's established functional profile (e.g. avenue);
      // grade separation is represented independently by roadType.
      profile,
      level: 0,
      roadType,
      maxGradient: 0.08,
      horizontalCurvature: 0,
      verticalCurvature: 0,
    };
    this.segments.set(id, segment);
    return segment;
  }

  getEdgeFromTo(fromId: string, toId: string): CityRoadEdge {
    const custom = this.customAdjacency.get(fromId)?.find((edge) => edge.toNodeId === toId);
    if (custom) return { ...custom };
    const segment = this.getSegmentBetween(fromId, toId);
    if (segment.roadType === "surface") {
      // Crossings require an explicit bridge/grade-separated graph edge.
      const samples = Math.max(1, Math.ceil(segment.lengthM / 4));
      for (let sample = 0; sample <= samples; sample++) {
        const t = sample / samples;
        const x = segment.start.x + (segment.end.x - segment.start.x) * t;
        const z = segment.start.z + (segment.end.z - segment.start.z) * t;
        if (isHudsonWater(x, z, 1.5)) {
          throw new Error("A surface road cannot traverse the Hudson River water polygon.");
        }
      }
    }
    const direction: 1 | -1 = fromId === segment.fromNodeId ? 1 : -1;
    const rule = segment.profile.directionality;
    if ((rule === "forward" && direction < 0) || (rule === "reverse" && direction > 0)) {
      throw new Error("This alley is one-way in the opposite direction.");
    }
    return { segmentId: segment.id, fromNodeId: fromId, toNodeId: toId, direction };
  }

  getSegment(segmentId: string): CityRoadSegment {
    const special = this.customSegments.get(segmentId);
    if (special) return special;
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
    const result: CityRoadEdge[] = [];
    if (node.level === 0 && node.gridZ === 2
      && Math.abs(node.gridX) % 8 === 0
      && (node.gridX < -3 || node.gridX > 5)) {
      this.ensureProceduralRamp(node.gridX);
    }
    if (node.level === 1 && node.kind === "elevated" && node.gridZ === 2) {
      this.ensureHighwaySegment(node.gridX - 1);
      this.ensureHighwaySegment(node.gridX);
    }
    if (node.level === 0) {
      const candidates = [
        [node.gridX + 1, node.gridZ],
        [node.gridX - 1, node.gridZ],
        [node.gridX, node.gridZ + 1],
        [node.gridX, node.gridZ - 1],
      ];
      for (const [x, z] of candidates) {
        try { result.push(this.getEdgeFromTo(intersectionId, nodeId(x, z))); }
        catch { /* prohibited one-way edge or absent explicit connection */ }
      }
    }
    for (const edge of this.customAdjacency.get(intersectionId) ?? []) result.push({ ...edge });
    return result;
  }

  getCenterlinePose(segmentId: string, distanceAlongM: number, direction: 1 | -1 = 1): CityCenterlinePose {
    const segment = this.getSegment(segmentId);
    const distance = Math.max(0, Math.min(segment.lengthM, distanceAlongM));
    const canonicalDistance = direction > 0 ? distance : segment.lengthM - distance;
    const sample = this.sampleSegment(segment, canonicalDistance);
    const tangent = normalize({
      x: sample.tangent.x * direction,
      y: sample.tangent.y * direction,
      z: sample.tangent.z * direction,
    });
    const horizontalLength = Math.hypot(tangent.x, tangent.z) || 1;
    const right = normalize({ x: tangent.z / horizontalLength, y: 0, z: -tangent.x / horizontalLength });
    const up = normalize(cross(tangent, right));
    return {
      position: { ...sample.position },
      tangent,
      right,
      up,
      yaw: Math.atan2(tangent.x, tangent.z),
      pitch: Math.atan2(tangent.y, horizontalLength),
    };
  }

  getLanePose(edge: CityRoadEdge, laneIndex: number, distanceAlongM: number): CityLanePose {
    const segment = this.getSegment(edge.segmentId);
    const lane = Math.max(0, Math.min(segment.profile.lanesPerDirection - 1, Math.trunc(laneIndex)));
    const distance = Math.max(0, Math.min(segment.lengthM, distanceAlongM));
    const center = this.getCenterlinePose(segment.id, distance, edge.direction);
    const isTwoWay = segment.profile.directionality === "both";
    const laneOffset = isTwoWay
      ? segment.profile.lanesPerDirection * segment.profile.laneWidthM
        - segment.profile.laneWidthM * 0.5 - lane * segment.profile.laneWidthM
      : (segment.profile.lanesPerDirection - 1) * segment.profile.laneWidthM * 0.5
        - lane * segment.profile.laneWidthM;
    return {
      ...center,
      position: addScaled(center.position, center.right, laneOffset),
      laneIndex: lane,
      distanceAlongM: distance,
    };
  }

  /**
   * Resolve a road-to-road movement at lane level. Lane zero is the
   * rightmost lane in the direction of travel under the graph's right-hand
   * traffic convention. Highway ramp access is legal only from that lane,
   * and a ramp-to-highway movement is assigned to that lane on the deck.
   */
  getLaneConnection(
    incomingEdge: CityRoadEdge,
    incomingLaneIndex: number,
    outgoingEdge: CityRoadEdge,
  ): CityLaneConnection | null {
    if (incomingEdge.toNodeId !== outgoingEdge.fromNodeId
      || outgoingEdge.toNodeId === incomingEdge.fromNodeId) return null;

    const incomingSegment = this.getSegment(incomingEdge.segmentId);
    const outgoingSegment = this.getSegment(outgoingEdge.segmentId);
    const fromLaneIndex = Math.max(0, Math.min(
      incomingSegment.profile.lanesPerDirection - 1,
      Math.trunc(incomingLaneIndex),
    ));
    let toLaneIndex = Math.max(0, Math.min(
      outgoingSegment.profile.lanesPerDirection - 1,
      fromLaneIndex,
    ));
    let movement: CityLaneConnection["movement"] = "through";

    const outgoingIsRamp = outgoingSegment.roadType === "entrance-ramp"
      || outgoingSegment.roadType === "exit-ramp";
    const incomingIsRamp = incomingSegment.roadType === "entrance-ramp"
      || incomingSegment.roadType === "exit-ramp";

    if (incomingSegment.roadType === "elevated-highway" && outgoingIsRamp) {
      // A ramp must diverge from the shoulder-side lane, never cut across
      // inner lanes. Check the physical side as well as the lane index: a
      // ramp on the opposite shoulder is not a legal right-hand exit.
      if (fromLaneIndex !== 0) return null;
      const deckPose = this.getCenterlinePose(
        incomingSegment.id, incomingSegment.lengthM, incomingEdge.direction,
      );
      const rampPose = this.getCenterlinePose(
        outgoingSegment.id, Math.min(40, outgoingSegment.lengthM), outgoingEdge.direction,
      );
      const lateral = (rampPose.position.x - deckPose.position.x) * deckPose.right.x
        + (rampPose.position.y - deckPose.position.y) * deckPose.right.y
        + (rampPose.position.z - deckPose.position.z) * deckPose.right.z;
      if (lateral <= 0.5) return null;
      movement = "ramp-exit";
    } else if (incomingIsRamp && outgoingSegment.roadType === "elevated-highway") {
      // Every ramp joins the outside lane of the receiving carriageway.
      toLaneIndex = 0;
      movement = "ramp-entry";
    }

    return {
      edge: { ...outgoingEdge },
      fromLaneIndex,
      toLaneIndex,
      movement,
    };
  }

  getOutgoingLaneConnections(
    incomingEdge: CityRoadEdge,
    incomingLaneIndex: number,
  ): CityLaneConnection[] {
    return this.getOutgoingEdges(incomingEdge.toNodeId)
      .filter((edge) => edge.toNodeId !== incomingEdge.fromNodeId)
      .map((edge) => this.getLaneConnection(incomingEdge, incomingLaneIndex, edge))
      .filter((connection): connection is CityLaneConnection => connection !== null);
  }

  getSpawnPose(): CityLanePose {
    const edge = this.getEdgeFromTo(nodeId(0, 0), nodeId(0, 1));
    return this.getLanePose(edge, 0, 42);
  }

  getNearestLanePose(
    x: number,
    z: number,
    preferredX = 0,
    preferredZ = 1,
    preferredY = 0,
  ): CityLanePose {
    // Build nearby levelled geometry on demand as well as during chunk load,
    // so recovery and road-heading queries work on streamed highway sections.
    this.getSpecialSegmentsInBounds(x - 28, x + 28, z - 28, z + 28);
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

    const gridPose = lanePose(useVertical ? "z" : horizontalFits ? "x"
      : verticalDistance <= horizontalDistance ? "z" : "x");
    let bestPose = gridPose;
    let bestDistance = (gridPose.position.x - x) ** 2
      + (gridPose.position.y - preferredY) ** 2 + (gridPose.position.z - z) ** 2;

    // Curved and elevated segments are sampled in 3D, so a road above an
    // underpass cannot win a nearest-road query solely on horizontal distance.
    for (const segment of this.customSegments.values()) {
      const minX = Math.min(segment.start.x, segment.end.x, ...(segment.controlPoints ?? []).map((p) => p.x));
      const maxX = Math.max(segment.start.x, segment.end.x, ...(segment.controlPoints ?? []).map((p) => p.x));
      const minZ = Math.min(segment.start.z, segment.end.z, ...(segment.controlPoints ?? []).map((p) => p.z));
      const maxZ = Math.max(segment.start.z, segment.end.z, ...(segment.controlPoints ?? []).map((p) => p.z));
      if (x < minX - segment.profile.widthM - 12 || x > maxX + segment.profile.widthM + 12
        || z < minZ - segment.profile.widthM - 12 || z > maxZ + segment.profile.widthM + 12) continue;
      for (const direction of [1, -1] as const) {
        const edge = this.customAdjacency.get(direction > 0 ? segment.fromNodeId : segment.toNodeId)
          ?.find((candidate) => candidate.segmentId === segment.id && candidate.direction === direction);
        if (!edge) continue;
        for (let distance = 0; distance <= segment.lengthM; distance += 8) {
          const progress = Math.min(distance, segment.lengthM);
          for (let lane = 0; lane < segment.profile.lanesPerDirection; lane++) {
            const pose = this.getLanePose(edge, lane, progress);
            const score = (pose.position.x - x) ** 2
              + (pose.position.y - preferredY) ** 2 + (pose.position.z - z) ** 2;
            if (score < bestDistance) { bestDistance = score; bestPose = pose; }
          }
        }
      }
    }
    return bestPose;
  }

  getNearestRoadHeading(x: number, z: number, preferredX = 0, preferredZ = 1, preferredY = 0): CityVector3 {
    return this.getNearestLanePose(x, z, preferredX, preferredZ, preferredY).tangent;
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

  chooseNextEdge(
    intersectionId: string,
    previousNodeId: string,
    routeSeed: number,
    incomingEdge?: CityRoadEdge,
    incomingLaneIndex = 0,
  ): CityRoadEdge | null {
    let candidates = this.getOutgoingEdges(intersectionId)
      .filter((edge) => edge.toNodeId !== previousNodeId);
    if (incomingEdge) {
      if (incomingEdge.toNodeId !== intersectionId
        || incomingEdge.fromNodeId !== previousNodeId) return null;
      candidates = candidates.filter((edge) =>
        this.getLaneConnection(incomingEdge, incomingLaneIndex, edge) !== null);
    }
    candidates.sort((a, b) => a.segmentId.localeCompare(b.segmentId));
    if (candidates.length === 0) return null;
    return candidates[hash(intersectionId + "|" + previousNodeId, routeSeed) % candidates.length];
  }

  getInterchangeDescriptor(): CityInterchangeDescriptor {
    return {
      groundEntryNodeId: this.interchange.groundEntryNodeId,
      groundExitNodeId: this.interchange.groundExitNodeId,
      deckCrossingNodeId: this.interchange.deckCrossingNodeId,
      entryRampSegmentIds: [...this.interchange.entryRampSegmentIds],
      exitRampSegmentIds: [...this.interchange.exitRampSegmentIds],
      highwaySegmentIds: [...this.interchange.highwaySegmentIds],
      underpassSegmentIds: [...this.interchange.underpassSegmentIds],
    };
  }

  getSpecialSegmentsInBounds(minX: number, maxX: number, minZ: number, maxZ: number): CityRoadSegment[] {
    if (minZ <= 350 && maxZ >= 290) {
      const firstGridX = Math.floor(minX / CITY_BLOCK_SPACING_M) - 1;
      const lastGridX = Math.ceil(maxX / CITY_BLOCK_SPACING_M) + 1;
      for (let gridX = firstGridX; gridX <= lastGridX; gridX++) {
        this.ensureHighwaySegment(gridX);
        if (Math.abs(gridX) % 8 === 0 && (gridX < -3 || gridX > 5)) {
          this.ensureProceduralRamp(gridX);
        }
      }
    }
    const result: CityRoadSegment[] = [];
    for (const segment of this.customSegments.values()) {
      const points = [segment.start, segment.end, ...(segment.controlPoints ?? [])];
      const segmentMinX = Math.min(...points.map((p) => p.x)) - segment.profile.widthM;
      const segmentMaxX = Math.max(...points.map((p) => p.x)) + segment.profile.widthM;
      const segmentMinZ = Math.min(...points.map((p) => p.z)) - segment.profile.widthM;
      const segmentMaxZ = Math.max(...points.map((p) => p.z)) + segment.profile.widthM;
      if (segmentMaxX >= minX && segmentMinX <= maxX && segmentMaxZ >= minZ && segmentMinZ <= maxZ) {
        result.push(segment);
      }
    }
    return result;
  }

  getUnderpassSegments(): CityRoadSegment[] {
    const ids = this.interchange.underpassSegmentIds;
    return ids.map((id) => this.getSegment(id));
  }

  private ensureHighwayNode(gridX: number): string {
    const gridZ = 2;
    const id = this.getIntersectionId(gridX, gridZ, 1);
    if (!this.intersections.has(id)) {
      this.registerNode(
        id, gridX, gridZ,
        { x: gridX * CITY_BLOCK_SPACING_M, y: CITY_HIGHWAY_ELEVATION_M, z: gridZ * CITY_BLOCK_SPACING_M },
        1, "elevated", "grade-separated", false,
      );
    }
    return id;
  }

  private ensureHighwaySegment(gridX: number): void {
    const fromNodeId = this.ensureHighwayNode(gridX);
    const toNodeId = this.ensureHighwayNode(gridX + 1);
    const fromNode = this.getIntersection(fromNodeId);
    const toNode = this.getIntersection(toNodeId);
    // Levelled ramp endpoints may share the highway grid row, but are not
    // deck nodes. Only connect two true elevated deck nodes with an
    // expressway segment; designated ramp links own every level transition.
    if (fromNode.kind !== "elevated" || toNode.kind !== "elevated") return;
    const existing = (this.customAdjacency.get(fromNodeId) ?? [])
      .some((edge) => edge.toNodeId === toNodeId);
    if (existing) return;

    const startX = gridX * CITY_BLOCK_SPACING_M;
    const id = "nyc:expressway:east-west:" + String(gridX);
    const profile: CityRoadProfile = {
      category: "expressway", axis: "x", lineIndex: 2, lanesPerDirection: 3,
      laneWidthM: 3.65, widthM: 28.2, speedLimitKmh: 80, directionality: "both",
    };
    this.registerCustomSegment(
      id, fromNodeId, toNodeId, "elevated-highway", profile,
      [
        { x: startX + CITY_BLOCK_SPACING_M / 3, y: CITY_HIGHWAY_ELEVATION_M, z: 320 },
        { x: startX + CITY_BLOCK_SPACING_M * 2 / 3, y: CITY_HIGHWAY_ELEVATION_M, z: 320 },
      ],
      "Deterministic east-west elevated urban expressway",
      0.045,
    );
  }

  private ensureProceduralRamp(gridX: number): void {
    if (Math.abs(gridX) % 8 !== 0 || (gridX >= -3 && gridX <= 5)) return;
    const groundNodeId = this.getIntersectionId(gridX, 2);
    this.getIntersection(groundNodeId);

    // The climb is deliberately routed beside the expressway deck. A single
    // diagonal ramp would pass through the deck footprint before reaching its
    // elevation; the parallel climb keeps a clear vertical and lateral envelope.
    const rampMidNodeId = this.getIntersectionId(gridX + 1, 3, 1);
    const rampTopNodeId = this.getIntersectionId(gridX + 2, 3, 1);
    const deckNodeId = this.ensureHighwayNode(gridX + 3);
    const startX = gridX * CITY_BLOCK_SPACING_M;
    const rampOffsetZ = 304;
    const midX = startX + CITY_BLOCK_SPACING_M;
    const topX = startX + CITY_BLOCK_SPACING_M * 2;
    if (!this.intersections.has(rampMidNodeId)) {
      this.registerNode(
        rampMidNodeId, gridX + 1, 3,
        { x: midX, y: CITY_HIGHWAY_ELEVATION_M * 0.5, z: rampOffsetZ },
        1, "ramp", "merge", false,
      );
    }
    if (!this.intersections.has(rampTopNodeId)) {
      this.registerNode(
        rampTopNodeId, gridX + 2, 3,
        { x: topX, y: CITY_HIGHWAY_ELEVATION_M, z: rampOffsetZ },
        1, "ramp", "merge", false,
      );
    }
    const rampProfile: CityRoadProfile = {
      category: "ramp", axis: "x", lineIndex: 2, lanesPerDirection: 1,
      laneWidthM: 3.55, widthM: 9.4, speedLimitKmh: 45, directionality: "both",
    };
    const lowerId = "nyc:ramp:" + String(gridX) + ":lower";
    const climbId = "nyc:ramp:" + String(gridX) + ":climb";
    const mergeId = "nyc:ramp:" + String(gridX) + ":merge";
    if (!this.customSegments.has(lowerId)) {
      this.registerCustomSegment(
        lowerId, groundNodeId, rampMidNodeId, "entrance-ramp", rampProfile,
        [
          { x: startX + CITY_BLOCK_SPACING_M / 3, y: 0, z: 320 },
          { x: startX + CITY_BLOCK_SPACING_M * 2 / 3, y: CITY_HIGHWAY_ELEVATION_M * 0.5, z: rampOffsetZ },
        ],
        "Procedural expressway entrance ramp - lower transition",
        0.045,
      );
    }
    if (!this.customSegments.has(climbId)) {
      this.registerCustomSegment(
        climbId, rampMidNodeId, rampTopNodeId, "entrance-ramp", rampProfile,
        [
          { x: midX + CITY_BLOCK_SPACING_M / 3, y: CITY_HIGHWAY_ELEVATION_M * 0.5, z: rampOffsetZ },
          { x: midX + CITY_BLOCK_SPACING_M * 2 / 3, y: CITY_HIGHWAY_ELEVATION_M, z: rampOffsetZ },
        ],
        "Procedural expressway entrance ramp - parallel climb",
        0.045,
      );
    }
    if (!this.customSegments.has(mergeId)) {
      this.registerCustomSegment(
        mergeId, rampTopNodeId, deckNodeId, "exit-ramp", rampProfile,
        [
          { x: topX + CITY_BLOCK_SPACING_M / 3, y: CITY_HIGHWAY_ELEVATION_M, z: rampOffsetZ },
          { x: topX + CITY_BLOCK_SPACING_M * 2 / 3, y: CITY_HIGHWAY_ELEVATION_M, z: 320 },
        ],
        "Procedural expressway merge ramp - level transition",
        0.045,
      );
    }
    this.ensureHighwaySegment(gridX + 2);
    this.ensureHighwaySegment(gridX + 3);
  }

  private registerNode(
    id: string,
    gridX: number,
    gridZ: number,
    position: CityVector3,
    level: number,
    kind: CityRoadLevelKind,
    intersectionType: CityIntersectionType,
    signalControlled: boolean,
  ): void {
    this.intersections.set(id, {
      id, gridX, gridZ, position: { ...position }, elevationM: position.y, level, kind,
      intersectionType, signalControlled,
      signalOffsetSeconds: (hash(id, this.seed) % 4400) / 100,
    });
  }

  private registerCustomSegment(
    id: string,
    fromNodeId: string,
    toNodeId: string,
    roadType: CityRoadType,
    profile: CityRoadProfile,
    controlPoints: [CityVector3, CityVector3],
    label: string,
    maxGradient = 0.045,
  ): CityRoadSegment {
    const fromNode = this.getIntersection(fromNodeId);
    const toNode = this.getIntersection(toNodeId);
    const start = { ...fromNode.position };
    const end = { ...toNode.position };
    const segment: CityRoadSegment = {
      id, fromNodeId, toNodeId, start, end,
      axis: Math.abs(end.x - start.x) >= Math.abs(end.z - start.z) ? "x" : "z",
      lengthM: 0, profile,
      level: Math.max(fromNode.level, toNode.level), roadType, maxGradient, horizontalCurvature: 0,
      verticalCurvature: 0, controlPoints: [{ ...controlPoints[0] }, { ...controlPoints[1] }], label,
    };
    const table = this.buildCurveTable(segment);
    segment.lengthM = table[table.length - 1].distance;
    let maxHorizontalCurvature = 0;
    let maxVerticalCurvature = 0;
    let lastYaw = Math.atan2(table[1].position.x - table[0].position.x, table[1].position.z - table[0].position.z);
    let lastGrade = 0;
    for (let i = 1; i < table.length; i++) {
      const a = table[i - 1].position;
      const b = table[i].position;
      const run = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6;
      const grade = Math.abs((b.y - a.y) / run);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      maxHorizontalCurvature = Math.max(maxHorizontalCurvature, Math.abs(angleDelta(lastYaw, yaw)) / Math.max(0.01, table[i].distance - table[i - 1].distance));
      maxVerticalCurvature = Math.max(maxVerticalCurvature, Math.abs(grade - lastGrade) / Math.max(0.01, table[i].distance - table[i - 1].distance));
      lastYaw = yaw;
      lastGrade = grade;
    }
    for (let i = 1; i < table.length; i++) {
      const a = table[i - 1].position;
      const b = table[i].position;
      const horizontalRun = Math.hypot(b.x - a.x, b.z - a.z);
      const grade = Math.abs(b.y - a.y) / Math.max(1e-6, horizontalRun);
      if (grade > maxGradient + 1e-4) {
        throw new RangeError("Road segment " + id + " exceeds its declared maximum gradient.");
      }
    }
    segment.horizontalCurvature = maxHorizontalCurvature;
    segment.verticalCurvature = maxVerticalCurvature;
    this.customSegments.set(id, segment);
    this.curveTables.set(id, table);
    const forward: CityRoadEdge = { segmentId: id, fromNodeId, toNodeId, direction: 1 };
    const reverse: CityRoadEdge = { segmentId: id, fromNodeId: toNodeId, toNodeId: fromNodeId, direction: -1 };
    const addEdge = (node: string, edge: CityRoadEdge): void => {
      const edges = this.customAdjacency.get(node) ?? [];
      edges.push(edge);
      this.customAdjacency.set(node, edges);
    };
    if (profile.directionality !== "reverse") addEdge(fromNodeId, forward);
    if (profile.directionality !== "forward") addEdge(toNodeId, reverse);
    return segment;
  }

  private buildRepresentativeInterchange(): void {
    const groundEntryNodeId = this.getIntersectionId(-3, 2);
    const groundExitNodeId = this.getIntersectionId(5, 2);
    this.getIntersection(groundEntryNodeId);
    this.getIntersection(groundExitNodeId);

    const entryMidNodeId = this.getIntersectionId(-2, 2, 1);
    const deckStartNodeId = this.getIntersectionId(-1, 2, 1);
    const deckCrossingNodeId = this.getIntersectionId(0, 2, 1);
    const deckNodeOneId = this.getIntersectionId(1, 2, 1);
    const deckNodeTwoId = this.getIntersectionId(2, 2, 1);
    const deckExitNodeId = this.getIntersectionId(3, 2, 1);
    const exitMidNodeId = this.getIntersectionId(4, 2, 1);

    this.registerNode(entryMidNodeId, -2, 2, { x: -320, y: 3.6, z: 304 }, 1, "ramp", "merge", false);
    this.registerNode(deckStartNodeId, -1, 2, { x: -160, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, 1, "elevated", "merge", false);
    this.registerNode(deckCrossingNodeId, 0, 2, { x: 0, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, 1, "elevated", "grade-separated", false);
    this.registerNode(deckNodeOneId, 1, 2, { x: 160, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, 1, "elevated", "grade-separated", false);
    this.registerNode(deckNodeTwoId, 2, 2, { x: 320, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, 1, "elevated", "grade-separated", false);
    this.registerNode(deckExitNodeId, 3, 2, { x: 480, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, 1, "elevated", "merge", false);
    this.registerNode(exitMidNodeId, 4, 2, { x: 640, y: 3.6, z: 304 }, 1, "ramp", "merge", false);

    const rampProfile: CityRoadProfile = {
      category: "ramp", axis: "x", lineIndex: 2, lanesPerDirection: 1,
      laneWidthM: 3.55, widthM: 9.4, speedLimitKmh: 45, directionality: "both",
    };
    const highwayProfile: CityRoadProfile = {
      category: "expressway", axis: "x", lineIndex: 2, lanesPerDirection: 3,
      laneWidthM: 3.65, widthM: 28.2, speedLimitKmh: 80, directionality: "both",
    };

    const entryRampSegmentIds = [
      "interchange:entrance-ramp:west-a",
      "interchange:entrance-ramp:west-b",
    ];
    this.registerCustomSegment(
      entryRampSegmentIds[0], groundEntryNodeId, entryMidNodeId, "entrance-ramp", rampProfile,
      [{ x: -426.6667, y: 0, z: 320 }, { x: -373.3333, y: 3.6, z: 304 }],
      "West entrance ramp - lower transition",
    );
    this.registerCustomSegment(
      entryRampSegmentIds[1], entryMidNodeId, deckStartNodeId, "entrance-ramp", rampProfile,
      [{ x: -266.6667, y: 3.6, z: 304 }, { x: -213.3333, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }],
      "West entrance ramp - upper transition",
    );

    const highwayNodeIds = [deckStartNodeId, deckCrossingNodeId, deckNodeOneId, deckNodeTwoId, deckExitNodeId];
    const highwaySegmentIds: string[] = [];
    for (let i = 0; i < highwayNodeIds.length - 1; i++) {
      const id = "interchange:elevated-highway:" + String(i);
      this.registerCustomSegment(
        id, highwayNodeIds[i], highwayNodeIds[i + 1], "elevated-highway", highwayProfile,
        [
          { x: this.getIntersection(highwayNodeIds[i]).position.x + 160 / 3, y: CITY_HIGHWAY_ELEVATION_M, z: 320 },
          { x: this.getIntersection(highwayNodeIds[i]).position.x + 320 / 3, y: CITY_HIGHWAY_ELEVATION_M, z: 320 },
        ],
        "East-west elevated urban expressway",
      );
      highwaySegmentIds.push(id);
    }

    const exitRampSegmentIds = [
      "interchange:exit-ramp:east-a",
      "interchange:exit-ramp:east-b",
    ];
    this.registerCustomSegment(
      exitRampSegmentIds[0], deckExitNodeId, exitMidNodeId, "exit-ramp", rampProfile,
      [{ x: 533.3333, y: CITY_HIGHWAY_ELEVATION_M, z: 320 }, { x: 586.6667, y: 3.6, z: 304 }],
      "East exit ramp - upper transition",
    );
    this.registerCustomSegment(
      exitRampSegmentIds[1], exitMidNodeId, groundExitNodeId, "exit-ramp", rampProfile,
      [{ x: 693.3333, y: 3.6, z: 304 }, { x: 746.6667, y: 0, z: 320 }],
      "East exit ramp - lower transition",
    );

    const underpassSegmentIds = [
      this.getSegmentBetween(this.getIntersectionId(0, 1), this.getIntersectionId(0, 2)).id,
      this.getSegmentBetween(this.getIntersectionId(0, 2), this.getIntersectionId(0, 3)).id,
    ];
    this.interchange = {
      groundEntryNodeId,
      groundExitNodeId,
      deckCrossingNodeId,
      entryRampSegmentIds,
      exitRampSegmentIds,
      highwaySegmentIds,
      underpassSegmentIds,
    };
  }

  private buildCurveTable(segment: CityRoadSegment): CurveSample[] {
    const samples: CurveSample[] = [{ distance: 0, t: 0, position: { ...segment.start } }];
    let cumulative = 0;
    let previous = segment.start;
    for (let i = 1; i <= CURVE_SAMPLE_COUNT; i++) {
      const t = i / CURVE_SAMPLE_COUNT;
      const position = this.evaluateCurve(segment, t);
      cumulative += vectorLength(subtract(position, previous));
      samples.push({ distance: cumulative, t, position });
      previous = position;
    }
    return samples;
  }

  private evaluateCurve(segment: CityRoadSegment, t: number): CityVector3 {
    if (!segment.controlPoints) {
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * t,
        y: segment.start.y + (segment.end.y - segment.start.y) * t,
        z: segment.start.z + (segment.end.z - segment.start.z) * t,
      };
    }
    const u = 1 - t;
    const c1 = segment.controlPoints[0];
    const c2 = segment.controlPoints[1];
    return {
      x: u ** 3 * segment.start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * segment.end.x,
      y: u ** 3 * segment.start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * segment.end.y,
      z: u ** 3 * segment.start.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t ** 3 * segment.end.z,
    };
  }

  private evaluateCurveTangent(segment: CityRoadSegment, t: number): CityVector3 {
    if (!segment.controlPoints) return subtract(segment.end, segment.start);
    const u = 1 - t;
    const c1 = segment.controlPoints[0];
    const c2 = segment.controlPoints[1];
    return {
      x: 3 * u * u * (c1.x - segment.start.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (segment.end.x - c2.x),
      y: 3 * u * u * (c1.y - segment.start.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (segment.end.y - c2.y),
      z: 3 * u * u * (c1.z - segment.start.z) + 6 * u * t * (c2.z - c1.z) + 3 * t * t * (segment.end.z - c2.z),
    };
  }

  private sampleSegment(
    segment: CityRoadSegment,
    distance: number,
  ): { position: CityVector3; tangent: CityVector3 } {
    if (!segment.controlPoints) {
      return {
        position: this.evaluateCurve(segment, distance / Math.max(1e-6, segment.lengthM)),
        tangent: normalize(subtract(segment.end, segment.start)),
      };
    }
    const table = this.curveTables.get(segment.id) ?? this.buildCurveTable(segment);
    const clamped = Math.max(0, Math.min(segment.lengthM, distance));
    let low = 0;
    let high = table.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (table[middle].distance < clamped) low = middle + 1;
      else high = middle;
    }
    const upper = table[Math.min(table.length - 1, low)];
    const lower = table[Math.max(0, low - 1)];
    const span = upper.distance - lower.distance;
    const blend = span > 1e-8 ? (clamped - lower.distance) / span : 0;
    const t = lower.t + (upper.t - lower.t) * blend;
    return {
      position: this.evaluateCurve(segment, t),
      tangent: normalize(this.evaluateCurveTangent(segment, t)),
    };
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
    if (!node.signalControlled) return "green";
    const phase = mod(this.elapsedSeconds + node.signalOffsetSeconds, SIGNAL_CYCLE_SECONDS);
    if (axis === "z") return phase < 16 ? "green" : phase < 18 ? "yellow" : "red";
    return phase >= 20 && phase < 36 ? "green" : phase >= 36 && phase < 38 ? "yellow" : "red";
  }

  canEnterIntersection(intersectionId: string, incomingAxis: CityRoadAxis): boolean {
    return this.getSignalState(intersectionId, incomingAxis) === "green";
  }

  getProtectedLeftTurnState(
    intersectionId: string,
    incomingAxis: CityRoadAxis,
    direction: 1 | -1,
  ): "green" | "red" {
    const node = this.graph.getIntersection(intersectionId);
    if (!node.signalControlled) return "red";
    const phase = mod(this.elapsedSeconds + node.signalOffsetSeconds, SIGNAL_CYCLE_SECONDS);
    const approachIndex = incomingAxis === "z"
      ? direction > 0 ? 0 : 1
      : direction > 0 ? 2 : 3;
    const leftStart = 40 + approachIndex * 4;
    return phase >= leftStart && phase < leftStart + 4 ? "green" : "red";
  }

  canEnterMovement(
    intersectionId: string,
    incoming: CityRoadEdge,
    outgoing: CityRoadEdge,
  ): boolean {
    const node = this.graph.getIntersection(intersectionId);
    if (!node.signalControlled || node.intersectionType !== "at-grade") return true;
    const incomingSegment = this.graph.getSegment(incoming.segmentId);
    const inPose = this.graph.getCenterlinePose(incoming.segmentId, incomingSegment.lengthM, incoming.direction);
    const outPose = this.graph.getCenterlinePose(outgoing.segmentId, 0, outgoing.direction);
    const incomingYaw = Math.atan2(inPose.tangent.x, inPose.tangent.z);
    const outgoingYaw = Math.atan2(outPose.tangent.x, outPose.tangent.z);
    const delta = angleDelta(incomingYaw, outgoingYaw);
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
