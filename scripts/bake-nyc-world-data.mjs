#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildBakedStreetNetwork,
  CSCL_DEFAULT_BOUNDS,
} from './nyc-street-data-core.mjs';

const DATASET_ID = 'inkn-q76z';
const PAGE_SIZE = 4000;
const MAX_PAGES = 64;
const MAX_FEATURES = PAGE_SIZE * MAX_PAGES;
const REQUEST_TIMEOUT_MS = 45000;

function parseArgs(argv) {
  const values = { ...CSCL_DEFAULT_BOUNDS, outDir: 'public/data/nyc' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error('Missing value for --' + key);
    if (key === 'out-dir') values.outDir = value;
    else if (['north', 'south', 'east', 'west'].includes(key)) values[key] = Number(value);
    else throw new Error('Unknown option: --' + key);
  }
  const { north, south, east, west } = values;
  if (![north, south, east, west].every(Number.isFinite)
    || north <= south || east <= west
    || north > 90 || south < -90 || east > 180 || west < -180) {
    throw new RangeError('A valid WGS84 --north/--south/--east/--west bounding box is required.');
  }
  return values;
}

async function fetchPage(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/geo+json, application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750 * (2 ** attempt)));
        return fetchPage(url, attempt + 1);
      }
      throw new Error('NYC Open Data returned HTTP ' + response.status + ': ' + detail);
    }
    const payload = await response.json();
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new Error('NYC Open Data did not return a GeoJSON FeatureCollection.');
    }
    return payload.features;
  } catch (error) {
    if (attempt < 5 && (error?.name === 'TimeoutError' || error?.name === 'TypeError')) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750 * (2 ** attempt)));
      return fetchPage(url, attempt + 1);
    }
    throw error;
  }
}

async function downloadCSCL(bounds) {
  const allFeatures = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://data.cityofnewyork.us/resource/' + DATASET_ID + '.geojson');
    url.searchParams.set('$select', '*');
    url.searchParams.set(
      '$where',
      'within_box(the_geom,' + bounds.north + ',' + bounds.west + ','
        + bounds.south + ',' + bounds.east + ')',
    );
    url.searchParams.set('$order', 'objectid');
    url.searchParams.set('$limit', String(PAGE_SIZE));
    url.searchParams.set('$offset', String(page * PAGE_SIZE));
    const pageFeatures = await fetchPage(url);
    allFeatures.push(...pageFeatures);
    process.stdout.write(
      'Downloaded CSCL page ' + (page + 1) + ': ' + pageFeatures.length
        + ' rows (' + allFeatures.length + ' total)\n',
    );
    if (pageFeatures.length < PAGE_SIZE) return allFeatures;
    if (allFeatures.length >= MAX_FEATURES) {
      throw new Error('CSCL query reached its safety limit; refusing to bake a truncated network.');
    }
  }
  throw new Error('CSCL query exceeded the configured page count; refusing a truncated bake.');
}


function buildSpatialTiles(payload, tileSizeM = 512) {
  const features = new Map(payload.features.map((feature) => [String(feature.id), feature]));
  const nodes = new Map(payload.graph.nodes.map((node) => [node.id, node]));
  const tiles = new Map();

  for (const edge of payload.graph.edges) {
    // Unknown traffic direction is retained in the audit graph but must never
    // become a runtime-drivable edge.
    if (!Array.isArray(edge.allowedDirections) || edge.allowedDirections.length === 0) continue;
    const feature = features.get(String(edge.geometryRef?.featureId ?? edge.sourceFeatureId));
    const path = feature?.paths?.[edge.geometryRef?.pathIndex ?? 0];
    if (!Array.isArray(path) || path.length < 2) {
      throw new Error('No preserved source polyline exists for CSCL edge ' + edge.id);
    }
    const minX = Math.min(...path.map((point) => point.x));
    const maxX = Math.max(...path.map((point) => point.x));
    const minZ = Math.min(...path.map((point) => point.z));
    const maxZ = Math.max(...path.map((point) => point.z));
    const firstX = Math.floor(minX / tileSizeM);
    const lastX = Math.floor(maxX / tileSizeM);
    const firstZ = Math.floor(minZ / tileSizeM);
    const lastZ = Math.floor(maxZ / tileSizeM);
    const tileEdge = {
      ...edge,
      geometry: path.map((point) => ({ x: point.x, y: point.y, z: point.z })),
    };

    for (let x = firstX; x <= lastX; x++) {
      for (let z = firstZ; z <= lastZ; z++) {
        const id = x + ':' + z;
        let tile = tiles.get(id);
        if (!tile) {
          tile = { id, x, z, nodes: new Map(), edges: new Map() };
          tiles.set(id, tile);
        }
        tile.edges.set(edge.id, tileEdge);
        for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
          const node = nodes.get(nodeId);
          if (!node) throw new Error('Missing graph endpoint ' + nodeId + ' for edge ' + edge.id);
          tile.nodes.set(nodeId, node);
        }
      }
    }
  }
  return [...tiles.values()].sort((a, b) => a.z - b.z || a.x - b.x);
}

