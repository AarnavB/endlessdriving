#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calculateFootprintBounds, unionFootprintBounds } from '../src/world/nyc/nyc-building-geometry-core.mjs';
async function main() {
 const directory=resolve(process.argv[2]??'public/data/nyc/buildings');
 const manifestPath=resolve(directory,'manifest.json');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(manifest.schema!=='endless-driving.nyc-building-network'||![2,3].includes(manifest.schemaVersion)||!Array.isArray(manifest.tiles))throw new Error('NYC building manifest cannot be indexed: unsupported schema.');
 if(manifest.schemaVersion===3) {
  for(const record of manifest.tiles){const bytes=await readFile(resolve(directory,record.path));if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error('NYC building index checksum mismatch: '+record.id);}
  process.stdout.write(JSON.stringify({result:'PASS',reused:true,tileCount:manifest.tiles.length,retainedBuildings:manifest.counts.retainedBuildings})+'\n');return;
 }
 let buildingCount=0,crossTileFootprints=0;
 for(const record of manifest.tiles) {
  const tilePath=resolve(directory,record.path),tile=JSON.parse(await readFile(tilePath,'utf8'));
  if(tile.schema!=='endless-driving.nyc-building-tile'||tile.schemaVersion!==1||tile.id!==record.id||tile.buildings.length!==record.buildingCount)throw new Error('NYC building tile schema/count mismatch: '+record.id);
  let footprintBounds=null;
  for(const building of tile.buildings){
   building.bounds=calculateFootprintBounds(building.polygons);
   footprintBounds=unionFootprintBounds(footprintBounds,building.bounds);
   buildingCount++;
   if(building.bounds.minX<record.bounds.minX||building.bounds.maxX>record.bounds.maxX||building.bounds.minZ<record.bounds.minZ||building.bounds.maxZ>record.bounds.maxZ)crossTileFootprints++;
  }
  tile.schemaVersion=2;tile.footprintBounds=footprintBounds;
  const content=JSON.stringify(tile)+'\n',sha256=createHash('sha256').update(content).digest('hex');
  await writeFile(tilePath,content,'utf8');
  Object.assign(record,{footprintBounds,bytes:Buffer.byteLength(content),sha256,buildingCount:tile.buildings.length});
 }
 if(buildingCount!==manifest.counts.retainedBuildings)throw new Error('NYC building index changed the unique footprint count.');
 manifest.schemaVersion=3;
 const content=JSON.stringify(manifest,null,2)+'\n';await writeFile(manifestPath,content,'utf8');
 process.stdout.write(JSON.stringify({result:'PASS',reused:false,tileCount:manifest.tiles.length,retainedBuildings:buildingCount,crossTileFootprints,manifestBytes:Buffer.byteLength(content),manifestSha256:createHash('sha256').update(content).digest('hex')},null,2)+'\n');
}
main().catch(error=>{console.error('NYC building spatial index failed:',error instanceof Error?error.message:String(error));process.exitCode=1;});
