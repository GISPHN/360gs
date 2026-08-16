import { sphericalDetectFeatures } from './spherical.js?v=0.3c19';

// c19: denser direct-ERP geometry with pose-guided spherical epipolar matching.
// Camera poses have already been robustly optimized by the BA stage.  Rather
// than globally comparing every descriptor, we use those poses to constrain
// candidate correspondences to the spherical epipolar great-circle, then
// retain only mutually supported descriptor matches and guarded triangulation.
const GS_WIDTH = 960;
const GS_HEIGHT = 480;
const GS_MAX_FEATURES = 1100;
const GS_PAIR_STEPS = [1, 2, 3];
const GS_EPIPOLAR_DEG = 1.15;
const GS_DESCRIPTOR_RATIO = 0.80;
const GS_REVERSE_RATIO = 0.84;
const GS_MIN_CORRELATION = 0.18;
const GS_MIN_PARALLAX_DEG = 0.25;
const GS_MAX_PARALLAX_DEG = 55.0;
const GS_MAX_REPROJ_DEG = 0.65;
const GS_MAX_GAP_BASELINE = 0.045;
const GS_MIN_DEPTH_BASELINE = 0.12;
const GS_MAX_DEPTH_BASELINE = 120.0;
const GS_THIRD_VIEW_ANGLE_DEG = 0.85;
const GS_MAX_POINTS = 5200;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function norm(v){return Math.hypot(v[0],v[1],v[2]);}
function normalize(v){const n=norm(v);return n>1e-12?v.map(x=>x/n):[0,0,1];}
function add(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function scale(v,s){return[v[0]*s,v[1]*s,v[2]*s];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function matVec(m,v){return[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];}
function matT(m){return[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]];}
function angleDeg(a,b){return Math.acos(clamp(dot(normalize(a),normalize(b)),-1,1))*180/Math.PI;}
function median(values){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function quantile(values,q){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),t=p-i;return a[i]*(1-t)+a[Math.min(i+1,a.length-1)]*t;}

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
  const features=sphericalDetectFeatures(gray,GS_WIDTH,GS_HEIGHT,{
    maxFeatures:GS_MAX_FEATURES,
    scanStep:3,
    minAngleDeg:.78,
    minResponse:520,
    minStd:4.5,
    maxLatitudeDeg:84,
    angularStep:(Math.PI*2/GS_WIDTH)*2.0,
  });
  return{width:GS_WIDTH,height:GS_HEIGHT,rgba:im.data,gray,features};
}

function descriptorDistance(a,b){let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;}
function descriptorCorrelation(a,b){if(!a?.length||a.length!==b?.length)return-1;let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s/a.length;}
function worldBearing(pose,feature){return normalize(matVec(pose.cameraToWorld,feature.bearing));}

// Angular distance from ray d2 to the epipolar great-circle formed by d1 and
// the camera baseline. For exact spherical correspondences this is zero.
function epipolarErrorDeg(d1,d2,baseline){
  const n=cross(d1,baseline),nn=norm(n);if(nn<1e-10)return 180;
  return Math.asin(clamp(Math.abs(dot(scale(n,1/nn),d2)),-1,1))*180/Math.PI;
}

function directedPoseMatches(left,right,leftPose,rightPose,ratio){
  const baseline=normalize(sub(rightPose.position,leftPose.position));
  const rw=right.features.map(f=>worldBearing(rightPose,f));
  const out=new Array(left.features.length).fill(null);
  for(let i=0;i<left.features.length;i++){
    const lf=left.features[i],d1=worldBearing(leftPose,lf);let best=Infinity,second=Infinity,bestIndex=-1,bestEpi=180;
    for(let j=0;j<right.features.length;j++){
      const epi=epipolarErrorDeg(d1,rw[j],baseline);if(epi>GS_EPIPOLAR_DEG)continue;
      const dist=descriptorDistance(lf.descriptor,right.features[j].descriptor);
      if(dist<best){second=best;best=dist;bestIndex=j;bestEpi=epi;}else if(dist<second)second=dist;
    }
    if(bestIndex<0||!Number.isFinite(second)||second<=1e-9||best>second*ratio)continue;
    const rf=right.features[bestIndex],corr=descriptorCorrelation(lf.descriptor,rf.descriptor);if(corr<GS_MIN_CORRELATION)continue;
    out[i]={index:bestIndex,best,second,epi:bestEpi,corr};
  }
  return out;
}

