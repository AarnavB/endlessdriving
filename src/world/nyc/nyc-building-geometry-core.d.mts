export interface NYCBuildingBounds { minX:number; maxX:number; minZ:number; maxZ:number; }
export interface NYCBuildingVertex { x:number; y:number; z:number; }
export function calculateFootprintBounds(polygons:Array<Array<Array<{x:number;z:number}>>>):NYCBuildingBounds;
export function unionFootprintBounds(first:NYCBuildingBounds|null,second:NYCBuildingBounds|null):NYCBuildingBounds;
export function boundsOverlap(first:NYCBuildingBounds,second:NYCBuildingBounds):boolean;
export function clipTriangleToBounds(triangle:[NYCBuildingVertex,NYCBuildingVertex,NYCBuildingVertex],bounds:NYCBuildingBounds):NYCBuildingVertex[];

export function liftBuildingVertexToTerrain(
  vertex: NYCBuildingVertex,
  elevationAt: (x: number, z: number) => number | null,
): NYCBuildingVertex;
