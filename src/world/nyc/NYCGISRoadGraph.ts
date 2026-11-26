import { CityRoadGraph } from './CityRoadGraph';
import type {
  CityDirectionality, CityIntersection, CityLaneConnection, CityLanePose,
  CityRoadCategory, CityRoadEdge, CityRoadLevelKind, CityRoadProfile,
  CityRoadSegment, CityRoadType, CityVector3,
} from './CityRoadGraph';
import type { NYCStreetTile, NYCStreetTileEdge, NYCStreetTileNode } from './NYCStreetNetworkLoader';

const CELL_M=256, DEFAULT_LANE_WIDTH_M=3.45;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const cell=(x:number,z:number)=>Math.floor(x/CELL_M)+':'+Math.floor(z/CELL_M);
function hash(s:string):number { let h=2166136261; for(let i=0;i<s.length;i++) h=Math.imul(h^s.charCodeAt(i),16777619); return h>>>0; }
function category(type:string):CityRoadCategory {
  switch(type.toLowerCase()) {
    case 'highway': return 'expressway'; case 'bridge': return 'bridge';
    case 'ramp': return 'ramp'; case 'tunnel': return 'underpass';
    case 'alley': return 'alley'; default: return 'street';
  }
}
function pathDistance(x:number,z:number,p:CityVector3[]):number {
  let best=Infinity;
  for(let i=1;i<p.length;i++){const a=p[i-1],b=p[i],dx=b.x-a.x,dz=b.z-a.z;
    const q=dx*dx+dz*dz,t=q>1e-8?clamp(((x-a.x)*dx+(z-a.z)*dz)/q,0,1):0;
    best=Math.min(best,Math.hypot(x-a.x-dx*t,z-a.z-dz*t));}
  return best;
}
class MinQueue<T> {
  private values:Array<{item:T;priority:number}>=[];
  push(item:T,priority:number):void {
    const value={item,priority}; let i=this.values.length; this.values.push(value);
    while(i>0){const p=(i-1)>>>1;if(this.values[p].priority<=priority)break;this.values[i]=this.values[p];i=p;}
    this.values[i]=value;
  }
  pop():T|null {
    if(!this.values.length)return null;const first=this.values[0],last=this.values.pop()!;
    if(this.values.length){let i=0;while(true){const l=i*2+1,r=l+1;if(l>=this.values.length)break;
      const c=r<this.values.length&&this.values[r].priority<this.values[l].priority?r:l;
      if(this.values[c].priority>=last.priority)break;this.values[i]=this.values[c];i=c;}this.values[i]=last;}
    return first.item;
  }
  get size():number{return this.values.length;}
}

/** Runtime graph whose only road/node inputs are the validated CSCL tile payloads. */
export class NYCGISRoadGraph extends CityRoadGraph {
  readonly isGISBacked=true;
  private readonly gisNodes=new Map<string,CityIntersection>();
  private readonly gisSegments=new Map<string,CityRoadSegment>();
  private readonly outgoing=new Map<string,CityRoadEdge[]>();
  private readonly incoming=new Map<string,CityRoadEdge[]>();
  private readonly directed=new Map<string,CityRoadEdge[]>();
  private readonly cumulative=new Map<string,number[]>();
  private readonly segmentCells=new Map<string,Set<string>>();
  private readonly nodeCells=new Map<string,Set<string>>();
  private readonly loadedTiles=new Set<string>();
  private readonly spawnAnchor:CityVector3;

  constructor(tiles:NYCStreetTile[],spawnPosition:CityVector3) {
    super(20261126,false);this.spawnAnchor={...spawnPosition};this.addTiles(tiles);
    if(!this.gisSegments.size)throw new Error('Initial GIS tiles contain no directed drivable road segments.');
  }
  addTiles(tiles:NYCStreetTile[]):void {
    for(const tile of tiles){if(this.loadedTiles.has(tile.id))continue;
      const tileNodes=new Map(tile.graph.nodes.map(n=>[n.id,n]));
      for(const n of tile.graph.nodes)this.addNode(n);
      for(const e of tile.graph.edges)this.addEdge(e,tileNodes);
      this.loadedTiles.add(tile.id);}
  }
  getLoadedTileCount():number{return this.loadedTiles.size;}

