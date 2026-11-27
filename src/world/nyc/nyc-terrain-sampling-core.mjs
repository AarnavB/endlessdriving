/**
 * Bilinear sample of the normalized NYC DEM. If every contributing pixel is
 * NoData, use the nearest finite pixel only when it is within the bounded
 * search distance; otherwise preserve the missing sample as null.
 */
export function sampleNYCTerrainRaster(heights,width,height,bounds,longitude,latitude,maxSearchDistanceM=20) {
  if (!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1
    ||!heights||heights.length<width*height) {
    throw new RangeError('NYC terrain raster dimensions do not match its sample buffer.');
  }
  if (!bounds||![bounds.north,bounds.south,bounds.east,bounds.west,longitude,latitude,maxSearchDistanceM].every(Number.isFinite)
    ||bounds.north<=bounds.south||bounds.east<=bounds.west||maxSearchDistanceM<0) {
    throw new RangeError('Invalid NYC terrain raster bounds or nearest-sample distance.');
  }
  const clamp=(value,minimum,maximum)=>Math.max(minimum,Math.min(maximum,value));
  const u=clamp(((longitude-bounds.west)/(bounds.east-bounds.west))*width-0.5,0,width-1);
  const v=clamp(((bounds.north-latitude)/(bounds.north-bounds.south))*height-0.5,0,height-1);
  const x0=Math.floor(u),y0=Math.floor(v),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1);
  const tx=u-x0,ty=v-y0;
  const samples=[
    [heights[y0*width+x0],(1-tx)*(1-ty)],
    [heights[y0*width+x1],tx*(1-ty)],
    [heights[y1*width+x0],(1-tx)*ty],
    [heights[y1*width+x1],tx*ty],
  ];
  let weighted=0,totalWeight=0;
  for(const [value,weight] of samples)if(Number.isFinite(value)&&weight>0){weighted+=value*weight;totalWeight+=weight;}
  if(totalWeight>0)return weighted/totalWeight;
  if(maxSearchDistanceM===0)return null;
  const latitudeRadians=latitude*Math.PI/180;
  const metresPerPixelX=Math.abs(bounds.east-bounds.west)*111320*Math.max(1e-6,Math.cos(latitudeRadians))/width;
  const metresPerPixelY=Math.abs(bounds.north-bounds.south)*111320/height;
  const radiusX=Math.ceil(maxSearchDistanceM/metresPerPixelX),radiusY=Math.ceil(maxSearchDistanceM/metresPerPixelY);
  const centerX=Math.round(u),centerY=Math.round(v);
  let nearest=null,nearestDistance=Infinity;
  for(let y=Math.max(0,centerY-radiusY);y<=Math.min(height-1,centerY+radiusY);y++){
    for(let x=Math.max(0,centerX-radiusX);x<=Math.min(width-1,centerX+radiusX);x++){
      const value=heights[y*width+x];if(!Number.isFinite(value))continue;
      const distance=Math.hypot((x-u)*metresPerPixelX,(y-v)*metresPerPixelY);
      if(distance<=maxSearchDistanceM&&distance<nearestDistance){nearest=value;nearestDistance=distance;}
    }
  }
  return nearest;
}
