import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

function toModuleUrl(source) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  return 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
}

const geoSource = await readFile('src/world/nyc/NYCGeo.ts', 'utf8');
const geoUrl = toModuleUrl(geoSource);
const loaderSource = (await readFile('src/world/nyc/NYCStreetNetworkLoader.ts', 'utf8'))
  .replace("'./NYCGeo'", JSON.stringify(geoUrl));
const loaderUrl = toModuleUrl(loaderSource);
const { NYCStreetNetworkLoader } = await import(loaderUrl);

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
}

const tile = {
  schema: 'endless-driving.nyc-street-tile',
  schemaVersion: 1,
  id: 'fixture',
  bounds: { minX: 0, maxX: 512, minZ: 0, maxZ: 512 },
  graph: { nodes: [], edges: [] },
};
const tileBytes = Buffer.from(JSON.stringify(tile));
const manifest = {
  schema: 'endless-driving.nyc-street-network',
  schemaVersion: 3,
  tileSizeM: 512,
  graph: { drivableEdgeCount: 1 },
  tiles: [{
    id: tile.id,
    path: 'tiles/fixture.json',
    bounds: tile.bounds,
    sha256: createHash('sha256').update(tileBytes).digest('hex'),
    bytes: tileBytes.byteLength,
    nodeCount: 0,
    edgeCount: 0,
  }],
};

const originalFetch = globalThis.fetch;
let resolveTileResponse;
let tileFetchStarted;
const tileStarted = new Promise((resolve) => { tileFetchStarted = resolve; });
const deferredTileResponse = new Promise((resolve) => { resolveTileResponse = resolve; });
let tileAbortSignal = null;

globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/manifest.json')) {
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (String(url).endsWith('/tiles/fixture.json')) {
    tileAbortSignal = options.signal ?? null;
    tileFetchStarted();
    // Deliberately ignore AbortSignal and finish normally after dispose().
    // The loader must still reject the stale completion before caching it.
    return deferredTileResponse;
  }
  throw new Error('Unexpected test fetch URL: ' + String(url));
};

try {
  const loader = new NYCStreetNetworkLoader('https://nyc.test/');
  const pendingTiles = loader.loadTilesForBounds({
    minX: 0, maxX: 512, minZ: 0, maxZ: 512,
  });

  await tileStarted;
  assert.ok(tileAbortSignal,
    'in-flight tile fetch must receive an AbortSignal from its loader');
  loader.dispose();
  assert.equal(tileAbortSignal.aborted, true,
    'disposing the street loader must abort its in-flight tile fetch');

  resolveTileResponse(new Response(tileBytes, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(pendingTiles, /disposed/i,
    'a tile response that completes after dispose must not resolve as usable runtime data');
  await assert.rejects(loader.loadManifest(), /disposed/i,
    'disposed loaders must reject new work');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  suite: 'NYC street tile in-flight disposal and cache lifecycle',
  result: 'PASS',
}, null, 2));
