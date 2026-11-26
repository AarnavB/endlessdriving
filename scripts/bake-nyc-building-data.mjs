#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { geographicToLocalENU, CSCL_DEFAULT_BOUNDS } from './nyc-street-data-core.mjs';

const DATASET_ID = '5zhs-2jue';
const PAGE_SIZE = 4000;
const MAX_PAGES = 320;
const PAGE_CONCURRENCY = 3;
const TILE_SIZE_M = 512;
const FEET_TO_METRES = 0.3048;
const FALLBACK_HEIGHT_M = 8;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function property(properties, ...names) {
  for (const name of names) {
    if (properties?.[name] !== undefined && properties[name] !== null) return properties[name];
  }
  return null;
}
async function fetchPage(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/geo+json, application/json' },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750 * (2 ** attempt)));
        return fetchPage(url, attempt + 1);
      }
      throw new Error('NYC BUILDING Open Data returned HTTP ' + response.status + ': ' + detail);
    }
    const payload = await response.json();
    if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new Error('NYC BUILDING endpoint did not return a GeoJSON FeatureCollection.');
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
async function downloadBuildingPage(bounds, page) {
  const url = new URL('https://data.cityofnewyork.us/resource/' + DATASET_ID + '.geojson');
  url.searchParams.set('$select', 'the_geom,objectid,doitt_id,bin,base_bbl,feature_code,geom_source,ground_elevation,height_roof,construction_year,name,last_status_type');
  url.searchParams.set('$where', 'within_box(the_geom,' + bounds.north + ',' + bounds.west + ',' + bounds.south + ',' + bounds.east + ')');
  url.searchParams.set('$order', 'objectid');
  url.searchParams.set('$limit', String(PAGE_SIZE));
  url.searchParams.set('$offset', String(page * PAGE_SIZE));
  return fetchPage(url);
}

async function downloadBuildings(bounds) {
  const features = [];
  for (let firstPage = 0; firstPage < MAX_PAGES; firstPage += PAGE_CONCURRENCY) {
    const pages = Array.from(
      { length: Math.min(PAGE_CONCURRENCY, MAX_PAGES - firstPage) },
      (_, index) => firstPage + index,
    );
    // Bounded concurrency shortens the full-city bake without overwhelming the public API.
    const results = await Promise.all(pages.map((page) => downloadBuildingPage(bounds, page)));
    for (let index = 0; index < results.length; index++) {
      const page = pages[index];
      const result = results[index];
      features.push(...result);
      process.stdout.write('Downloaded NYC building page ' + (page + 1) + ': '
        + result.length + ' rows (' + features.length + ' total)\n');
      if (result.length < PAGE_SIZE) return features;
    }
  }
  throw new Error('NYC BUILDING query exceeded the configured page count; refusing a truncated footprint bake.');
}

function normalizePolygon(rawPolygon) {
  if (!Array.isArray(rawPolygon) || rawPolygon.length === 0) return null;
  const rings = [];
  for (const rawRing of rawPolygon) {
    if (!Array.isArray(rawRing) || rawRing.length < 4) continue;
    const ring = [];
    for (const coordinate of rawRing) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
      const longitude = finite(coordinate[0]);
      const latitude = finite(coordinate[1]);
      if (longitude === null || latitude === null) continue;
      const local = geographicToLocalENU(longitude, latitude, 0);
      const previous = ring.at(-1);
      if (!previous || Math.hypot(local.x - previous.x, local.z - previous.z) > 0.02) {
        ring.push({ x: local.x, z: local.z });
      }
    }
    if (ring.length >= 4) {
      const first = ring[0], last = ring.at(-1);
      if (Math.hypot(first.x - last.x, first.z - last.z) > 0.02) ring.push({ ...first });
      rings.push(ring);
    }
  }
  return rings.length > 0 ? rings : null;
}