async function writeSpatialTiles(outDir, payload, tileSizeM = 512) {
  const tilesDir = resolve(outDir, 'tiles');
  await mkdir(tilesDir, { recursive: true });
  const tiles = buildSpatialTiles(payload, tileSizeM);
  const records = [];
  for (const tile of tiles) {
    const bounds = {
      minX: tile.x * tileSizeM,
      maxX: (tile.x + 1) * tileSizeM,
      minZ: tile.z * tileSizeM,
      maxZ: (tile.z + 1) * tileSizeM,
    };
    const content = JSON.stringify({
      schema: 'endless-driving.nyc-street-tile',
      schemaVersion: 1,
      id: tile.id,
      bounds,
      graph: {
        nodes: [...tile.nodes.values()],
        edges: [...tile.edges.values()],
      },
    }) + '\n';
    const bytes = Buffer.byteLength(content);
    const checksum = createHash('sha256').update(content).digest('hex');
    const path = 'tiles/' + tile.x + '_' + tile.z + '.json';
    await writeFile(resolve(outDir, path), content, 'utf8');
    records.push({
      id: tile.id, path, bounds,
      sha256: checksum, bytes,
      edgeCount: tile.edges.size,
      nodeCount: tile.nodes.size,
    });
  }
  return records;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bounds = {
    north: options.north, south: options.south,
    east: options.east, west: options.west,
  };
  const sourceFeatures = await downloadCSCL(bounds);
  if (sourceFeatures.length === 0) throw new Error('CSCL query returned no road features.');
  const payload = buildBakedStreetNetwork(sourceFeatures, bounds);
  if (payload.counts.retainedFeatures === 0) {
    throw new Error('No constructed drivable CSCL segments survived normalization.');
  }

  // Hash and count the exact bytes written to disk, including the final newline.
  const data = JSON.stringify(payload) + '\n';
  const checksum = createHash('sha256').update(data).digest('hex');
  for (const [attribute, diagnostic] of Object.entries(payload.sourceFieldDiagnostics.attributes)) {
    if (diagnostic.nonNullFeatures === 0) {
      process.stderr.write('CSCL source attribute unavailable or unmapped: ' + attribute + '\\n');
    }
  }
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const tileSizeM = 512;
  const spawnNode = payload.graph.nodes
    .filter((node) => node.outgoingEdgeIds.length > 0 || node.incomingEdgeIds.length > 0)
    .sort((a, b) => Math.hypot(a.position.x, a.position.z) - Math.hypot(b.position.x, b.position.z)
      || a.id.localeCompare(b.id))[0];
  if (!spawnNode) throw new Error('Baked CSCL network has no node with a legal directed edge.');
  const tiles = await writeSpatialTiles(outDir, payload, tileSizeM);
  if (tiles.length === 0) throw new Error('Baked CSCL network produced no runtime tiles.');
  const drivableEdgeCount = payload.graph.edges.filter((edge) =>
    Array.isArray(edge.allowedDirections) && edge.allowedDirections.length > 0).length;
  const dataPath = resolve(outDir, 'nyc-street-network.json');
  const manifestPath = resolve(outDir, 'manifest.json');
  await writeFile(dataPath, data, 'utf8');
  await writeFile(manifestPath, JSON.stringify({
    schema: payload.schema,
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    source: payload.source,
    bounds,
    counts: payload.counts,
    sourceFieldDiagnostics: payload.sourceFieldDiagnostics,
    boroughCoverage: payload.boroughCoverage,
    retrievedAt: payload.retrievedAt,
    graph: {
      ...payload.graph.diagnostics,
      drivableEdgeCount,
    },
    tileSizeM,
    spawnPosition: spawnNode.position,
    tiles,
    files: {
      streetNetwork: 'nyc-street-network.json',
      sha256: checksum,
      bytes: Buffer.byteLength(data),
      tileCount: tiles.length,
      tileBytes: tiles.reduce((total, tile) => total + tile.bytes, 0),
    },
  }, null, 2) + '\n', 'utf8');

  process.stdout.write(JSON.stringify({
    result: 'PASS',
    output: dataPath,
    manifest: manifestPath,
    tileCount: tiles.length,
    tileBytes: tiles.reduce((total, tile) => total + tile.bytes, 0),
    spawnPosition: spawnNode.position,
    sha256: checksum,
    counts: payload.counts,
    sourceFieldDiagnostics: payload.sourceFieldDiagnostics,
    graph: payload.graph.diagnostics,
  }, null, 2) + '\n');
}

main().catch((error) => {
  console.error('NYC road-data bake failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
