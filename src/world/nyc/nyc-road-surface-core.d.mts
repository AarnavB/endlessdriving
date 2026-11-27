export interface NYCRoadSurfacePoint { x:number; y:number; z:number; }
export function drapeAtGradeRoadVertex(
  point: NYCRoadSurfacePoint,
  verticalOffsetM: number,
  elevationAt: (x:number,z:number)=>number|null
): NYCRoadSurfacePoint;
