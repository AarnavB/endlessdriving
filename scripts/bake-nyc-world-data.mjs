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
const MAX_PAGES = 16;
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
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (2 ** attempt)));
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
    if (attempt < 3 && (error?.name === 'TimeoutError' || error?.name === 'TypeError')) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (2 ** attempt)));
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

  const data = JSON.stringify(payload);
  const checksum = createHash('sha256').update(data).digest('hex');
  for (const [attribute, diagnostic] of Object.entries(payload.sourceFieldDiagnostics.attributes)) {
    if (diagnostic.nonNullFeatures === 0) {
      process.stderr.write('CSCL source attribute unavailable or unmapped: ' + attribute + '\\n');
    }
  }
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const dataPath = resolve(outDir, 'manhattan-street-network.json');
  const manifestPath = resolve(outDir, 'manifest.json');
  await writeFile(dataPath, data + '\n', 'utf8');
  await writeFile(manifestPath, JSON.stringify({
    schema: payload.schema,
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    source: payload.source,
    bounds,
    counts: payload.counts,
    sourceFieldDiagnostics: payload.sourceFieldDiagnostics,
    graph: payload.graph.diagnostics,
    files: {
      streetNetwork: 'manhattan-street-network.json',
      sha256: checksum,
      bytes: Buffer.byteLength(data),
    },
  }, null, 2) + '\n', 'utf8');

  process.stdout.write(JSON.stringify({
    result: 'PASS',
    output: dataPath,
    manifest: manifestPath,
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
