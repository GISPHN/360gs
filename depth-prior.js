// c19 guarded browser depth prior.
//
// PFGS360 uses panoramic monocular depth only after aligning it to the current
// reconstruction and retaining cross-view-consistent inliers.  The browser app
// cannot ship PFGS360's Python/CUDA/UniK3D stack, so this module uses a small
// Apache-2.0 web depth model as an optional relative-depth proposal.  No depth
// point is accepted unless real triangulated geometry calibrates that face and
// a second camera position confirms the aligned range.

const TFJS_URL='https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const DEPTH_MODEL='onnx-community/depth-anything-v2-small-ONNX';
const DEPTH_SIZE=392;
const MIN_FACE_ANCHORS=7;
const MAX_FACE_MEDIAN_REL=.20;
const MAX_FACE_P90_REL=.38;
const CROSS_VIEW_REL=.24;
const MAX_DEPTH_POINTS=1800;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function norm(v){return Math.hypot(v[0],v[1],v[2]);}
function add(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];}
function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function scale(v,s){return[v[0]*s,v[1]*s,v[2]*s];}
function normalize(v){const n=norm(v)||1;return[v[0]/n,v[1]/n,v[2]/n];}
function matVec(m,v){return[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];}
function matMul(a,b){const o=Array(9).fill(0);for(let r=0;r<3;r++)for(let c=0;c<3;c++)o[r*3+c]=a[r*3]*b[c]+a[r*3+1]*b[c+3]+a[r*3+2]*b[c+6];return o;}
function matT(m){return[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]];}
function yaw(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[c,0,s,0,1,0,-s,0,c];}
function pitch(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[1,0,0,0,c,-s,0,s,c];}
function faceRot(face){return matMul(yaw(face.yaw),pitch(face.pitch));}
function median(values){if(!values.length)return Infinity;const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function quantile(values,q){if(!values.length)return Infinity;const a=[...values].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),t=p-i;return a[i]*(1-t)+a[Math.min(i+1,a.length-1)]*t;}

function project(point,pose,face,width,height,margin=.06){
  const R=matMul(pose.cameraToWorld,faceRot(face)),local=matVec(matT(R),sub(point,pose.position));
  if(!(local[2]>1e-7))return null;
  const nx=local[0]/local[2],ny=local[1]/local[2];
  if(Math.abs(nx)>1-margin||Math.abs(ny)>1-margin)return null;
  const x=(nx*.5+.5)*(width-1),y=(.5-ny*.5)*(height-1);
  return{x,y,range:norm(sub(point,pose.position)),local};
}

function rayFromPixel(pose,face,x,y,width,height){
  const nx=(x/(width-1)-.5)*2,ny=(.5-y/(height-1))*2,local=normalize([nx,ny,1]),R=matMul(pose.cameraToWorld,faceRot(face));
  return normalize(matVec(R,local));
}

