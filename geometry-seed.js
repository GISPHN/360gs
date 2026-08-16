import { sphericalDetectFeatures, sphericalMatchFeatures } from './spherical.js?v=0.3c18';

const GS_WIDTH = 640;
const GS_HEIGHT = 320;
const GS_MAX_FEATURES = 360;
const GS_MIN_PARALLAX_DEG = 0.30;
const GS_MAX_PARALLAX_DEG = 50.0;
const GS_MAX_REPROJ_DEG = 0.80;
const GS_MAX_GAP_BASELINE = 0.06;
const GS_MIN_DEPTH_BASELINE = 0.15;
const GS_MAX_DEPTH_BASELINE = 100.0;
const GS_MAX_POINTS = 3200;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function norm(v){return Math.hypot(v[0],v[1],v[2]);}
function normalize(v){const n=norm(v);return n>1e-12?v.map(x=>x/n):[0,0,1];}
function add(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function scale(v,s){return[v[0]*s,v[1]*s,v[2]*s];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function matVec(m,v){return[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];}
function angleDeg(a,b){return Math.acos(clamp(dot(normalize(a),normalize(b)),-1,1))*180/Math.PI;}
function median(values){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}

async function seek(video,time){
  const bounded=Math.max(0,Math.min(video.duration-.001,time));
  if(Math.abs(video.currentTime-bounded)<.008&&video.readyState>=2)return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('ERP幾何seed用フレーム取得がタイムアウトしました。'));},12000);
    const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(new Error('ERP幾何seed用フレームを取得できませんでした。'));};
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};
    video.addEventListener('seeked',done,{once:true});video.addEventListener('error',fail,{once:true});video.currentTime=bounded;
  });
}

function rgbAt(data,x,y){
  const xx=Math.max(0,Math.min(data.width-1,Math.round(x))),yy=Math.max(0,Math.min(data.height-1,Math.round(y))),i=(yy*data.width+xx)*4;
  return[data.rgba[i],data.rgba[i+1],data.rgba[i+2]];
}

async function captureFrame(video,time,canvas,ctx){
  await seek(video,time);
  ctx.drawImage(video,0,0,GS_WIDTH,GS_HEIGHT);
  const im=ctx.getImageData(0,0,GS_WIDTH,GS_HEIGHT),gray=new Float32Array(GS_WIDTH*GS_HEIGHT);
  for(let i=0,j=0;i<im.data.length;i+=4,j++)gray[j]=.299*im.data[i]+.587*im.data[i+1]+.114*im.data[i+2];
  const features=sphericalDetectFeatures(gray,GS_WIDTH,GS_HEIGHT,{maxFeatures:GS_MAX_FEATURES,minAngleDeg:1.35,minResponse:700,minStd:5.0,maxLatitudeDeg:82});
  return{width:GS_WIDTH,height:GS_HEIGHT,rgba:im.data,features};
}

function triangulate(C1,d1,C2,d2){
  const b=dot(d1,d2),w0=sub(C1,C2),d=dot(d1,w0),e=dot(d2,w0),den=1-b*b;
  if(!Number.isFinite(den)||den<1e-6)return null;
  const s=(b*e-d)/den,t=(e-b*d)/den;
  if(!(s>0&&t>0))return null;
  const p1=add(C1,scale(d1,s)),p2=add(C2,scale(d2,t)),point=scale(add(p1,p2),.5);
  return{point,s,t,gap:norm(sub(p1,p2))};
}

function dedupe(points,cell){
  if(!points.length)return[];
  const map=new Map(),out=[];
  const key=p=>`${Math.round(p.position[0]/cell)}:${Math.round(p.position[1]/cell)}:${Math.round(p.position[2]/cell)}`;
  for(const p of [...points].sort((a,b)=>b.score-a.score)){
    const k=key(p);if(map.has(k))continue;map.set(k,true);out.push(p);if(out.length>=GS_MAX_POINTS)break;
  }
  return out;
}