function normalizeFeature(feature) {
  if (!feature || feature.type !== 'Feature' || !feature.properties || !feature.geometry) return null;
  const p = feature.properties;
  const featureCode = finite(property(p, 'feature_code'));
  // Only constructed building and garage footprints are represented as solids.
  // Canopies, tanks, temporary structures and placeholder geometry are not buildings.
  if (featureCode !== 2100 && featureCode !== 5110) return null;
  const geometry = feature.geometry;
  const sourcePolygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const polygons = sourcePolygons.map(normalizePolygon).filter(Boolean);
  if (polygons.length === 0) return null;

  const primaryRing = polygons[0][0];
  const centroid = primaryRing.slice(0, -1).reduce((sum, point) => ({
    x: sum.x + point.x / Math.max(1, primaryRing.length - 1),
    z: sum.z + point.z / Math.max(1, primaryRing.length - 1),
  }), { x: 0, z: 0 });
  const sourceHeightFt = finite(property(p, 'height_roof'));
  const groundElevationFt = finite(property(p, 'ground_elevation'));
  const idValue = property(p, 'doitt_id', 'objectid') ?? feature.id;
  if (idValue === null || idValue === undefined) return null;

  return {
    id: String(idValue),
    bin: property(p, 'bin') === null ? null : String(property(p, 'bin')),
    baseBbl: property(p, 'base_bbl') === null ? null : String(property(p, 'base_bbl')),
    name: property(p, 'name') === null ? null : String(property(p, 'name')).trim(),
    featureCode,
    constructionYear: finite(property(p, 'construction_year')),
    geometrySource: property(p, 'geom_source') === null ? null : String(property(p, 'geom_source')),
    sourceHeightFt: sourceHeightFt !== null && sourceHeightFt > 0 ? sourceHeightFt : null,
    groundElevationM: groundElevationFt !== null ? groundElevationFt * FEET_TO_METRES : null,
    heightM: sourceHeightFt !== null && sourceHeightFt > 0
      ? sourceHeightFt * FEET_TO_METRES : null,
    heightSource: sourceHeightFt !== null && sourceHeightFt > 0 ? 'height_roof' : 'feature-code-median',
    centroid,
    polygons,
  };
}

