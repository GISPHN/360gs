// v0.3c20: conservative post-triangulation pose refinement for 360GS.
//
// c19 creates many pose-guided spherical 3D points after the earlier BA has
// already finished.  This module feeds only independently supported (>=3 view)
// 2D-3D correspondences back into a small robust spherical bundle adjustment
// before Brush training.  Updates are deliberately bounded and are accepted
// only when global angular metrics improve; otherwise the complete state is
// rolled back.

const PR_MAX_ITERS = 6;
const PR_MIN_TRACKS = 12;
const PR_MIN_OBSERVATIONS = 42;
const PR_HUBER_DEG = 0.85;
const PR_OUTLIER_DEG = 3.0;
const PR_ROT_EPS = 2e-5;
const PR_TRANS_EPS_FACTOR = 1e-4;
const PR_MAX_ROT_STEP_DEG = 0.28;
const PR_MAX_ROT_TOTAL_DEG = 1.15;
const PR_MAX_TRANS_STEP_BASELINE = 0.025;
const PR_MAX_TRANS_TOTAL_BASELINE = 0.12;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function norm(v){return Math.hypot(v[0],v[1],v[2]);}
function normalize(v){const n=norm(v);return n>1e-12?v.map(x=>x/n):[0,0,1];}
function add(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function scale(v,s){return[v[0]*s,v[1]*s,v[2]*s];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function matVec(m,v){return[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];}
function matT(m){return[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]];}
function matMul(a,b){const o=new Array(9).fill(0);for(let r=0;r<3;r++)for(let c=0;c<3;c++)o[r*3+c]=a[r*3]*b[c]+a[r*3+1]*b[c+3]+a[r*3+2]*b[c+6];return o;}
function median(v){if(!v.length)return 0;const a=[...v].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;}
function quantile(v,q){if(!v.length)return 0;const a=[...v].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),t=p-i;return a[i]*(1-t)+a[Math.min(i+1,a.length-1)]*t;}
function angleDeg(a,b){return Math.acos(clamp(dot(normalize(a),normalize(b)),-1,1))*180/Math.PI;}

function clonePose(p){return{...p,position:[...p.position],cameraToWorld:[...p.cameraToWorld]};}
function clonePoses(p){return p.map(clonePose);}
function expSO3(d){
  const th=norm(d);if(th<1e-12)return[1,0,0,0,1,0,0,0,1];
  const [x,y,z]=d.map(v=>v/th),c=Math.cos(th),s=Math.sin(th),t=1-c;
  return[t*x*x+c,t*x*y-s*z,t*x*z+s*y,t*x*y+s*z,t*y*y+c,t*y*z-s*x,t*x*z-s*y,t*y*z+s*x,t*z*z+c];
}
function solveLinear(matrix,rhs,n){
  const a=Array.from(matrix),b=Array.from(rhs);
  for(let c=0;c<n;c++){
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(a[r*n+c])>Math.abs(a[p*n+c]))p=r;
    if(Math.abs(a[p*n+c])<1e-10)return null;
    if(p!==c){for(let k=c;k<n;k++)[a[c*n+k],a[p*n+k]]=[a[p*n+k],a[c*n+k]];[b[c],b[p]]=[b[p],b[c]];}
    const d=a[c*n+c];for(let k=c;k<n;k++)a[c*n+k]/=d;b[c]/=d;
    for(let r=0;r<n;r++){if(r===c)continue;const f=a[r*n+c];if(Math.abs(f)<1e-14)continue;for(let k=c;k<n;k++)a[r*n+k]-=f*a[c*n+k];b[r]-=f*b[c];}
  }
  return b;
}
function predictedBearing(pose,point){return normalize(matVec(matT(pose.cameraToWorld),normalize(sub(point,pose.position))));}
function residual(pose,point,observed){const p=predictedBearing(pose,point);return{vec:[p[0]-observed[0],p[1]-observed[1],p[2]-observed[2]],angleDeg:angleDeg(p,observed)};}
function huberWeight(deg){return deg<=PR_HUBER_DEG?1:PR_HUBER_DEG/Math.max(deg,1e-6);}

