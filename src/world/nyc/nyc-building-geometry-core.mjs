export function calculateFootprintBounds(polygons) {
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const polygon of polygons??[])for(const ring of polygon??[])for(const point of ring??[]){
    if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z))throw new TypeError('NYC building footprint contains a non-finite coordinate.');
    minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);minZ=Math.min(minZ,point.z);maxZ=Math.max(maxZ,point.z);
  }
  if(![minX,maxX,minZ,maxZ].every(Number.isFinite))throw new RangeError('NYC building footprint has no usable polygon coordinates.');
  return {minX,maxX,minZ,maxZ};
}
export function unionFootprintBounds(first,second) {
  if(!first)return {...second};if(!second)return {...first};
  return {minX:Math.min(first.minX,second.minX),maxX:Math.max(first.maxX,second.maxX),minZ:Math.min(first.minZ,second.minZ),maxZ:Math.max(first.maxZ,second.maxZ)};
}
export function boundsOverlap(first,second) {
  return first.maxX>=second.minX&&first.minX<=second.maxX&&first.maxZ>=second.minZ&&first.minZ<=second.maxZ;
}
export function clipTriangleToBounds(triangle,bounds) {
  if(!Array.isArray(triangle)||triangle.length!==3)throw new TypeError('Chunk clipping requires exactly three triangle vertices.');
  if(![bounds.minX,bounds.maxX,bounds.minZ,bounds.maxZ].every(Number.isFinite)||bounds.maxX<bounds.minX||bounds.maxZ<bounds.minZ)throw new RangeError('Invalid chunk bounds for footprint clipping.');
  let polygon=triangle.map(point=>{
    if(!point||![point.x,point.y,point.z].every(Number.isFinite))throw new TypeError('Triangle contains a non-finite vertex.');
    return {x:point.x,y:point.y,z:point.z};
  });
  const planes=[
    {inside:p=>p.x>=bounds.minX,coordinate:'x',value:bounds.minX},
    {inside:p=>p.x<=bounds.maxX,coordinate:'x',value:bounds.maxX},
    {inside:p=>p.z>=bounds.minZ,coordinate:'z',value:bounds.minZ},
    {inside:p=>p.z<=bounds.maxZ,coordinate:'z',value:bounds.maxZ},
  ];
  for(const plane of planes){
    if(!polygon.length)break;
    const input=polygon;polygon=[];
    let previous=input[input.length-1],previousInside=plane.inside(previous);
    for(const current of input){
      const currentInside=plane.inside(current);
      if(currentInside!==previousInside){
        const denominator=current[plane.coordinate]-previous[plane.coordinate];
        if(Math.abs(denominator)>1e-12){
          const t=(plane.value-previous[plane.coordinate])/denominator;
          polygon.push({x:previous.x+(current.x-previous.x)*t,y:previous.y+(current.y-previous.y)*t,z:previous.z+(current.z-previous.z)*t});
        }
      }
      if(currentInside)polygon.push(current);
      previous=current;previousInside=currentInside;
    }
  }
  return polygon;
}