  override getIntersectionId(_x:number,_z:number,_level=0):string {
    throw new Error('Grid intersection IDs are disabled for the GIS road graph.');
  }
  override getIntersectionAt(_x:number,_z:number,_level=0):CityIntersection {
    throw new Error('GIS intersections must be addressed by source CSCL node ID.');
  }
  override getIntersection(id:string):CityIntersection {
    const v=this.gisNodes.get(id);if(!v)throw new Error('GIS node is not loaded: '+id);return v;
  }
  override getSegmentBetween(_a:string,_b:string):CityRoadSegment {
    throw new Error('Synthetic grid segments are disabled for the GIS road graph.');
  }
  override getSegment(id:string):CityRoadSegment {
    const v=this.gisSegments.get(id);if(!v)throw new Error('GIS road edge is not loaded: '+id);return v;
  }
  override getEdgeFromTo(a:string,b:string):CityRoadEdge {
    const e=(this.outgoing.get(a)??[]).find(v=>v.toNodeId===b);
    if(!e)throw new Error('No legal directed CSCL edge '+a+' -> '+b);return {...e};
  }
  override getOutgoingEdges(id:string):CityRoadEdge[] {
    if(!this.gisNodes.has(id))throw new Error('GIS node is not loaded: '+id);
    return (this.outgoing.get(id)??[]).map(e=>({...e}));
  }
  getIncomingEdges(id:string):CityRoadEdge[] {
    if(!this.gisNodes.has(id))throw new Error('GIS node is not loaded: '+id);
    return (this.incoming.get(id)??[]).map(e=>({...e}));
  }
  override getRoadProfile(axis:'x'|'z',lineIndex:number):CityRoadProfile {
    return {category:'street',axis,lineIndex,lanesPerDirection:1,laneWidthM:DEFAULT_LANE_WIDTH_M,
      widthM:DEFAULT_LANE_WIDTH_M*2+1.4,speedLimitKmh:30,directionality:'both'};
  }

  override getCenterlinePose(id:string,distanceAlongM:number,direction:1|-1=1) {
    const s=this.getSegment(id),p=s.geometry!,table=this.cumulative.get(id)!;
    const d=clamp(direction>0?distanceAlongM:s.lengthM-distanceAlongM,0,s.lengthM);
    let hi=1;while(hi<table.length-1&&table[hi]<d)hi++;
    const lo=hi-1,span=table[hi]-table[lo],t=span>1e-8?(d-table[lo])/span:0;
    const a=p[lo],b=p[hi],v={x:(b.x-a.x),y:(b.y-a.y),z:(b.z-a.z)};
    const n=Math.hypot(v.x,v.y,v.z)||1;
    const tangent={x:v.x/n*direction,y:v.y/n*direction,z:v.z/n*direction};
    const position={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};
    const h=Math.hypot(tangent.x,tangent.z)||1;
    const right={x:tangent.z/h,y:0,z:-tangent.x/h};
    const up={x:tangent.y*right.z-tangent.z*right.y,y:tangent.z*right.x-tangent.x*right.z,z:tangent.x*right.y-tangent.y*right.x};
    const u=Math.hypot(up.x,up.y,up.z)||1;up.x/=u;up.y/=u;up.z/=u;
    return {position,tangent,right,up,yaw:Math.atan2(tangent.x,tangent.z),pitch:Math.atan2(tangent.y,h)};
  }