function solvePoint(observations,poses){
  const A=new Array(9).fill(0),b=[0,0,0];let n=0;
  for(const o of observations){const pose=poses[o.frameIndex];if(!pose)continue;const d=normalize(matVec(pose.cameraToWorld,o.bearing)),C=pose.position,M=[1-d[0]*d[0],-d[0]*d[1],-d[0]*d[2],-d[1]*d[0],1-d[1]*d[1],-d[1]*d[2],-d[2]*d[0],-d[2]*d[1],1-d[2]*d[2]];for(let i=0;i<9;i++)A[i]+=M[i];const mc=matVec(M,C);b[0]+=mc[0];b[1]+=mc[1];b[2]+=mc[2];n++;}
  if(n<3)return null;const p=solveLinear(A,b,3);if(!p||!p.every(Number.isFinite))return null;
  let positive=0;for(const o of observations){const pose=poses[o.frameIndex],d=normalize(matVec(pose.cameraToWorld,o.bearing));if(dot(d,sub(p,pose.position))>0)positive++;}
  return positive/n>=.8?p:null;
}

function buildTracks(points,poses){
  const out=[];
  for(const p of points||[]){
    const seen=new Set(),obs=[];
    for(const o of p.observations||[]){if(!Number.isInteger(o.frameIndex)||seen.has(o.frameIndex)||!Array.isArray(o.bearing)||o.bearing.length!==3)continue;seen.add(o.frameIndex);obs.push({frameIndex:o.frameIndex,bearing:normalize(o.bearing),weight:clamp(Number(o.weight)||1,.2,2)});}
    if(obs.length<3)continue;
    const position=solvePoint(obs,poses)||p.position;
    if(!position?.every(Number.isFinite))continue;
    const angles=obs.map(o=>residual(poses[o.frameIndex],position,o.bearing).angleDeg);
    if(median(angles)>1.35||quantile(angles,.9)>2.5)continue;
    out.push({source:p,position:[...position],observations:obs,score:Number(p.score)||1});
  }
  return out;
}
function metrics(tracks,poses){
  const angles=[];let cost=0;
  for(const t of tracks)for(const o of t.observations){const a=residual(poses[o.frameIndex],t.position,o.bearing).angleDeg;if(!Number.isFinite(a))continue;angles.push(a);const x=Math.min(a,PR_OUTLIER_DEG),h=x<=PR_HUBER_DEG?.5*x*x:PR_HUBER_DEG*(x-.5*PR_HUBER_DEG);cost+=h*o.weight;}
  const inliers=angles.filter(a=>a<=PR_OUTLIER_DEG),rms=inliers.length?Math.sqrt(inliers.reduce((s,a)=>s+a*a,0)/inliers.length):Infinity;
  return{count:angles.length,inliers:inliers.length,medianDeg:median(inliers),p90Deg:quantile(inliers,.9),rmsDeg:rms,outlierRate:1-inliers.length/Math.max(1,angles.length),cost};
}
function perturbPose(pose,param,eps){const q=clonePose(pose);if(param<3){const d=[0,0,0];d[param]=eps;q.cameraToWorld=matMul(q.cameraToWorld,expSO3(d));}else q.position[param-3]+=eps;return q;}
function cameraCost(index,tracks,poses,proposal=null){let c=0,n=0;const pose=proposal||poses[index];for(const t of tracks)for(const o of t.observations)if(o.frameIndex===index){const a=residual(pose,t.position,o.bearing).angleDeg,x=Math.min(a,PR_OUTLIER_DEG);c+=(x<=PR_HUBER_DEG?.5*x*x:PR_HUBER_DEG*(x-.5*PR_HUBER_DEG))*o.weight;n++;}return n?c/n:Infinity;}
function refineCamera(index,tracks,poses,baseline,lambda,fixed){
  if(fixed.has(index))return false;const relevant=[];for(const t of tracks)for(const o of t.observations)if(o.frameIndex===index)relevant.push({t,o});if(relevant.length<8)return false;
  const H=new Array(36).fill(0),g=new Array(6).fill(0),pose=poses[index],teps=Math.max(1e-6,baseline*PR_TRANS_EPS_FACTOR);
  for(const {t,o} of relevant){const base=residual(pose,t.position,o.bearing),J=[[],[],[]];for(let p=0;p<6;p++){const eps=p<3?PR_ROT_EPS:teps,pr=residual(perturbPose(pose,p,eps),t.position,o.bearing).vec;for(let r=0;r<3;r++)J[r][p]=(pr[r]-base.vec[r])/eps;}const w=huberWeight(base.angleDeg)*o.weight,sw=Math.sqrt(w);for(let r=0;r<3;r++){const rr=base.vec[r]*sw;for(let c=0;c<6;c++){const jc=J[r][c]*sw;g[c]+=jc*rr;for(let d=c;d<6;d++)H[c*6+d]+=jc*J[r][d]*sw;}}}
  for(let c=0;c<6;c++){for(let d=0;d<c;d++)H[c*6+d]=H[d*6+c];H[c*6+c]+=lambda;}
  const step=solveLinear(H,g.map(x=>-x),6);if(!step)return false;let rot=step.slice(0,3),tr=step.slice(3);const rn=norm(rot),tn=norm(tr),mr=PR_MAX_ROT_STEP_DEG*Math.PI/180,mt=baseline*PR_MAX_TRANS_STEP_BASELINE;if(rn>mr)rot=scale(rot,mr/rn);if(tn>mt)tr=scale(tr,mt/tn);
  const before=cameraCost(index,tracks,poses);let best=null;for(const s of [1,.5,.25,.125]){const pr={...pose,cameraToWorld:matMul(pose.cameraToWorld,expSO3(scale(rot,s))),position:add(pose.position,scale(tr,s))},after=cameraCost(index,tracks,poses,pr);if(Number.isFinite(after)&&after<before-1e-10&&(!best||after<best.cost))best={pose:pr,cost:after};}if(!best)return false;poses[index]=best.pose;return true;
}
function baselineReference(poses,selected){const b=[];for(let i=0;i<selected.length-1;i++){const a=poses[selected[i]],c=poses[selected[i+1]];if(a&&c){const d=norm(sub(c.position,a.position));if(d>1e-6)b.push(d);}}return Math.max(1e-5,median(b)||1);}
function fixedIndices(poses,selected,baseline){const fixed=new Set();if(!selected.length)return fixed;fixed.add(selected[0]);const origin=poses[selected[0]].position;let anchor=selected[Math.min(1,selected.length-1)];for(const i of selected.slice(1)){if(norm(sub(poses[i].position,origin))>=baseline*.8){anchor=i;break;}}fixed.add(anchor);return fixed;}
function totalMotion(original,poses,selected){const trans=[],rot=[];for(const i of selected){trans.push(norm(sub(poses[i].position,original[i].position)));const R=matMul(matT(original[i].cameraToWorld),poses[i].cameraToWorld),trace=R[0]+R[4]+R[8],a=Math.acos(clamp((trace-1)/2,-1,1))*180/Math.PI;rot.push(a);}return{maxTranslation:Math.max(0,...trans),p90Translation:quantile(trans,.9),maxRotationDeg:Math.max(0,...rot),p90RotationDeg:quantile(rot,.9)};}

