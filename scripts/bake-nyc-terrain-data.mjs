#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SERVICE_URL = 'https://elevation.its.ny.gov/arcgis/rest/services/NYC_TopoBathymetric_2017_1_meter/ImageServer';
const BOUNDS = Object.freeze({ north: 40.92, south: 40.48, east: -73.70, west: -74.26 });
const TILE_WIDTH_DEG = 0.04;
const TILE_HEIGHT_DEG = 0.03;
const TILE_HALO_DEG = 0.002;
const WIDTH = 256;
const HEIGHT = 256;
const NO_DATA = -9999;
const CONCURRENCY = 3;
const MAX_RETRIES = 5;
const ORIGIN = { latitude: 40.7595, longitude: -73.9906 };

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const finite = Number.isFinite;
const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function request(url, label, expectedBytes = null) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/octet-stream, application/json' },
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
          await sleep(800 * (2 ** attempt));
          continue;
        }
        throw new Error(label + ' returned HTTP ' + response.status + ': ' + detail);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (expectedBytes !== null && bytes.byteLength < expectedBytes) {
        const detail = bytes.toString('utf8', 0, Math.min(bytes.length, 300));
        if (detail.trimStart().startsWith('{')) {
          throw new Error(label + ' returned a JSON service error: ' + detail);
        }
        throw new Error(label + ' returned ' + bytes.byteLength + ' bytes; expected at least ' + expectedBytes);
      }
      return bytes;
    } catch (error) {
      lastError = error;
      const retryable = error?.name === 'TimeoutError'
        || error?.name === 'TypeError'
        || /returned HTTP 429|returned HTTP 5\d\d/i.test(error?.message ?? '');
      if (!retryable || attempt === MAX_RETRIES) throw error;
      await sleep(800 * (2 ** attempt));
    }
  }
  throw new Error('Unable to retrieve ' + label + ': ' + String(lastError));
}

async function verifySourceMetadata() {
  const url = SERVICE_URL + '/info/iteminfo?f=pjson';
  const bytes = await request(url, 'NYC 2017 DEM service metadata');
  const metadata = JSON.parse(bytes.toString('utf8'));
  const searchable = JSON.stringify(metadata).toLowerCase();
  for (const expected of ['navd88', 'geoid 12b', 'nad83', 'converted to meters']) {
    if (!searchable.includes(expected)) {
      throw new Error('NYC 2017 DEM service metadata did not confirm: ' + expected);
    }
  }
  return metadata;
}

function decodeFloatRaster(bytes) {
  const count = WIDTH * HEIGHT;
  const expectedBytes = count * 4;
  // ArcGIS BIP may append a one-bit NoData mask after the F32 pixel plane.
  const maximumBytes = expectedBytes + Math.ceil(count / 8) + 64;
  if (bytes.byteLength < expectedBytes || bytes.byteLength > maximumBytes) {
    throw new Error('Unexpected ArcGIS BIP size: ' + bytes.byteLength);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, expectedBytes);
  const stride = Math.max(1, Math.floor(count / 8192));
  const score = (littleEndian) => {
    let plausible = 0;
    let populated = 0;
    for (let i = 0; i < count; i += stride) {
      const value = view.getFloat32(i * 4, littleEndian);
      if (!finite(value) || value === NO_DATA || value < -500 || value > 1000) continue;
      populated++;
      if (Math.abs(value) >= 1e-5 && Math.abs(value) <= 300) plausible++;
    }
    return plausible * 4 + populated;
  };
  const littleScore = score(true);
  const bigScore = score(false);
  const littleEndian = littleScore >= bigScore;
  if (Math.max(littleScore, bigScore) === 0) {
    throw new Error('ArcGIS BIP raster contains no plausible NYC elevation samples.');
  }
  const values = new Float32Array(count);
  let validPixelCount = 0;
  for (let i = 0; i < count; i++) {
    const value = view.getFloat32(i * 4, littleEndian);
    if (finite(value) && value !== NO_DATA && value >= -500 && value <= 1000) {
      values[i] = value;
      validPixelCount++;
    } else {
      values[i] = Number.NaN;
    }
  }
  return { values, validPixelCount, inputByteOrder: littleEndian ? 'little-endian' : 'big-endian' };
}

