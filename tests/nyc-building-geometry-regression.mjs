import assert from 'node:assert/strict';
import {boundsOverlap,calculateFootprintBounds,clipTriangleToBounds,unionFootprintBounds} from '../src/world/nyc/nyc-building-geometry-core.mjs';
const polygons=[[ [{x:-20,z:-10},{x:540,z:-10},{x:540,z:20},{x:-20,z:20},{x:-20,z:-10}] ]];
const footprint=calculateFootprintBounds(polygons);
assert.deepEqual(footprint,{minX:-20,maxX:540,minZ:-10,maxZ:20});
assert.equal(boundsOverlap(footprint,{minX:0,maxX:512,minZ:0,maxZ:512}),true);
assert.equal(boundsOverlap(footprint,{minX:600,maxX:1112,minZ:0,maxZ:512}),false);
assert.deepEqual(unionFootprintBounds({minX:0,maxX:512,minZ:0,maxZ:512},footprint),
 {minX:-20,maxX:540,minZ:-10,maxZ:512});
const clipped=clipTriangleToBounds([{x:-2,y:1,z:-2},{x:2,y:3,z:-2},{x:0,y:2,z:2}],
 {minX:-1,maxX:1,minZ:-1,maxZ:1});
assert.ok(clipped.length>=3);
for(const point of clipped){
 assert.ok(point.x>=-1-1e-9&&point.x<=1+1e-9);
 assert.ok(point.z>=-1-1e-9&&point.z<=1+1e-9);
 assert.ok(Number.isFinite(point.y));
}
assert.deepEqual(clipTriangleToBounds([{x:4,y:1,z:4},{x:5,y:1,z:4},{x:4,y:1,z:5}],
 {minX:-1,maxX:1,minZ:-1,maxZ:1}),[]);
console.log(JSON.stringify({suite:'NYC building bounds and chunk clipping',result:'PASS'},null,2));
