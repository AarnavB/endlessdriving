export interface NYCRoadSurfacePoint { x:number; z:number; }
export interface NYCDrapedRoadSurfacePoint { x:number; y:number; z:number; }
export function drapeAtGradeRoadVertex(
  point: NYCRoadSurfacePoint,
  verticalOffsetM: number,
  elevationAt: (x:number,z:number)=>number|null
): NYCDrapedRoadSurfacePoint;

export function sampleTriangulatedTerrainSurface(
  worldX: number,
  worldZ: number,
  gridSpacingM: number,
  sampleGridHeight: (gridX: number, gridZ: number) => number | null
): number;
