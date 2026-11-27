import assert from 'node:assert/strict';
import {
  boundsOverlap,
  calculateFootprintBounds,
  clipTriangleToBounds,
  liftBuildingVertexToTerrain,
  unionFootprintBounds,
} from '../src/world/nyc/nyc-building-geometry-core.mjs';

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

const slope=(x,z)=>4+x*0.1-z*0.05;
assert.deepEqual(liftBuildingVertexToTerrain({x:10,y:0,z:20},slope),
 {x:10,y:4,z:20},'the footprint base follows terrain at its own vertex');
assert.deepEqual(liftBuildingVertexToTerrain({x:20,y:12,z:10},slope),
 {x:20,y:17.5,z:10},'roof height remains above the locally sampled base elevation');
assert.notEqual(
 liftBuildingVertexToTerrain({x:10,y:0,z:20},slope).y,
 liftBuildingVertexToTerrain({x:20,y:0,z:10},slope).y,
 'separate building vertices follow different elevations on sloping ground');
assert.throws(
 () => liftBuildingVertexToTerrain({x:10,y:0,z:20},()=>null),
 /No validated DEM elevation/,
 'missing terrain never becomes a zero-metre building base');
assert.throws(
 () => liftBuildingVertexToTerrain({x:10,y:0,z:20},()=>Number.NaN),
 /No validated DEM elevation/,
 'non-finite terrain never becomes a building base');
console.log(JSON.stringify({suite:'NYC building footprint bounds, chunk clipping and per-vertex DEM alignment',result:'PASS'},null,2));