  override getLaneConnection(inEdge:CityRoadEdge,lane:number,outEdge:CityRoadEdge):CityLaneConnection|null {
    if(inEdge.toNodeId!==outEdge.fromNodeId||outEdge.toNodeId===inEdge.fromNodeId)return null;
    const a=this.getSegment(inEdge.segmentId),b=this.getSegment(outEdge.segmentId);
    const from=clamp(Math.trunc(lane),0,a.profile.lanesPerDirection-1);
    let to=clamp(from,0,b.profile.lanesPerDirection-1);
    let movement:CityLaneConnection['movement']='through';
    const isRamp=(s:CityRoadSegment)=>s.sourceRoadwayType?.toLowerCase()==='ramp';
    const isHighway=(s:CityRoadSegment)=>s.sourceRoadwayType?.toLowerCase()==='highway';
    if(isHighway(a)&&isRamp(b)){
      if(from!==0)return null;
      const deck=this.getCenterlinePose(a.id,a.lengthM,inEdge.direction);
      const ramp=this.getCenterlinePose(b.id,Math.min(20,b.lengthM),outEdge.direction);
      const lateral=(ramp.position.x-deck.position.x)*deck.right.x+(ramp.position.z-deck.position.z)*deck.right.z;
      if(lateral<=0.5)return null;movement='ramp-exit';
    }else if(isRamp(a)&&isHighway(b)){to=0;movement='ramp-entry';}
    return {edge:{...outEdge},fromLaneIndex:from,toLaneIndex:to,movement};
  }
  override getOutgoingLaneConnections(edge:CityRoadEdge,lane:number):CityLaneConnection[] {
    return this.getOutgoingEdges(edge.toNodeId).filter(e=>e.toNodeId!==edge.fromNodeId)
      .map(e=>this.getLaneConnection(edge,lane,e)).filter((v):v is CityLaneConnection=>v!==null);
  }
  override getSpawnPose():CityLanePose {
    return this.getNearestLanePose(this.spawnAnchor.x,this.spawnAnchor.z,0,1,this.spawnAnchor.y);
  }
  override getNearestLanePose(x:number,z:number,px=0,pz=1,py=0):CityLanePose {
    let candidates=this.getSegmentsInBounds(x-512,x+512,z-512,z+512);
    if(!candidates.length)candidates=this.getSegmentsInBounds(x-2048,x+2048,z-2048,z+2048);
    let best:CityLanePose|null=null,bestScore=Infinity;const plen=Math.hypot(px,pz);
    for(const s of candidates){const points=s.geometry!,cum=this.cumulative.get(s.id)!,edges=this.directed.get(s.id)??[];
      for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b.x-a.x,dz=b.z-a.z,q=dx*dx+dz*dz;
        const t=q>1e-8?clamp(((x-a.x)*dx+(z-a.z)*dz)/q,0,1):0;
        const d=cum[i-1]+(cum[i]-cum[i-1])*t;
        for(const e of edges){const progress=e.direction>0?d:s.lengthM-d;
          for(let lane=0;lane<s.profile.lanesPerDirection;lane++){const pose=this.getLanePose(e,lane,progress);
            const dist=(pose.position.x-x)**2+(pose.position.y-py)**2+(pose.position.z-z)**2;
            const heading=plen>0.25?(1-(pose.tangent.x*px+pose.tangent.z*pz)/plen)*5:0;
            if(dist+heading<bestScore){bestScore=dist+heading;best=pose;}}}}
    }
    if(!best)throw new Error('No valid drivable CSCL lane is loaded near the requested position.');
    return best;
  }
  override getNearestRoadHeading(x:number,z:number,px=0,pz=1,py=0):CityVector3 {
    return this.getNearestLanePose(x,z,px,pz,py).tangent;
  }
  override findRoute(start:string,destination:string):CityRoadEdge[] {
    if(!this.gisNodes.has(start)||!this.gisNodes.has(destination))throw new Error('Route endpoints must be loaded GIS nodes.');
    if(start===destination)return [];
    const queue=new MinQueue<string>(),cost=new Map<string,number>([[start,0]]);
    const previous=new Map<string,{nodeId:string;edge:CityRoadEdge}>();
    const heuristic=(id:string)=>{const a=this.gisNodes.get(id)!.position,b=this.gisNodes.get(destination)!.position;return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);};
    queue.push(start,heuristic(start));
    while(queue.size){const current=queue.pop()!;if(current===destination)break;const g=cost.get(current)!;
      for(const e of this.outgoing.get(current)??[]){const next=g+this.gisSegments.get(e.segmentId)!.lengthM;
        if(next>=(cost.get(e.toNodeId)??Infinity))continue;
        cost.set(e.toNodeId,next);previous.set(e.toNodeId,{nodeId:current,edge:e});queue.push(e.toNodeId,next+heuristic(e.toNodeId));}}
    if(!previous.has(destination))throw new Error('No directed route exists in the loaded CSCL graph.');
    const route:CityRoadEdge[]=[];let cursor=destination;
    while(cursor!==start){const item=previous.get(cursor);if(!item)throw new Error('CSCL route reconstruction failed.');route.push(item.edge);cursor=item.nodeId;}
    return route.reverse();
  }
  override chooseNextEdge(nodeId:string,previousNodeId:string,seed:number,incoming?:CityRoadEdge,lane=0):CityRoadEdge|null {
    let options=(this.outgoing.get(nodeId)??[]).filter(e=>e.toNodeId!==previousNodeId);
    if(incoming){if(incoming.toNodeId!==nodeId||incoming.fromNodeId!==previousNodeId)return null;
      options=options.filter(e=>this.getLaneConnection(incoming,lane,e)!==null);}
    options.sort((a,b)=>a.segmentId.localeCompare(b.segmentId));
    if(!options.length)return null;
    return options[hash(nodeId+'|'+previousNodeId+'|'+seed)%options.length];
  }

  getSegmentsInBounds(minX:number,maxX:number,minZ:number,maxZ:number):CityRoadSegment[] {
    return this.getSpecialSegmentsInBounds(minX,maxX,minZ,maxZ);
  }
  override getSpecialSegmentsInBounds(minX:number,maxX:number,minZ:number,maxZ:number):CityRoadSegment[] {
    const ids=new Set<string>();
    for(let x=Math.floor(minX/CELL_M);x<=Math.floor(maxX/CELL_M);x++)
      for(let z=Math.floor(minZ/CELL_M);z<=Math.floor(maxZ/CELL_M);z++)
        for(const id of this.segmentCells.get(cell(x*CELL_M,z*CELL_M))??[])ids.add(id);
    return [...ids].map(id=>this.gisSegments.get(id)!).filter(s=>{
      const p=s.geometry!,w=s.profile.widthM*0.5;
      const ax=Math.min(...p.map(v=>v.x))-w,bx=Math.max(...p.map(v=>v.x))+w;
      const az=Math.min(...p.map(v=>v.z))-w,bz=Math.max(...p.map(v=>v.z))+w;
      return bx>=minX&&ax<=maxX&&bz>=minZ&&az<=maxZ;
    });
  }
  getIntersectionsInBounds(b:{minX:number;maxX:number;minZ:number;maxZ:number}):CityIntersection[] {
    const ids=new Set<string>();
    for(let x=Math.floor(b.minX/CELL_M);x<=Math.floor(b.maxX/CELL_M);x++)
      for(let z=Math.floor(b.minZ/CELL_M);z<=Math.floor(b.maxZ/CELL_M);z++)
        for(const id of this.nodeCells.get(cell(x*CELL_M,z*CELL_M))??[])ids.add(id);
    return [...ids].map(id=>this.gisNodes.get(id)!).filter(n=>n.position.x>=b.minX&&n.position.x<=b.maxX&&n.position.z>=b.minZ&&n.position.z<=b.maxZ);
  }
  getDirectedEdgesNear(x:number,z:number,radiusM=800,limit=64):CityRoadEdge[] {
    const rank:Array<{edge:CityRoadEdge;distance:number}>=[];
    for(const s of this.getSegmentsInBounds(x-radiusM,x+radiusM,z-radiusM,z+radiusM)){
      const distance=pathDistance(x,z,s.geometry!);if(distance>radiusM||s.lengthM<55)continue;
      for(const edge of this.directed.get(s.id)??[])rank.push({edge,distance});}
    rank.sort((a,b)=>a.distance-b.distance||a.edge.segmentId.localeCompare(b.edge.segmentId));
    const result=new Map<string,CityRoadEdge>();
    for(const item of rank){const key=item.edge.segmentId+':'+item.edge.direction;if(!result.has(key))result.set(key,item.edge);if(result.size>=limit)break;}
    return [...result.values()].map(e=>({...e}));
  }
  override getUnderpassSegments():CityRoadSegment[]{return [...this.gisSegments.values()].filter(s=>s.roadType==='underpass');}
  override getInterchangeDescriptor(){return {groundEntryNodeId:'',groundExitNodeId:'',deckCrossingNodeId:'',entryRampSegmentIds:[],exitRampSegmentIds:[],highwaySegmentIds:[],underpassSegmentIds:[]};}

  private addNode(source:NYCStreetTileNode):void {
    const p=source.position;if(!source.id||!p||![p.x,p.y,p.z].every(Number.isFinite))throw new Error('Invalid CSCL tile node.');
    const old=this.gisNodes.get(source.id);if(old){if(Math.hypot(old.position.x-p.x,old.position.y-p.y,old.position.z-p.z)>0.02)throw new Error('Conflicting duplicate node '+source.id);return;}
    const code=Number.isInteger(source.levelCode)?source.levelCode:null,levelCode=code===null||code===99?13:code;
    const kind:CityRoadLevelKind=levelCode<13?'underpass':levelCode>13?'elevated':'ground';
    const node:CityIntersection={id:source.id,gridX:Math.round(p.x/160),gridZ:Math.round(p.z/160),position:{...p},elevationM:p.y,level:levelCode-13,kind,intersectionType:kind==='ground'?'at-grade':'grade-separated',signalControlled:kind==='ground'&&source.degree>=3,signalOffsetSeconds:hash(source.id)%5600/100};
    this.gisNodes.set(node.id,node);this.outgoing.set(node.id,[]);this.incoming.set(node.id,[]);
    const k=cell(p.x,p.z),bucket=this.nodeCells.get(k)??new Set<string>();bucket.add(node.id);this.nodeCells.set(k,bucket);
  }
  private addEdge(source:NYCStreetTileEdge,tileNodes:Map<string,NYCStreetTileNode>):void {
    if(this.gisSegments.has(source.id))return;
    if(!tileNodes.has(source.fromNodeId)||!tileNodes.has(source.toNodeId)||!this.gisNodes.has(source.fromNodeId)||!this.gisNodes.has(source.toNodeId))throw new Error('GIS tile missing edge endpoint '+source.id);
    if(!Array.isArray(source.geometry)||source.geometry.length<2||!Array.isArray(source.allowedDirections)||!source.allowedDirections.length)return;
    if(!['both','forward','reverse'].includes(source.directionality))return;
    const geometry=source.geometry.map(p=>({x:p.x,y:p.y,z:p.z}));
    if(geometry.some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw new Error('Non-finite CSCL geometry '+source.id);
    const from=this.gisNodes.get(source.fromNodeId)!,to=this.gisNodes.get(source.toNodeId)!;
    if(Math.hypot(geometry[0].x-from.position.x,geometry[0].z-from.position.z)>2||Math.hypot(geometry.at(-1)!.x-to.position.x,geometry.at(-1)!.z-to.position.z)>2)throw new Error('GIS polyline endpoints do not match source graph nodes '+source.id);
    const cumulative=[0];for(let i=1;i<geometry.length;i++)cumulative.push(cumulative[i-1]+Math.hypot(geometry[i].x-geometry[i-1].x,geometry[i].y-geometry[i-1].y,geometry[i].z-geometry[i-1].z));
    const lengthM=cumulative.at(-1)!;if(lengthM<=1)return;
    const type=source.roadwayType.toLowerCase();
    if(!['street','highway','bridge','tunnel','ramp','driveway','alley','u-turn'].includes(type))return;
    const dir=source.directionality as CityDirectionality;
    const total=Number.isFinite(source.numberTravelLanes)&&source.numberTravelLanes!>0?clamp(Math.round(source.numberTravelLanes!),1,12):type==='highway'?6:type==='ramp'||type==='alley'?1:2;
    const lanes=dir==='both'?Math.max(1,Math.min(5,Math.ceil(total/2))):Math.max(1,Math.min(5,total));
    const laneWidth=type==='highway'?3.65:DEFAULT_LANE_WIDTH_M;
    const width=Math.max(Number.isFinite(source.widthM)&&source.widthM!>0?source.widthM!:0,lanes*laneWidth*(dir==='both'?2:1)+2);
    const rawSpeed=Number(source.postedSpeedSourceValue),speed=Number.isFinite(rawSpeed)&&rawSpeed>0?Math.min(130,rawSpeed*1.60934):type==='highway'?80:type==='ramp'?45:35;
    const axis: 'x'|'z'=Math.abs(to.position.x-from.position.x)>=Math.abs(to.position.z-from.position.z)?'x':'z';
    const vertical=Math.max(...geometry.map(p=>p.y))-Math.min(...geometry.map(p=>p.y));
    const hasZ=vertical>0.5;let roadType:CityRoadType='surface';
    if(hasZ){if(type==='tunnel')roadType='underpass';else if(type==='ramp')roadType=to.position.y>=from.position.y?'entrance-ramp':'exit-ramp';else if(type==='bridge'||type==='highway')roadType='elevated-highway';}
    const segment:CityRoadSegment={id:source.id,fromNodeId:source.fromNodeId,toNodeId:source.toNodeId,start:{...from.position},end:{...to.position},geometry,sourceFeatureId:source.sourceFeatureId,sourceRoadwayType:source.roadwayType,fromLevelCode:source.fromLevelCode,toLevelCode:source.toLevelCode,axis,lengthM,profile:{category:category(type),axis,lineIndex:0,lanesPerDirection:lanes,laneWidthM:laneWidth,widthM:width,speedLimitKmh:speed,directionality:dir},level:Math.min(from.level,to.level),roadType,maxGradient:0.2,horizontalCurvature:0,verticalCurvature:0,label:source.streetName??source.sourceFeatureId??source.id};
    this.gisSegments.set(segment.id,segment);this.cumulative.set(segment.id,cumulative);
    const edges:CityRoadEdge[]=[];
    if(source.allowedDirections.includes('forward')){const e={segmentId:source.id,fromNodeId:source.fromNodeId,toNodeId:source.toNodeId,direction:1 as const};this.outgoing.get(e.fromNodeId)!.push(e);this.incoming.get(e.toNodeId)!.push(e);edges.push(e);}
    if(source.allowedDirections.includes('reverse')){const e={segmentId:source.id,fromNodeId:source.toNodeId,toNodeId:source.fromNodeId,direction:-1 as const};this.outgoing.get(e.fromNodeId)!.push(e);this.incoming.get(e.toNodeId)!.push(e);edges.push(e);}
    this.directed.set(segment.id,edges);
    const half=width*0.5,lowX=Math.min(...geometry.map(p=>p.x))-half,highX=Math.max(...geometry.map(p=>p.x))+half,lowZ=Math.min(...geometry.map(p=>p.z))-half,highZ=Math.max(...geometry.map(p=>p.z))+half;
    for(let x=Math.floor(lowX/CELL_M);x<=Math.floor(highX/CELL_M);x++)for(let z=Math.floor(lowZ/CELL_M);z<=Math.floor(highZ/CELL_M);z++){const k=cell(x*CELL_M,z*CELL_M),bucket=this.segmentCells.get(k)??new Set<string>();bucket.add(segment.id);this.segmentCells.set(k,bucket);}
  }
}