function sample(data,width,height,x,y){
  const xx=clamp(x,0,width-1),yy=clamp(y,0,height-1),x0=Math.floor(xx),y0=Math.floor(yy),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=xx-x0,fy=yy-y0;
  const a=data[y0*width+x0],b=data[y0*width+x1],c=data[y1*width+x0],d=data[y1*width+x1];
  return(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
}

function fitLeastSquares(samples,mode,subset=null){
  const ids=subset||samples.map((_,i)=>i);let sx=0,sy=0,sxx=0,sxy=0,n=0;
  for(const i of ids){const s=samples[i],x=mode==='inverse'?1/Math.max(1e-6,s.pred):s.pred,y=s.range;if(!Number.isFinite(x)||!Number.isFinite(y))continue;sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;n++;}
  if(n<3)return null;const den=n*sxx-sx*sx;if(Math.abs(den)<1e-10)return null;const a=(n*sxy-sx*sy)/den,b=(sy-a*sx)/n;return{a,b,mode};
}
function applyFit(fit,pred){const x=fit.mode==='inverse'?1/Math.max(1e-6,pred):pred;return fit.a*x+fit.b;}
function robustFit(samples,mode){
  let fit=fitLeastSquares(samples,mode);if(!fit)return null;
  for(let round=0;round<2;round++){
    const ranked=samples.map((s,i)=>({i,e:Math.abs(applyFit(fit,s.pred)-s.range)/Math.max(.05,s.range)})).sort((a,b)=>a.e-b.e),keep=ranked.slice(0,Math.max(5,Math.ceil(ranked.length*.72))).map(x=>x.i);
    fit=fitLeastSquares(samples,mode,keep)||fit;
  }
  const errors=samples.map(s=>Math.abs(applyFit(fit,s.pred)-s.range)/Math.max(.05,s.range)).filter(Number.isFinite),positive=samples.filter(s=>applyFit(fit,s.pred)>0).length/Math.max(1,samples.length);
  return{...fit,medianRel:median(errors),p90Rel:quantile(errors,.90),anchors:samples.length,positive};
}
function chooseFit(samples){
  const direct=robustFit(samples,'direct'),inverse=robustFit(samples,'inverse'),c=[direct,inverse].filter(Boolean).filter(f=>f.positive>.90);
  if(!c.length)return null;c.sort((a,b)=>(a.medianRel+.35*a.p90Rel)-(b.medianRel+.35*b.p90Rel));const f=c[0];
  return f.anchors>=MIN_FACE_ANCHORS&&f.medianRel<=MAX_FACE_MEDIAN_REL&&f.p90Rel<=MAX_FACE_P90_REL?f:null;
}

function rgbaAt(canvas,x,y){const ctx=canvas.getContext('2d',{willReadFrequently:true}),p=ctx.getImageData(clamp(Math.round(x),0,canvas.width-1),clamp(Math.round(y),0,canvas.height-1),1,1).data;return[p[0],p[1],p[2]];}
function dedupe(points,cell){const m=new Map(),out=[];for(const p of [...points].sort((a,b)=>b.score-a.score)){const k=`${Math.round(p.position[0]/cell)}:${Math.round(p.position[1]/cell)}:${Math.round(p.position[2]/cell)}`;if(m.has(k))continue;m.set(k,1);out.push(p);if(out.length>=MAX_DEPTH_POINTS)break;}return out;}

function representativeIndices(selected){
  if(selected.length<=3)return[...selected];const pos=[.20,.50,.80].map(q=>selected[Math.round((selected.length-1)*q)]);return[...new Set(pos)];
}

export async function buildGuardedDepthPriorSeeds({item,selectedIndices,trustedPoints,faces,renderFace,onProgress=()=>{}}){
  const disabled={points:[],attempted:false,reason:'not-needed',validFaces:0,model:DEPTH_MODEL};
  const trusted=(trustedPoints||[]).filter(p=>p.position?.every(Number.isFinite));
  if(trusted.length>=900)return{...disabled,reason:'geometry-already-dense'};
  if(!navigator.gpu||(navigator.deviceMemory||4)<6)return{...disabled,reason:'insufficient-browser-gpu'};
  const poses=item?.optimization?.poses||[],selected=(selectedIndices||[]).filter(i=>poses[i]);if(selected.length<3)return{...disabled,reason:'too-few-camera-poses'};
  const reps=representativeIndices(selected),candidateFaces=[];
  for(const i of reps){for(const face of faces){const count=trusted.reduce((n,p)=>n+(project(p.position,poses[i],face,DEPTH_SIZE,DEPTH_SIZE,.12)?1:0),0);if(count>=MIN_FACE_ANCHORS)candidateFaces.push({index:i,face,anchorCount:count});}}
  if(candidateFaces.length<2)return{...disabled,reason:'too-few-calibratable-faces'};

  let pipe=null;const maps=[];
  try{
    onProgress(.02,'WebGPU相対depthモデルを読み込んでいます（画像は端末外へ送信しません）');
    const {pipeline,RawImage}=await import(TFJS_URL);
    pipe=await pipeline('depth-estimation',DEPTH_MODEL,{device:'webgpu',dtype:'q4'});
    for(let n=0;n<candidateFaces.length;n++){
      const c=candidateFaces[n],pose=poses[c.index];onProgress(.05+.58*n/candidateFaces.length,`相対depthを推定しています ${n+1}/${candidateFaces.length}`);
      const canvas=await renderFace(c.index,c.face,DEPTH_SIZE);const raw=RawImage.fromCanvas(canvas),output=await pipe(raw),tensor=output?.predicted_depth;
      if(!tensor?.data?.length||tensor.dims?.length<2)continue;
      const height=tensor.dims.at(-2),width=tensor.dims.at(-1),data=Float32Array.from(tensor.data),anchors=[];
      for(const p of trusted){const q=project(p.position,pose,c.face,width,height,.13);if(!q)continue;const pred=sample(data,width,height,q.x,q.y);if(Number.isFinite(pred)&&pred>1e-8)anchors.push({pred,range:q.range});}
      const fit=chooseFit(anchors);if(!fit)continue;
      maps.push({index:c.index,face:c.face,pose,width,height,data,fit,canvas});
    }
    if(maps.length<2)return{...disabled,attempted:true,reason:'depth-alignment-rejected',validFaces:maps.length};

    const candidates=[];
    for(let mi=0;mi<maps.length;mi++){
      const m=maps[mi],stride=Math.max(18,Math.round(m.width/18)),margin=Math.max(16,Math.round(m.width*.08));
      for(let y=margin;y<m.height-margin;y+=stride)for(let x=margin;x<m.width-margin;x+=stride){
        const pred=sample(m.data,m.width,m.height,x,y),range=applyFit(m.fit,pred);if(!Number.isFinite(range)||range<=0)continue;
        const dx=Math.abs(applyFit(m.fit,sample(m.data,m.width,m.height,x+4,y))-applyFit(m.fit,sample(m.data,m.width,m.height,x-4,y))),dy=Math.abs(applyFit(m.fit,sample(m.data,m.width,m.height,x,y+4))-applyFit(m.fit,sample(m.data,m.width,m.height,x,y-4)));
        if(Math.max(dx,dy)/Math.max(.05,range)>.20)continue;
        const ray=rayFromPixel(m.pose,m.face,x,y,m.width,m.height),point=add(m.pose.position,scale(ray,range));let bestConsistency=Infinity,confirm=0;
        for(const other of maps){if(other.index===m.index)continue;const q=project(point,other.pose,other.face,other.width,other.height,.10);if(!q)continue;const pr=applyFit(other.fit,sample(other.data,other.width,other.height,q.x,q.y));if(!(pr>0))continue;const rel=Math.abs(pr-q.range)/Math.max(.05,q.range);bestConsistency=Math.min(bestConsistency,rel);if(rel<=CROSS_VIEW_REL)confirm++;}
        if(!confirm)continue;
        const color=rgbaAt(m.canvas,x/m.width*m.canvas.width,y/m.height*m.canvas.height),score=(1/(.05+m.fit.medianRel))*(1/(.05+bestConsistency));
        candidates.push({position:point,color,score,source:'depth-prior',depthConsistency:bestConsistency,depthFace:m.face.name,depthIndex:m.index});
      }
      onProgress(.65+.30*(mi+1)/maps.length,`depth整合点を相互検証しています ${mi+1}/${maps.length}`);await new Promise(r=>setTimeout(r,0));
    }
    const baseline=median(selected.slice(1).map((i,k)=>norm(sub(poses[i].position,poses[selected[k]].position))).filter(x=>x>1e-6))||1,points=dedupe(candidates,Math.max(1e-5,baseline*.018));
    return{points,attempted:true,reason:points.length?'accepted':'no-cross-view-inliers',validFaces:maps.length,model:DEPTH_MODEL,medianAlignment:median(maps.map(m=>m.fit.medianRel)),p90Alignment:quantile(maps.map(m=>m.fit.p90Rel),.90)};
  }catch(error){
    return{...disabled,attempted:true,reason:`depth-runtime:${error?.message||error}`};
  }finally{
    try{await pipe?.dispose?.();}catch{}
  }
}
