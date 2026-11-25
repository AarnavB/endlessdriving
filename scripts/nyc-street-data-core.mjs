const WGS84_A = 6378137;
const WGS84_INV_F = 298.257223563;
const WGS84_F = 1 / WGS84_INV_F;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG_TO_RAD = Math.PI / 180;
const ORIGIN = { latitude: 40.7595, longitude: -73.9906, altitudeM: 0 };

const originLat = ORIGIN.latitude * DEG_TO_RAD;
const originLon = ORIGIN.longitude * DEG_TO_RAD;
const originSinLat = Math.sin(originLat);
const originCosLat = Math.cos(originLat);
const originSinLon = Math.sin(originLon);
const originCosLon = Math.cos(originLon);
const originRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * originSinLat ** 2);
const originEcef = [
  (originRadius + ORIGIN.altitudeM) * originCosLat * originCosLon,
  (originRadius + ORIGIN.altitudeM) * originCosLat * originSinLon,
  (originRadius * (1 - WGS84_E2) + ORIGIN.altitudeM) * originSinLat,
];

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Convert WGS84 longitude/latitude into the game's local ENU metre frame. */
export function geographicToLocalENU(longitude, latitude, altitudeM = 0) {
  if (![longitude, latitude, altitudeM].every(Number.isFinite)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new RangeError('Invalid WGS84 coordinate in NYC street source.');
  }
  const lat = latitude * DEG_TO_RAD;
  const lon = longitude * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const ecef = [
    (radius + altitudeM) * cosLat * Math.cos(lon),
    (radius + altitudeM) * cosLat * Math.sin(lon),
    (radius * (1 - WGS84_E2) + altitudeM) * sinLat,
  ];
  const delta = [
    ecef[0] - originEcef[0],
    ecef[1] - originEcef[1],
    ecef[2] - originEcef[2],
  ];
  const eastAxis = [-originSinLon, originCosLon, 0];
  const northAxis = [
    -originSinLat * originCosLon,
    -originSinLat * originSinLon,
    originCosLat,
  ];
  return {
    x: dot(eastAxis, delta),
    // Keep the game's local vertical axis flat. Retain only a source-provided
    // third ordinate; 2D centerlines remain at zero rather than acquiring
    // artificial grade from Earth curvature across the tangent plane.
    y: altitudeM,
    z: dot(northAxis, delta),
  };
}

const ROADWAY_TYPE_NAMES = new Map([
  [1, 'street'],
  [2, 'highway'],
  [3, 'bridge'],
  [4, 'tunnel'],
  [8, 'driveway'],
  [9, 'ramp'],
  [10, 'alley'],
  [13, 'u-turn'],
]);