function sampleRaster(values, bounds, longitude, latitude) {
  const u = Math.max(0, Math.min(WIDTH - 1,
    ((longitude - bounds.west) / (bounds.east - bounds.west)) * WIDTH - 0.5));
  const v = Math.max(0, Math.min(HEIGHT - 1,
    ((bounds.north - latitude) / (bounds.north - bounds.south)) * HEIGHT - 0.5));
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const x1 = Math.min(WIDTH - 1, x0 + 1), y1 = Math.min(HEIGHT - 1, y0 + 1);
  const tx = u - x0, ty = v - y0;
  const candidates = [
    [values[y0 * WIDTH + x0], (1 - tx) * (1 - ty)],
    [values[y0 * WIDTH + x1], tx * (1 - ty)],
    [values[y1 * WIDTH + x0], (1 - tx) * ty],
    [values[y1 * WIDTH + x1], tx * ty],
  ];
  let sum = 0, weights = 0;
  for (const [value, weight] of candidates) {
    if (finite(value) && weight > 0) {
      sum += value * weight;
      weights += weight;
    }
  }
  return weights > 0 ? sum / weights : null;
}

async function bakeTile(column, row, outputDirectory) {
  const coreWest = BOUNDS.west + column * TILE_WIDTH_DEG;
  const coreEast = Math.min(BOUNDS.east, coreWest + TILE_WIDTH_DEG);
  const coreSouth = BOUNDS.south + row * TILE_HEIGHT_DEG;
  const coreNorth = Math.min(BOUNDS.north, coreSouth + TILE_HEIGHT_DEG);
  const bounds = {
    west: coreWest - TILE_HALO_DEG,
    east: coreEast + TILE_HALO_DEG,
    south: coreSouth - TILE_HALO_DEG,
    north: coreNorth + TILE_HALO_DEG,
  };
  const url = new URL(SERVICE_URL + '/exportImage');
  url.searchParams.set('bbox', [bounds.west, bounds.south, bounds.east, bounds.north].join(','));
  url.searchParams.set('bboxSR', '4326');
  url.searchParams.set('imageSR', '4326');
  url.searchParams.set('size', WIDTH + ',' + HEIGHT);
  url.searchParams.set('adjustAspectRatio', 'false');
  url.searchParams.set('format', 'bip');
  url.searchParams.set('pixelType', 'F32');
  url.searchParams.set('noData', String(NO_DATA));
  url.searchParams.set('noDataInterpretation', 'esriNoDataMatchAny');
  url.searchParams.set('interpolation', 'RSP_BilinearInterpolation');
  url.searchParams.set('f', 'image');

  const bytes = await request(url, 'NYC 2017 DEM tile ' + column + ':' + row, WIDTH * HEIGHT * 4);
  const decoded = decodeFloatRaster(bytes);
  const output = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < decoded.values.length; i++) output.writeFloatLE(decoded.values[i], i * 4);
  const filename = 'tiles/' + column + '_' + row + '.f32';
  const outputPath = resolve(outputDirectory, filename);
  await writeFile(outputPath, output);

  const meanLatitude = (bounds.north + bounds.south) * 0.5 * Math.PI / 180;
  return {
    id: column + ':' + row,
    xIndex: column,
    yIndex: row,
    path: filename,
    bounds,
    width: WIDTH,
    height: HEIGHT,
    bytes: output.byteLength,
    sha256: digest(output),
    validPixelCount: decoded.validPixelCount,
    inputByteOrder: decoded.inputByteOrder,
    pixelSpacingApproxM: {
      eastWest: Number((111320 * Math.cos(meanLatitude) * (bounds.east - bounds.west) / WIDTH).toFixed(3)),
      northSouth: Number((111132 * (bounds.north - bounds.south) / HEIGHT).toFixed(3)),
    },
    originSampleM: bounds.west <= ORIGIN.longitude && bounds.east >= ORIGIN.longitude
      && bounds.south <= ORIGIN.latitude && bounds.north >= ORIGIN.latitude
      ? sampleRaster(decoded.values, bounds, ORIGIN.longitude, ORIGIN.latitude) : null,
  };
}