export function refinePosesFromTriangulatedPoints(inputPoses,points,selectedIndices){
  const selected=(selectedIndices||[]).filter(i=>inputPoses?.[i]);if(selected.length<3)return{accepted:false,reason:'pose再調整に必要な撮影位置が不足しています。',poses:inputPoses,points,usedTracks:0,usedObservations:0};
  const original=clonePoses(inputPoses),poses=clonePoses(inputPoses),baseline=baselineReference(poses,selected),tracks=buildTracks(points,poses),obs=tracks.reduce((s,t)=>s+t.observations.length,0);
  if(tracks.length<PR_MIN_TRACKS||obs<PR_MIN_OBSERVATIONS)return{accepted:false,reason:`独立した3視点以上の球面対応が不足しています（${tracks.length}点 / ${obs}観測）。`,poses:inputPoses,points,usedTracks:tracks.length,usedObservations:obs};
  const initial=metrics(tracks,poses),fixed=fixedIndices(poses,selected,baseline);let bestPoses=clonePoses(poses),bestTracks=tracks.map(t=>({...t,position:[...t.position]})),best={...initial},lambda=3e-3,iterations=0;
  for(let it=0;it<PR_MAX_ITERS;it++){
    const beforePoses=clonePoses(poses),beforeTracks=tracks.map(t=>({...t,position:[...t.position]})),before=metrics(tracks,poses);let changed=0;
    // Re-triangulate only independently supported points using all available
    // spherical observations before each camera step.
    for(const t of tracks){const p=solvePoint(t.observations,poses);if(p){t.position=p;changed++;}}
    for(const i of selected)if(refineCamera(i,tracks,poses,baseline,lambda,fixed))changed++;
    const now=metrics(tracks,poses),motion=totalMotion(original,poses,selected),safeMotion=motion.maxTranslation<=baseline*PR_MAX_TRANS_TOTAL_BASELINE&&motion.maxRotationDeg<=PR_MAX_ROT_TOTAL_DEG;
    const safeMetrics=Number.isFinite(now.cost)&&now.rmsDeg<=before.rmsDeg*1.01+1e-4&&now.p90Deg<=before.p90Deg*1.01+1e-4&&now.outlierRate<=Math.max(before.outlierRate+.01,.12);
    if(!safeMotion||!safeMetrics){for(let i=0;i<poses.length;i++)poses[i]=beforePoses[i];for(let i=0;i<tracks.length;i++)tracks[i].position=beforeTracks[i].position;lambda=Math.min(.5,lambda*4);if(it>=2)break;continue;}
    iterations=it+1;lambda=changed?Math.max(5e-5,lambda*.65):Math.min(.5,lambda*2.5);
    const improves=now.cost<best.cost*.999&&now.medianDeg<=best.medianDeg*1.002&&now.p90Deg<=best.p90Deg*1.002;
    if(improves){best={...now};bestPoses=clonePoses(poses);bestTracks=tracks.map(t=>({...t,position:[...t.position]}));}
    if(!changed||now.medianDeg<.10)break;
  }
  const improvement=initial.medianDeg>1e-8?(initial.medianDeg-best.medianDeg)/initial.medianDeg:0,p90Improvement=initial.p90Deg>1e-8?(initial.p90Deg-best.p90Deg)/initial.p90Deg:0,motion=totalMotion(original,bestPoses,selected);
  const accepted=best.cost<initial.cost*.995&&(improvement>=.015||p90Improvement>=.025)&&best.rmsDeg<=initial.rmsDeg*1.002&&best.outlierRate<=Math.max(initial.outlierRate+.005,.10)&&motion.maxTranslation<=baseline*PR_MAX_TRANS_TOTAL_BASELINE&&motion.maxRotationDeg<=PR_MAX_ROT_TOTAL_DEG;
  if(!accepted)return{accepted:false,reason:'球面2D–3D対応によるpose再調整で十分な全体誤差改善を確認できなかったため、c19の姿勢を維持します。',poses:inputPoses,points,initial,final:best,iterations,usedTracks:tracks.length,usedObservations:obs,fixed:[...fixed],motion,baseline};
  const bySource=new Map(bestTracks.map(t=>[t.source,t.position]));const refinedPoints=(points||[]).map(p=>bySource.has(p)?{...p,position:[...bySource.get(p)]}:p);
  return{accepted:true,reason:'独立した3視点以上の球面2D–3D対応で角度誤差が改善したため、再調整したcamera poseを採用します。',poses:bestPoses,points:refinedPoints,initial,final:best,iterations,usedTracks:tracks.length,usedObservations:obs,fixed:[...fixed],motion,baseline,medianImprovement:improvement,p90Improvement};
}
