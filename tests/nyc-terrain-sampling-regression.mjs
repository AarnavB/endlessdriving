import assert from 'node:assert/strict';
import {sampleNYCTerrainRaster} from '../src/world/nyc/nyc-terrain-sampling-core.mjs';
const bounds={north:40.00025,south:39.99975,east:-73.99975,west:-74.00025};
const width=8,height=8;
const longitude=bounds.west+((2.5)/width)*(bounds.east-bounds.west);
const latitude=bounds.north-((2.5)/height)*(bounds.north-bounds.south);
const nearby=new Float32Array(width*height).fill(Number.NaN);
nearby[2*width+3]=18.25;
assert.equal(sampleNYCTerrainRaster(nearby,width,height,bounds,longitude,latitude),18.25,
 'all-NoData bilinear neighbourhood uses nearest finite sample within 20m');
const distant=new Float32Array(width*height).fill(Number.NaN);
distant[2*width+6]=91;
assert.equal(sampleNYCTerrainRaster(distant,width,height,bounds,longitude,latitude),null,
 'nearest finite sample beyond 20m remains missing');
const partial=new Float32Array([Number.NaN,14,Number.NaN,Number.NaN]);
const partialBounds={north:40.001,south:39.999,east:-73.999,west:-74.001};
const lon=partialBounds.west+(1/2)*(partialBounds.east-partialBounds.west);
const lat=partialBounds.north-(1/2)*(partialBounds.north-partialBounds.south);
assert.equal(sampleNYCTerrainRaster(partial,2,2,partialBounds,lon,lat),14,
 'bilinear interpolation renormalizes finite contributors and ignores NoData');
assert.throws(()=>sampleNYCTerrainRaster(new Float32Array(2),2,2,partialBounds,-74,40),/dimensions/);
assert.throws(()=>sampleNYCTerrainRaster(new Float32Array(4),2,2,partialBounds,-74,40,-1),/Invalid/);
console.log(JSON.stringify({suite:'bounded NYC DEM NoData interpolation',nearestValidSampleM:20,result:'PASS'},null,2));