function poseGuidedMatches(left,right,leftPose,rightPose){
  const fwd=directedPoseMatches(left,right,leftPose,rightPose,GS_DESCRIPTOR_RATIO);
  const rev=directedPoseMatches(right,left,rightPose,leftPose,GS_REVERSE_RATIO),matches=[];
  for(let i=0;i<fwd.length;i++){
    const a=fwd[i];if(!a)continue;const b=rev[a.index];if(!b||b.index!==i)continue;
    const lf=left.features[i],rf=right.features[a.index];
    const ratioScore=clamp(1-a.best/Math.max(a.second,1e-9),0,1),epiScore=clamp(1-a.epi/GS_EPIPOLAR_DEG,0,1),corrScore=clamp((a.corr+1)/2,0,1);
    const confidence=clamp(.35*((lf.baseConfidence||0)+(rf.baseConfidence||0))/2+.30*ratioScore+.20*epiScore+.15*corrScore,0,1);
    matches.push({left:lf,right:rf,distance:a.best,confidence,quality:a.best/Math.max(a.second,1e-9),epipolarDeg:a.epi,correlation:a.corr,source:'erp-pose-guided'});
  }
  return matches.sort((a,b)=>b.confidence-a.confidence||a.epipolarDeg-b.epipolarDeg||a.distance-b.distance);
}

function triangulate(C1,d1,C2,d2){
  const b=dot(d1,d2),w0=sub(C1,C2),d=dot(d1,w0),e=dot(d2,w0),den=1-b*b;
  if(!Number.isFinite(den)||den<1e-7)return null;
  const s=(b*e-d)/den,t=(e-b*d)/den;
  if(!(s>0&&t>0))return null;
  const p1=add(C1,scale(d1,s)),p2=add(C2,scale(d2,t)),point=scale(add(p1,p2),.5);
  return{point,s,t,gap:norm(sub(p1,p2))};
}

function nearestFeatureSupport(point,sourceDescriptor,candidateIndex,captured,poses){
  const frame=captured.get(candidateIndex),pose=poses[candidateIndex];if(!frame||!pose)return null;
  const local=normalize(matVec(matT(pose.cameraToWorld),sub(point,pose.position)));
  let best=null,bestAngle=Infinity;
  for(const f of frame.features){
    const a=angleDeg(local,f.bearing);if(a<bestAngle){bestAngle=a;best=f;}
  }
  if(!best||bestAngle>GS_THIRD_VIEW_ANGLE_DEG)return null;
  const corr=descriptorCorrelation(sourceDescriptor,best.descriptor);if(corr<.10)return null;
  return{angleDeg:bestAngle,correlation:corr};
}

