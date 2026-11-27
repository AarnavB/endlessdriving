export interface NYCTerrainSampleBounds { north:number; south:number; east:number; west:number; }
export function sampleNYCTerrainRaster(
 heights:Float32Array,width:number,height:number,bounds:NYCTerrainSampleBounds,
 longitude:number,latitude:number,maxSearchDistanceM?:number
):number|null;