async function main() {
  const metadata = await verifySourceMetadata();
  const columns = Math.ceil((BOUNDS.east - BOUNDS.west) / TILE_WIDTH_DEG);
  const rows = Math.ceil((BOUNDS.north - BOUNDS.south) / TILE_HEIGHT_DEG);
  const outputDirectory = resolve('public/data/nyc/terrain');
  await mkdir(resolve(outputDirectory, 'tiles'), { recursive: true });
  const tasks = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) tasks.push([column, row]);
  }

  const records = [];
  for (let offset = 0; offset < tasks.length; offset += CONCURRENCY) {
    const batch = tasks.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(([column, row]) =>
      bakeTile(column, row, outputDirectory)));
    records.push(...results);
    for (const tile of results) {
      process.stdout.write('Baked NYC DEM tile ' + tile.id + ': '
        + tile.validPixelCount + '/' + (WIDTH * HEIGHT) + ' valid pixels\n');
    }
  }

  records.sort((a, b) => a.yIndex - b.yIndex || a.xIndex - b.xIndex);
  const originSamples = records.map((tile) => tile.originSampleM).filter(finite);
  if (originSamples.length === 0) {
    throw new Error('NYC_ORIGIN has no valid NAVD88 DEM sample; refusing an arbitrary vertical offset.');
  }
  const originElevationM = originSamples.reduce((sum, value) => sum + value, 0) / originSamples.length;
  const metadataText = JSON.stringify(metadata).toLowerCase();
  const manifest = {
    schema: 'endless-driving.nyc-terrain-network',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    bounds: BOUNDS,
    tileSizeDegrees: { longitude: TILE_WIDTH_DEG, latitude: TILE_HEIGHT_DEG },
    grid: {
      width: WIDTH,
      height: HEIGHT,
      bands: 1,
      pixelType: 'F32',
      outputFormat: 'BIP normalized to little-endian Float32',
      approximateResolutionM: 13,
      gameTerrainVertexSpacingM: 16,
      noDataValue: 'NaN in normalized Float32 output',
      interpolation: 'Bilinear',
    },
    coordinateFrame: {
      sourceHorizontalCrs: 'EPSG:2263 - NAD83 / New York Long Island (US survey feet)',
      rasterOutputHorizontalCrs: 'EPSG:4326 - WGS 84 longitude/latitude',
      verticalDatum: 'NAVD88 / Geoid 12B',
      verticalUnit: 'metres (verified NYS ImageServer metadata conversion)',
      runtimeFrame: 'local ENU metres (+X east, +Y up, +Z north)',
      verticalOrigin: 'NAVD88 elevation at NYC_ORIGIN; subtracted from source elevations',
      datumTransformation: 'NYS ImageServer default projection transformation to requested WGS 84 output',
    },
    source: {
      datasetId: 'NYC_TopoBathymetric_2017_1_meter',
      title: 'NYC Topobathymetric 2017 1 meter - bare earth DEM',
      provider: 'NYS ITS Geospatial Services; source LiDAR for the City of New York by Quantum Spatial',
      attribution: 'NYS ITS Geospatial Services and City of New York',
      url: SERVICE_URL,
      metadataUrl: SERVICE_URL + '/info/iteminfo',
      license: 'Public image service; source item metadata lists licenseInfo as none.',
      captureDates: 'Topographic 2017-05-03 to 2017-05-17; bathymetric 2017-07-04 to 2017-07-26',
      sourceResolutionM: 1,
      sourceHorizontalUnit: 'US survey feet in EPSG:2263',
      retrievalMethod: 'ArcGIS ImageServer exportImage; WGS84 bounding boxes; 256 x 256 F32 BIP tiles',
      metadataChecks: {
        navd88: metadataText.includes('navd88'),
        geoid12b: metadataText.includes('geoid 12b'),
        nad83: metadataText.includes('nad83'),
        convertedToMeters: metadataText.includes('converted to meters'),
      },
    },
    originElevationM,
    counts: {
      columns,
      rows,
      tiles: records.length,
      validPixels: records.reduce((sum, tile) => sum + tile.validPixelCount, 0),
      noDataPixels: records.reduce((sum, tile) => sum + WIDTH * HEIGHT - tile.validPixelCount, 0),
      bytes: records.reduce((sum, tile) => sum + tile.bytes, 0),
    },
    tiles: records.map(({ originSampleM, inputByteOrder, ...record }) => record),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(outputDirectory, 'manifest.json'), manifestBytes);
  process.stdout.write(JSON.stringify({
    result: 'PASS',
    output: outputDirectory,
    tiles: records.length,
    originElevationM,
    bytes: manifest.counts.bytes,
    manifestSha256: digest(manifestBytes),
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