function boroughFromBin(value) {
  const prefix = String(value ?? '').trim().slice(0, 1);
  return ({
    '1': 'Manhattan',
    '2': 'The Bronx',
    '3': 'Brooklyn',
    '4': 'Queens',
    '5': 'Staten Island',
  })[prefix] ?? 'Unknown';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return FALLBACK_HEIGHT_M;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function makeTiles(buildings) {
  const byFeatureCode = new Map();
  for (const building of buildings) {
    if (building.heightM !== null) {
      const bucket = byFeatureCode.get(building.featureCode) ?? [];
      bucket.push(building.heightM);
      byFeatureCode.set(building.featureCode, bucket);
    }
  }
  for (const building of buildings) {
    if (building.heightM === null) {
      building.heightM = median(byFeatureCode.get(building.featureCode) ?? []);
      building.heightSource = byFeatureCode.has(building.featureCode)
        ? 'feature-code-median' : 'configurable-fallback';
    }
    // Protect the geometry budget from invalid outliers while preserving a
    // legitimate high-rise distribution. The source height remains recorded.
    building.heightM = Math.max(2.5, Math.min(500, building.heightM));
  }

  const tiles = new Map();
  for (const building of buildings) {
    const x = Math.floor(building.centroid.x / TILE_SIZE_M);
    const z = Math.floor(building.centroid.z / TILE_SIZE_M);
    const id = x + ':' + z;
    const tile = tiles.get(id) ?? { id, x, z, buildings: new Map() };
    tile.buildings.set(building.id, building);
    tiles.set(id, tile);
  }
  return [...tiles.values()].sort((a, b) => a.z - b.z || a.x - b.x);
}

async function writeTiles(outDir, buildings) {
  const tilesDir = resolve(outDir, 'tiles');
  await mkdir(tilesDir, { recursive: true });
  const tiles = makeTiles(buildings);
  const records = [];
  for (const tile of tiles) {
    const bounds = {
      minX: tile.x * TILE_SIZE_M, maxX: (tile.x + 1) * TILE_SIZE_M,
      minZ: tile.z * TILE_SIZE_M, maxZ: (tile.z + 1) * TILE_SIZE_M,
    };
    const content = JSON.stringify({
      schema: 'endless-driving.nyc-building-tile',
      schemaVersion: 1,
      id: tile.id,
      bounds,
      buildings: [...tile.buildings.values()],
    }) + '\n';
    const bytes = Buffer.byteLength(content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const path = 'tiles/' + tile.x + '_' + tile.z + '.json';
    await writeFile(resolve(outDir, path), content, 'utf8');
    records.push({
      id: tile.id, path, bounds, sha256, bytes,
      buildingCount: tile.buildings.size,
    });
  }
  return records;
}

async function main() {
  const bounds = CSCL_DEFAULT_BOUNDS;
  const raw = await downloadBuildings(bounds);
  const unique = new Map();
  for (const feature of raw) {
    const building = normalizeFeature(feature);
    if (building && !unique.has(building.id)) unique.set(building.id, building);
  }
  const buildings = [...unique.values()];
  if (buildings.length === 0) throw new Error('NYC BUILDING query produced no valid constructed footprint polygons.');
  const outDir = resolve('public/data/nyc/buildings');
  await mkdir(outDir, { recursive: true });
  const tiles = await writeTiles(outDir, buildings);
  const sourceHeightCount = buildings.filter((item) => item.heightSource === 'height_roof').length;
  const inferredHeightCount = buildings.length - sourceHeightCount;
  const retrievedAt = new Date().toISOString();
  const boroughCounts = {
    'Manhattan': 0, 'The Bronx': 0, 'Brooklyn': 0, 'Queens': 0,
    'Staten Island': 0, 'Unknown': 0,
  };
  for (const building of buildings) boroughCounts[boroughFromBin(building.bin)]++;
  const manifest = {
    schema: 'endless-driving.nyc-building-network',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    retrievedAt,
    tileSizeM: TILE_SIZE_M,
    source: {
      datasetId: DATASET_ID,
      title: 'NYC BUILDING',
      provider: 'NYC Office of Technology and Innovation',
      attribution: 'NYC Office of Technology and Innovation',
      url: 'https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue',
      license: 'Public NYC Open Data; attribution retained with generated assets.',
      termsOfUse: 'https://opendata.cityofnewyork.us/overview/#terms-of-use',
      sourceHorizontalCrs: 'WGS 84 longitude/latitude (EPSG:4326)',
      runtimeCoordinateFrame: 'local ENU metres (+X east, +Y up, +Z north)',
      heightUnit: 'feet',
      groundElevationUnit: 'feet',
      groundElevationVerticalDatum: 'Not asserted by the selected BUILDING attributes; retained pending validated NAVD88 DEM integration.',
    },
    bounds,
    coverage: { boroughCounts },
    counts: {
      sourceFeatures: raw.length,
      retainedBuildings: buildings.length,
      sourceHeightCount,
      inferredHeightCount,
      tiles: tiles.length,
      polygons: buildings.reduce((sum, building) => sum + building.polygons.length, 0),
      rings: buildings.reduce((sum, building) =>
        sum + building.polygons.reduce((polygonSum, polygon) => polygonSum + polygon.length, 0), 0),
    },
    tiles,
  };
  const content = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(resolve(outDir, 'manifest.json'), content, 'utf8');
  process.stdout.write(JSON.stringify({
    result: 'PASS',
    output: outDir,
    sourceFeatures: raw.length,
    retainedBuildings: buildings.length,
    tileCount: tiles.length,
    sourceHeightCount,
    inferredHeightCount,
    sha256: createHash('sha256').update(content).digest('hex'),
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