function thirdViewSupport(point,sourceDescriptor,ia,ib,selected,captured,poses){
  const pa=selected.indexOf(ia),pb=selected.indexOf(ib),near=[];
  for(const p of [pa-1,pa+1,pb-1,pb+1])if(p>=0&&p<selected.length&&!near.includes(selected[p])&&selected[p]!==ia&&selected[p]!==ib)near.push(selected[p]);
  let support=0,bestAngle=Infinity;
  for(const i of near){const s=nearestFeatureSupport(point,sourceDescriptor,i,captured,poses);if(s){support++;bestAngle=Math.min(bestAngle,s.angleDeg);}}
  return{support,bestAngle:Number.isFinite(bestAngle)?bestAngle:null};
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
  if(selected.length<2)return{points:[],pairs:0,acceptedPairs:0,rawMatches:0,rejected:{},baseline:0,featureCount:0};
  const canvas=document.createElement('canvas');canvas.width=GS_WIDTH;canvas.height=GS_HEIGHT;
  const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  if(!ctx)throw new Error('ERP幾何seed用Canvasを作成できません。');
  const captured=new Map();let featureCount=0;
  for(let n=0;n<selected.length;n++){
    const i=selected[n],frame=await captureFrame(video,frames[i].time,canvas,ctx);captured.set(i,frame);featureCount+=frame.features.length;
    onProgress((n+1)/selected.length*.30,`高密度ERP特徴を抽出しています ${n+1}/${selected.length}（${frame.features.length}点）`);await new Promise(r=>setTimeout(r,0));
  }
  const baselines=[];for(let n=0;n<selected.length-1;n++)baselines.push(norm(sub(poses[selected[n+1]].position,poses[selected[n]].position)));
  const baselineRef=Math.max(1e-4,median(baselines.filter(x=>x>1e-6))||1);
  const pairList=[];for(let n=0;n<selected.length;n++)for(const step of GS_PAIR_STEPS)if(n+step<selected.length)pairList.push([selected[n],selected[n+step]]);
  const points=[],rejected={epipolar:0,parallax:0,depth:0,gap:0,reprojection:0,degenerate:0,multiview:0},usedPairs=new Set();let rawMatches=0,acceptedRaw=0;
  for(let pi=0;pi<pairList.length;pi++){
    const [ia,ib]=pairList[pi],a=captured.get(ia),b=captured.get(ib),pa=poses[ia],pb=poses[ib],baseline=norm(sub(pb.position,pa.position));
    if(baseline<baselineRef*.04)continue;
    const matches=poseGuidedMatches(a,b,pa,pb);rawMatches+=matches.length;let accepted=0;
    for(const m of matches){
      if(m.epipolarDeg>GS_EPIPOLAR_DEG){rejected.epipolar++;continue;}
      const d1=worldBearing(pa,m.left),d2=worldBearing(pb,m.right),parallax=angleDeg(d1,d2);
      if(parallax<GS_MIN_PARALLAX_DEG||parallax>GS_MAX_PARALLAX_DEG){rejected.parallax++;continue;}
      const tri=triangulate(pa.position,d1,pb.position,d2);if(!tri){rejected.degenerate++;continue;}
      if(tri.s<baseline*GS_MIN_DEPTH_BASELINE||tri.t<baseline*GS_MIN_DEPTH_BASELINE||tri.s>baseline*GS_MAX_DEPTH_BASELINE||tri.t>baseline*GS_MAX_DEPTH_BASELINE){rejected.depth++;continue;}
      if(tri.gap/Math.max(baseline,1e-6)>GS_MAX_GAP_BASELINE){rejected.gap++;continue;}
      const e1=angleDeg(sub(tri.point,pa.position),d1),e2=angleDeg(sub(tri.point,pb.position),d2),reproj=Math.max(e1,e2);
      if(reproj>GS_MAX_REPROJ_DEG){rejected.reprojection++;continue;}
      const third=thirdViewSupport(tri.point,m.left.descriptor,ia,ib,selected,captured,poses);
      // A third observation is preferred. Exceptionally clean two-view points
      // remain usable so low-texture sequences do not fail unnecessarily.
      const strongTwoView=reproj<.30&&m.epipolarDeg<.45&&m.correlation>.28&&m.confidence>.36;
      if(!third.support&&!strongTwoView){rejected.multiview++;continue;}
      const ca=rgbAt(a,m.left.x,m.left.y),cb=rgbAt(b,m.right.x,m.right.y),color=[0,1,2].map(k=>Math.round((ca[k]+cb[k])*.5));
      const score=(m.confidence||.1)*(1/(.08+reproj))*(1/(.15+m.epipolarDeg))*(1+Math.min(parallax,10)/10)*(1+.35*third.support);
      points.push({position:tri.point,color,score,parallaxDeg:parallax,reprojDeg:reproj,epipolarDeg:m.epipolarDeg,supportViews:2+third.support,pair:[ia,ib],source:'stereo'});accepted++;acceptedRaw++;
    }
    if(accepted)usedPairs.add(`${ia}:${ib}`);
    onProgress(.30+(pi+1)/Math.max(1,pairList.length)*.70,`球面epipolar三角測量 ${pi+1}/${pairList.length}（採用 ${acceptedRaw}点）`);await new Promise(r=>setTimeout(r,0));
  }
  const dedupeCell=Math.max(baselineRef*.014,1e-5),unique=dedupe(points,dedupeCell);
  return{
    points:unique,pairs:pairList.length,acceptedPairs:usedPairs.size,rawMatches,rejected,baseline:baselineRef,featureCount,
    medianParallaxDeg:median(unique.map(p=>p.parallaxDeg)),medianReprojDeg:median(unique.map(p=>p.reprojDeg)),medianEpipolarDeg:median(unique.map(p=>p.epipolarDeg)),
    p90ReprojDeg:quantile(unique.map(p=>p.reprojDeg),.90),multiViewPoints:unique.filter(p=>(p.supportViews||2)>=3).length,
  };
}