function readProperty(properties, ...names) {
  const entries = Object.entries(properties ?? {});
  for (const name of names) {
    const key = name.toLowerCase();
    const entry = entries.find(([candidate]) => candidate.toLowerCase() === key);
    if (entry && entry[1] !== null && entry[1] !== undefined && entry[1] !== '') return entry[1];
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Reassemble contiguous MultiLineString parts belonging to one CSCL physical
 * centerline. Disconnected parts remain distinct and are surfaced in graph
 * diagnostics instead of being forced together.
 */
export function mergeCSCLPaths(paths, toleranceM = 0.35) {
  if (!Array.isArray(paths)) throw new TypeError('CSCL paths must be an array.');
  if (!Number.isFinite(toleranceM) || toleranceM <= 0 || toleranceM > 1) {
    throw new RangeError('CSCL path-join tolerance must be greater than 0 and no more than 1 metre.');
  }
  const pending = paths.map((path) => path.map((point) => ({ ...point })));
  const chains = [];
  let reversedPartCount = 0;

  while (pending.length > 0) {
    const chain = pending.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let index = 0; index < pending.length; index++) {
        const part = pending[index];
        if (pointDistance(chain.at(-1), part[0]) <= toleranceM) {
          chain.push(...part.slice(1));
        } else if (pointDistance(chain.at(-1), part.at(-1)) <= toleranceM) {
          chain.push(...part.slice(0, -1).reverse());
          reversedPartCount++;
        } else if (pointDistance(chain[0], part.at(-1)) <= toleranceM) {
          chain.unshift(...part.slice(0, -1));
        } else if (pointDistance(chain[0], part[0]) <= toleranceM) {
          chain.unshift(...part.slice(1).reverse());
          reversedPartCount++;
        } else {
          continue;
        }
        pending.splice(index, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }

  return {
    paths: chains,
    sourcePathPartCount: paths.length,
    mergedPathPartCount: paths.length - chains.length,
    reversedPartCount,
  };
}

function normalizePath(coordinates) {
  if (!Array.isArray(coordinates)) return null;
  const path = [];
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const longitude = finiteNumber(coordinate[0]);
    const latitude = finiteNumber(coordinate[1]);
    const altitude = coordinate.length > 2 ? finiteNumber(coordinate[2]) ?? 0 : 0;
    if (longitude === null || latitude === null) continue;
    const local = geographicToLocalENU(longitude, latitude, altitude);
    const previous = path.at(-1);
    if (!previous || Math.hypot(local.x - previous.x, local.y - previous.y, local.z - previous.z) >= 0.15) {
      path.push(local);
    }
  }
  return path.length >= 2 ? path : null;
}

/**
 * Convert one constructed, motor-vehicle CSCL feature into compact local data.
 * Non-constructed, non-physical, path-only and non-vehicular rows are excluded.
 */
export function normalizeCSCLFeature(feature, fallbackIndex = 0) {
  if (!feature || feature.type !== 'Feature' || !feature.properties || !feature.geometry) {
    return { feature: null, reason: 'invalid-feature' };
  }

  const properties = feature.properties;
  const statusCode = finiteNumber(readProperty(properties, 'status'));
  if (statusCode !== 2) return { feature: null, reason: 'not-constructed' };

  const roadwayTypeCode = finiteNumber(readProperty(properties, 'rw_type'));
  const roadwayType = ROADWAY_TYPE_NAMES.get(roadwayTypeCode);
  if (!roadwayType) return { feature: null, reason: 'non-drivable-roadway-type' };

  const trafficCode = String(readProperty(properties, 'trafdir') ?? 'UN').trim().toUpperCase();
  if (trafficCode === 'NV') return { feature: null, reason: 'non-vehicular' };
  const trafficDirection = trafficCode === 'FT' || trafficCode === 'TF' || trafficCode === 'TW'
    ? trafficCode
    : 'UN';

  const geometry = feature.geometry;
  let rawPaths;
  if (geometry.type === 'LineString') rawPaths = [geometry.coordinates];
  else if (geometry.type === 'MultiLineString') rawPaths = geometry.coordinates;
  else return { feature: null, reason: 'unsupported-geometry' };

  if (!Array.isArray(rawPaths)) return { feature: null, reason: 'invalid-geometry' };
  const sourcePaths = rawPaths.map(normalizePath).filter(Boolean);
  if (sourcePaths.length === 0) return { feature: null, reason: 'empty-path' };
  const pathMerge = mergeCSCLPaths(sourcePaths);
  const paths = pathMerge.paths;

  const objectId = readProperty(properties, 'objectid');
  const physicalId = readProperty(properties, 'physicalid');
  const segmentId = readProperty(properties, 'segmentid');
  const sourceId = objectId ?? segmentId ?? physicalId ?? feature.id ?? fallbackIndex;
  const widthFeet = finiteNumber(readProperty(
    properties, 'streetwidth', 'streetwidth_min', 'st_width', 'street_width', 'paved_width', 'stwidth',
  ));
  const widthM = widthFeet !== null && widthFeet > 0 ? widthFeet * 0.3048 : null;
  const streetName = readProperty(
    properties, 'stname_label', 'stname_lab', 'st_label', 'st_name', 'streetname', 'street_name', 'name',
  );
  const fromLevelCode = finiteNumber(readProperty(
    properties, 'from_level_code', 'frm_lvl_co', 'from_lvl_co', 'from_level',
  ));
  const toLevelCode = finiteNumber(readProperty(properties, 'to_level_code', 'to_lvl_co', 'to_level'));
  const numberTravelLanes = finiteNumber(readProperty(properties, 'number_travel_lanes'));
  const numberTotalLanes = finiteNumber(readProperty(properties, 'number_total_lanes'));
  const postedSpeed = finiteNumber(readProperty(properties, 'posted_speed'));

  return {
    feature: {
      id: String(sourceId),
      physicalId: physicalId === null ? null : String(physicalId),
      streetName: streetName === null ? null : String(streetName).trim(),
      roadwayType,
      roadwayTypeCode,
      trafficDirection,
      fromLevelCode,
      toLevelCode,
      numberTravelLanes,
      numberTotalLanes,
      postedSpeed,
      widthM,
      bikeLane: readProperty(properties, 'bike_lane'),
      sourcePathPartCount: pathMerge.sourcePathPartCount,
      mergedPathPartCount: pathMerge.mergedPathPartCount,
      reversedPartCount: pathMerge.reversedPartCount,
      paths,
    },
    reason: null,
  };
}

/**
 * Report the actual fields and non-null coverage returned by the live source.
 * This makes field-name drift visible rather than silently baking null data.
 */
export function summarizeCSCLSourceFields(features) {
  if (!Array.isArray(features)) throw new TypeError('CSCL source features must be an array.');
  const fields = new Map();
  for (const feature of features) {
    for (const [name, value] of Object.entries(feature?.properties ?? {})) {
      const key = name.toLowerCase();
      const current = fields.get(key) ?? { name, nonNullFeatures: 0 };
      if (value !== null && value !== undefined && value !== '') current.nonNullFeatures++;
      fields.set(key, current);
    }
  }
  const propertyNames = [...fields.values()].map((field) => field.name).sort((a, b) => a.localeCompare(b));
  const resolve = (...aliases) => {
    const matches = aliases.map((alias) => fields.get(alias.toLowerCase())).filter(Boolean);
    const selected = matches.find((field) => field.nonNullFeatures > 0) ?? matches[0] ?? null;
    return {
      selectedField: selected?.name ?? null,
      nonNullFeatures: selected?.nonNullFeatures ?? 0,
      matchingFields: matches.map((field) => ({ name: field.name, nonNullFeatures: field.nonNullFeatures })),
    };
  };
  return {
    propertyCount: propertyNames.length,
    propertyNames,
    attributes: {
      streetName: resolve('stname_label', 'stname_lab', 'st_label', 'st_name', 'streetname', 'street_name', 'name'),
      widthFeet: resolve('streetwidth', 'streetwidth_min', 'st_width', 'street_width', 'paved_width', 'stwidth'),
      fromLevelCode: resolve('from_level_code', 'frm_lvl_co', 'from_lvl_co', 'from_level'),
      toLevelCode: resolve('to_level_code', 'to_lvl_co', 'to_level'),
      numberTravelLanes: resolve('number_travel_lanes'),
      numberTotalLanes: resolve('number_total_lanes'),
      postedSpeed: resolve('posted_speed'),
    },
  };
}

/**
 * Build a directed endpoint graph from CSCL intersection-to-intersection
 * physical centerlines. Only source segment endpoints are snapped. Interior
 * line crossings are never connected simply because they are nearby.
 *
 * FT follows source centerline/address-range direction, TF reverses it, and
 * TW allows both directions. Source level codes keep grade-separated
 * endpoints from becoming the same junction.
 */
export function buildCSCLRoadGraph(features, toleranceM = 0.75) {
  if (!Array.isArray(features)) throw new TypeError('Normalized CSCL features must be an array.');
  if (!Number.isFinite(toleranceM) || toleranceM <= 0 || toleranceM > 2) {
    throw new RangeError('CSCL graph endpoint tolerance must be greater than 0 and no more than 2 metres.');
  }

  const nodes = new Map();
  const edges = [];
  const spatial = new Map();
  const adjacency = new Map();
  const cellSize = toleranceM;
  const directions = (code) => code === 'FT' ? ['forward']
    : code === 'TF' ? ['reverse']
      : code === 'TW' ? ['forward', 'reverse'] : [];
  const levelIdentity = (value) => Number.isInteger(value) ? String(value) : 'unknown';
  const cellKey = (x, z) => Math.floor(x / cellSize) + ':' + Math.floor(z / cellSize);

  function getOrCreateNode(point, levelCode) {
    const identity = levelIdentity(levelCode);
    const snapLimit = identity === 'unknown' || identity === '99' ? 0.2 : toleranceM;
    const cellX = Math.floor(point.x / cellSize);
    const cellZ = Math.floor(point.z / cellSize);
    let best = null;
    let bestDistance = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidates = spatial.get((cellX + dx) + ':' + (cellZ + dz)) ?? [];
        for (const candidateId of candidates) {
          const candidate = nodes.get(candidateId);
          if (levelIdentity(candidate.levelCode) !== identity) continue;
          const distance = pointDistance(candidate.position, point);
          if (distance <= snapLimit && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
    }

    if (best) {
      best.sampleCount++;
      best.position.x += (point.x - best.position.x) / best.sampleCount;
      best.position.y += (point.y - best.position.y) / best.sampleCount;
      best.position.z += (point.z - best.position.z) / best.sampleCount;
      return best;
    }

    const baseId = 'cscl-node:' + Math.round(point.x * 100)
      + ':' + Math.round(point.z * 100) + ':' + identity;
    let id = baseId;
    let suffix = 1;
    while (nodes.has(id)) id = baseId + ':' + String(suffix++);
    const node = {
      id,
      position: { x: point.x, y: point.y, z: point.z },
      levelCode: Number.isInteger(levelCode) ? levelCode : null,
      sampleCount: 1,
      incidentEdgeIds: [],
      incomingEdgeIds: [],
      outgoingEdgeIds: [],
    };
    nodes.set(id, node);
    const key = cellKey(point.x, point.z);
    const bucket = spatial.get(key) ?? [];
    bucket.push(id);
    spatial.set(key, bucket);
    adjacency.set(id, new Set());
    return node;
  }

  let disconnectedMultipartFeatureCount = 0;
  let disconnectedMultipartPathCount = 0;
  let reversedMultipartPartCount = 0;
  let selfLoopEdgeCount = 0;
  let unknownDirectionEdgeCount = 0;
  let zeroLengthEdgeCount = 0;

  for (const feature of features) {
    if (feature.paths.length > 1) {
      disconnectedMultipartFeatureCount++;
      disconnectedMultipartPathCount += feature.paths.length - 1;
    }
    reversedMultipartPartCount += feature.reversedPartCount ?? 0;

    for (let pathIndex = 0; pathIndex < feature.paths.length; pathIndex++) {
      const path = feature.paths[pathIndex];
      if (!Array.isArray(path) || path.length < 2) continue;
      const from = getOrCreateNode(path[0], feature.fromLevelCode);
      const to = getOrCreateNode(path.at(-1), feature.toLevelCode);
      const allowedDirections = directions(feature.trafficDirection);
      const directionality = allowedDirections.length === 2 ? 'both'
        : allowedDirections.length === 1 ? allowedDirections[0] : 'unknown';
      const lengthM = path.slice(1).reduce((total, point, index) =>
        total + Math.hypot(point.x - path[index].x, point.z - path[index].z), 0);
      if (lengthM <= 0.01) zeroLengthEdgeCount++;
      if (from.id === to.id) selfLoopEdgeCount++;
      if (allowedDirections.length === 0) unknownDirectionEdgeCount++;

      const edge = {
        id: String(feature.id) + ':' + String(pathIndex),
        sourceFeatureId: String(feature.id),
        physicalId: feature.physicalId,
        geometryRef: { featureId: String(feature.id), pathIndex },
        fromNodeId: from.id,
        toNodeId: to.id,
        fromLevelCode: feature.fromLevelCode,
        toLevelCode: feature.toLevelCode,
        trafficDirection: feature.trafficDirection,
        directionality,
        allowedDirections,
        roadwayType: feature.roadwayType,
        roadwayTypeCode: feature.roadwayTypeCode,
        streetName: feature.streetName,
        widthM: feature.widthM,
        numberTravelLanes: feature.numberTravelLanes,
        numberTotalLanes: feature.numberTotalLanes,
        postedSpeedSourceValue: feature.postedSpeed,
        lengthM,
      };
      edges.push(edge);
      if (!from.incidentEdgeIds.includes(edge.id)) from.incidentEdgeIds.push(edge.id);
      if (!to.incidentEdgeIds.includes(edge.id)) to.incidentEdgeIds.push(edge.id);
      if (allowedDirections.includes('forward')) {
        from.outgoingEdgeIds.push(edge.id);
        to.incomingEdgeIds.push(edge.id);
      }
      if (allowedDirections.includes('reverse')) {
        to.outgoingEdgeIds.push(edge.id);
        from.incomingEdgeIds.push(edge.id);
      }
      adjacency.get(from.id).add(to.id);
      adjacency.get(to.id).add(from.id);
    }
  }

  const degreeHistogram = {};
  for (const node of nodes.values()) {
    node.degree = node.incidentEdgeIds.length;
    degreeHistogram[node.degree] = (degreeHistogram[node.degree] ?? 0) + 1;
    delete node.sampleCount;
  }

  const componentSizes = [];
  const visited = new Set();
  for (const startId of nodes.keys()) {
    if (visited.has(startId)) continue;
    const stack = [startId];
    visited.add(startId);
    let size = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      size++;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    componentSizes.push(size);
  }
  componentSizes.sort((a, b) => b - a);

  const levelCells = new Map();
  const differentLevelPairs = new Set();
  for (const node of nodes.values()) {
    const key = cellKey(node.position.x, node.position.z);
    const bucket = levelCells.get(key) ?? [];
    for (const otherId of bucket) {
      const other = nodes.get(otherId);
      if (other.levelCode === node.levelCode) continue;
      if (Math.hypot(
        other.position.x - node.position.x,
        other.position.z - node.position.z,
      ) <= toleranceM) {
        differentLevelPairs.add([other.id, node.id].sort().join('|'));
      }
    }
    bucket.push(node.id);
    levelCells.set(key, bucket);
  }

  const nodeList = [...nodes.values()].map((node) => ({
    id: node.id,
    position: node.position,
    levelCode: node.levelCode,
    degree: node.degree,
    incidentEdgeIds: node.incidentEdgeIds,
    incomingEdgeIds: node.incomingEdgeIds,
    outgoingEdgeIds: node.outgoingEdgeIds,
  }));
  const twoWayEdgeCount = edges.filter((edge) => edge.directionality === 'both').length;
  const oneWayEdgeCount = edges.filter((edge) =>
    edge.directionality === 'forward' || edge.directionality === 'reverse').length;
  const largestComponentNodeCount = componentSizes[0] ?? 0;

  return {
    schemaVersion: 1,
    topologySource: 'NYC CSCL PHYSICALID intersection-to-intersection centerlines',
    endpointSnapToleranceM: toleranceM,
    crossingPolicy: 'Only source centerline endpoints are noded. Interior crossings are not connected by proximity; source endpoint level codes separate stacked roads.',
    nodes: nodeList,
    edges,
    diagnostics: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      connectedComponentCount: componentSizes.length,
      largestComponentNodeCount,
      largestComponentShare: nodes.size > 0 ? largestComponentNodeCount / nodes.size : 0,
      terminalNodeCount: nodeList.filter((node) => node.degree === 1).length,
      junctionNodeCount: nodeList.filter((node) => node.degree >= 3).length,
      isolatedNodeCount: nodeList.filter((node) => node.degree === 0).length,
      maximumNodeDegree: Math.max(0, ...nodeList.map((node) => node.degree)),
      degreeHistogram,
      twoWayEdgeCount,
      oneWayEdgeCount,
      unknownDirectionEdgeCount,
      zeroLengthEdgeCount,
      selfLoopEdgeCount,
      coincidentDifferentLevelNodePairCount: differentLevelPairs.size,
      disconnectedMultipartFeatureCount,
      disconnectedMultipartPathCount,
      reversedMultipartPartCount,
    },
  };
}

export function buildBakedStreetNetwork(features, bounds, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(features)) throw new TypeError('CSCL source features must be an array.');
  const normalized = [];
  const rejected = {};
  const seenIds = new Set();

  for (let index = 0; index < features.length; index++) {
    const result = normalizeCSCLFeature(features[index], index);
    if (!result.feature) {
      rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
      continue;
    }
    const item = result.feature;
    if (seenIds.has(item.id)) {
      rejected['duplicate-source-id'] = (rejected['duplicate-source-id'] ?? 0) + 1;
      continue;
    }
    seenIds.add(item.id);
    normalized.push(item);
  }

  normalized.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const graph = buildCSCLRoadGraph(normalized);
  return {
    schema: 'endless-driving.nyc-street-network',
    schemaVersion: 3,
    sourceFieldDiagnostics: summarizeCSCLSourceFields(features),
    graph,
    generatedAt,
    source: {
      datasetId: 'inkn-q76z',
      title: 'NYC Street Centerline (CSCL)',
      provider: 'NYC Office of Technology and Innovation',
      url: 'https://data.cityofnewyork.us/City-Government/NYC-Street-Centerline-CSCL-/inkn-q76z',
      trafficDirectionSemantics: {
        FT: 'with the segment address range',
        TF: 'against the segment address range',
        TW: 'two-way',
        NV: 'non-vehicular; excluded from this drivable network',
      },
      roadwayTypeSemantics: Object.fromEntries(ROADWAY_TYPE_NAMES),
      levelCodeSemantics: {
        '1-12': 'below grade 1-12', '13': 'at grade',
        '14-26': 'above grade 1-13', '99': 'not applicable',
      },
    },
    coordinateFrame: {
      name: 'local-ENU',
      units: 'metres',
      axes: '+X east, +Y source height, +Z north',
      verticalAxis: 'source third ordinate in metres; 2D coordinates use 0; not a terrain elevation model',
      origin: ORIGIN,
      sourceCoordinates: 'WGS84 longitude/latitude',
    },
    bounds,
    counts: {
      sourceFeatures: features.length,
      retainedFeatures: normalized.length,
      rejectedFeatures: features.length - normalized.length,
      rejectedByReason: rejected,
      paths: normalized.reduce((total, item) => total + item.paths.length, 0),
      sourcePathParts: normalized.reduce((total, item) => total + item.sourcePathPartCount, 0),
      mergedPathParts: normalized.reduce((total, item) => total + item.mergedPathPartCount, 0),
      reversedPathParts: normalized.reduce((total, item) => total + item.reversedPartCount, 0),
      vertices: normalized.reduce((total, item) =>
        total + item.paths.reduce((sum, path) => sum + path.length, 0), 0),
    },
    features: normalized,
  };
}

export const CSCL_DEFAULT_BOUNDS = Object.freeze({
  // Lower Manhattan through central / upper Manhattan, the Hudson edge and
  // the East River. The exact polygon will be clipped against source geometry.
  north: 40.835,
  south: 40.694,
  east: -73.927,
  west: -74.055,
});