export async function buildTriangulatedGeometrySeeds(video,item,selectedIndices,onProgress=()=>{}){
  const poses=item?.optimization?.poses||[],frames=item?.source?.frames||[];
  const selected=(selectedIndices||[]).filter(i=>poses[i]&&frames[i]);
  if(selected.length<2)return{points:[],pairs:0,acceptedPairs:0,rawMatches:0,rejected:{},baseline:0};
  const canvas=document.createElement('canvas');canvas.width=GS_WIDTH;canvas.height=GS_HEIGHT;
  const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  if(!ctx)throw new Error('ERP幾何seed用Canvasを作成できません。');
  const captured=new Map();
  for(let n=0;n<selected.length;n++){
    const i=selected[n];captured.set(i,await captureFrame(video,frames[i].time,canvas,ctx));onProgress((n+1)/selected.length*.35,`ERP特徴を抽出しています ${n+1}/${selected.length}`);await new Promise(r=>setTimeout(r,0));
  }
  const baselines=[];for(let n=0;n<selected.length-1;n++)baselines.push(norm(sub(poses[selected[n+1]].position,poses[selected[n]].position)));
  const baselineRef=Math.max(1e-4,median(baselines.filter(x=>x>1e-6))||1);
  const pairList=[];
  for(let n=0;n<selected.length;n++)for(const step of [1,2])if(n+step<selected.length)pairList.push([selected[n],selected[n+step]]);
  const points=[],rejected={parallax:0,depth:0,gap:0,reprojection:0,degenerate:0},usedPairs=new Set();let rawMatches=0;
  for(let pi=0;pi<pairList.length;pi++){
    const [ia,ib]=pairList[pi],a=captured.get(ia),b=captured.get(ib),pa=poses[ia],pb=poses[ib];
    const baseline=norm(sub(pb.position,pa.position));if(baseline<baselineRef*.05)continue;
    const matches=sphericalMatchFeatures(a.features,b.features,{ratio:.80,reverseRatio:.83,minConfidence:.10});rawMatches+=matches.length;
    let accepted=0;
    for(const m of matches){
      const d1=normalize(matVec(pa.cameraToWorld,m.left.bearing)),d2=normalize(matVec(pb.cameraToWorld,m.right.bearing));
      const parallax=angleDeg(d1,d2);if(parallax<GS_MIN_PARALLAX_DEG||parallax>GS_MAX_PARALLAX_DEG){rejected.parallax++;continue;}
      const tri=triangulate(pa.position,d1,pb.position,d2);if(!tri){rejected.degenerate++;continue;}
      if(tri.s<baseline*GS_MIN_DEPTH_BASELINE||tri.t<baseline*GS_MIN_DEPTH_BASELINE||tri.s>baseline*GS_MAX_DEPTH_BASELINE||tri.t>baseline*GS_MAX_DEPTH_BASELINE){rejected.depth++;continue;}
      if(tri.gap/Math.max(baseline,1e-6)>GS_MAX_GAP_BASELINE){rejected.gap++;continue;}
      const e1=angleDeg(sub(tri.point,pa.position),d1),e2=angleDeg(sub(tri.point,pb.position),d2),reproj=Math.max(e1,e2);
      if(reproj>GS_MAX_REPROJ_DEG){rejected.reprojection++;continue;}
      const ca=rgbAt(a,m.left.x,m.left.y),cb=rgbAt(b,m.right.x,m.right.y),color=[0,1,2].map(k=>Math.round((ca[k]+cb[k])*.5));
      const score=(m.confidence||.1)*(1/(.05+reproj))*(1+Math.min(parallax,8)/8);
      points.push({position:tri.point,color,score,parallaxDeg:parallax,reprojDeg:reproj,pair:[ia,ib]});accepted++;
    }
    if(accepted)usedPairs.add(`${ia}:${ib}`);
    onProgress(.35+(pi+1)/pairList.length*.65,`2視点三角測量 ${pi+1}/${pairList.length}`);await new Promise(r=>setTimeout(r,0));
  }
  const dedupeCell=Math.max(baselineRef*.025,1e-5),unique=dedupe(points,dedupeCell);
  return{points:unique,pairs:pairList.length,acceptedPairs:usedPairs.size,rawMatches,rejected,baseline:baselineRef,medianParallaxDeg:median(unique.map(p=>p.parallaxDeg)),medianReprojDeg:median(unique.map(p=>p.reprojDeg))};
}
