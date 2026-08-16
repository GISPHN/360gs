from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


p = Path('training.js')
s = p.read_text()

if not s.startswith("import { buildTriangulatedGeometrySeeds }"):
    s = "import { buildTriangulatedGeometrySeeds } from './geometry-seed.js?v=0.3c18';\n\n" + s

insert_at = s.index('async function trSeek')
helpers = r'''function trDot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function trNorm(v){return Math.hypot(v[0],v[1],v[2]);}
function trUnit(v){const n=trNorm(v)||1;return[v[0]/n,v[1]/n,v[2]/n];}
function trDet(m){return m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);}
function trAngleDeg(a,b){return Math.acos(Math.max(-1,Math.min(1,trDot(trUnit(a),trUnit(b)))))*180/Math.PI;}
function trSub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function trGeometryPreflight(poses){
  const expected={front:[0,0,1],right:[1,0,0],back:[0,0,-1],left:[-1,0,0],up:[0,1,0],down:[0,-1,0]};
  let maxFaceDeg=0,maxCenterError=0,maxRayDeg=0,maxOrtho=0,minDet=Infinity,maxDet=-Infinity,checked=0;
  for(const face of TR_FACES){
    const actual=trMv(trFaceRot(face),[0,0,1]);
    maxFaceDeg=Math.max(maxFaceDeg,trAngleDeg(actual,expected[face.name]));
  }
  for(const pose of poses||[]){
    if(!pose?.position?.every(Number.isFinite)||!Array.isArray(pose.cameraToWorld)||pose.cameraToWorld.length!==9)continue;
    const P=pose.cameraToWorld,Pt=trT(P),I=trMul(Pt,P),det=trDet(P);
    minDet=Math.min(minDet,det);maxDet=Math.max(maxDet,det);
    maxOrtho=Math.max(maxOrtho,...I.map((v,i)=>Math.abs(v-(i%4===0?1:0))));
    for(const face of TR_FACES){
      const faceR=trFaceRot(face),Rcw=trReflectYMat(trMul(P,faceR)),R=trT(Rcw),C=trReflectY3(pose.position),t=trMv(R,C).map(v=>-v),Crecover=trMv(Rcw,t).map(v=>-v);
      maxCenterError=Math.max(maxCenterError,trNorm(trSub(Crecover,C)));
      const colmapRay=trMv(Rcw,[0,0,1]),sourceRay=trReflectY3(trMv(P,trMv(faceR,[0,0,1])));
      maxRayDeg=Math.max(maxRayDeg,trAngleDeg(colmapRay,sourceRay));
      checked++;
    }
  }
  const ok=checked>0&&maxFaceDeg<.001&&maxRayDeg<.001&&maxCenterError<1e-6&&maxOrtho<.02&&minDet>.90&&maxDet<1.10;
  return{ok,checked,maxFaceDeg,maxRayDeg,maxCenterError,maxOrtho,minDet,maxDet};
}

'''
s = s[:insert_at] + helpers + s[insert_at:]

start = s.index('function trInitPly(')
end = s.index('async function trDir', start)
new_init = r'''function trTrustedSpacing(points,sceneScale){
  const sample=points.slice(0,Math.min(points.length,700)),nn=[];
  for(let i=0;i<sample.length;i++){
    let best=Infinity;const a=sample[i].position;
    for(let j=0;j<sample.length;j++)if(i!==j){const b=sample[j].position,d=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);if(d>1e-8&&d<best)best=d;}
    if(Number.isFinite(best))nn.push(best);
  }
  const q=trSeedQuantile(nn,.5);
  return Number.isFinite(q)&&q>1e-6?q:Math.max(sceneScale*.025,1e-4);
}
function trInitPly(tracks,poses,target,pairSeeds=[]){
  const src=(tracks||[]).filter(t=>t.position?.every(Number.isFinite));
  const stereo=(pairSeeds||[]).filter(t=>t.position?.every(Number.isFinite));
  const cams=(poses||[]).filter(p=>p.position?.every(Number.isFinite)&&Array.isArray(p.cameraToWorld)&&p.cameraToWorld.length===9);
  const trusted=[...stereo.map(t=>({position:t.position,color:t.color||[150,150,150],score:t.score||1,source:'stereo'})),...src.map(t=>({position:t.position,color:[150,150,150],score:1,source:'ba'}))];
  if(trusted.length<24)throw new Error(`幾何学的に確定できた初期3D点が不足しています（${trusted.length}点）。ランダム深度seedは使用せず、安全のため3DGS学習を停止しました。`);
  trusted.sort((a,b)=>(b.score||0)-(a.score||0));
  const count=Math.max(10000,target||trSeedBudget()),rng=trSeedRng((trusted.length*2654435761+cams.length*40503+count)>>>0);
  const sceneScale=trSeedScale(trusted,cams),spacing=trTrustedSpacing(trusted,sceneScale),points=[];
  for(let i=0;i<count;i++){
    const base=trusted[i%trusted.length],p=trReflectY3(base.position),exact=i<trusted.length;
    let x=p[0],y=p[1],z=p[2];
    if(!exact){
      const r=spacing*(.010+.040*rng()),cz=rng()*2-1,a=rng()*Math.PI*2,ss=Math.sqrt(Math.max(0,1-cz*cz));
      x+=r*ss*Math.cos(a);y+=r*cz;z+=r*ss*Math.sin(a);
    }
    const c=base.color||[150,150,150];points.push([x,y,z,Math.max(0,Math.min(255,c[0]|0)),Math.max(0,Math.min(255,c[1]|0)),Math.max(0,Math.min(255,c[2]|0))]);
  }
  const h=`ply\nformat ascii 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body=points.map(v=>`${v[0]} ${v[1]} ${v[2]} ${v[3]} ${v[4]} ${v[5]}`).join('\n');
  return{blob:new Blob([h,body,'\n'],{type:'application/octet-stream'}),count:points.length,anchors:trusted.length,sourceTracks:src.length,stereoPoints:stereo.length,sceneScale,spacing,randomDepthSeeds:0};
}

'''
s = s[:start] + new_init + s[end:]

old = """  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);\n  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget());\n  await trWrite(dir,'init.ply',seed.blob);\n"""
new = """  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);\n  const preflight=trGeometryPreflight(selectedPoses);\n  trLog(`Geometry preflight: ${preflight.checked} camera-face tests / face ${preflight.maxFaceDeg.toFixed(6)} deg / ray ${preflight.maxRayDeg.toFixed(6)} deg / camera-center ${preflight.maxCenterError.toExponential(2)} / ortho ${preflight.maxOrtho.toExponential(2)} / det ${preflight.minDet.toFixed(5)}..${preflight.maxDet.toFixed(5)}`);\n  if(!preflight.ok)throw new Error('6面cubemapとCOLMAP/Brushカメラ外部パラメータの自己検査に失敗しました。誤った幾何で学習せず安全に停止しました。');\n  trProgress(2.2,'ERP対応点から幾何学的な初期3D点を追加しています');\n  const stereo=await buildTriangulatedGeometrySeeds(trVideo,item,sel,(f,text)=>trProgress(2.2+2.3*f,text));\n  trLog(`Geometry seeds: ${stereo.points.length.toLocaleString()} accepted 2-view points / ${stereo.acceptedPairs}/${stereo.pairs} useful pairs / ${stereo.rawMatches.toLocaleString()} raw matches / median parallax ${Number(stereo.medianParallaxDeg||0).toFixed(2)} deg / median reprojection ${Number(stereo.medianReprojDeg||0).toFixed(2)} deg`);\n  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget(),stereo.points);\n  trLog(`Initial geometry cloud: ${seed.sourceTracks} BA tracks + ${seed.stereoPoints} 2-view points -> ${seed.count.toLocaleString()} surface-anchored seeds / spacing ${seed.spacing.toFixed(4)} / random-depth seeds ${seed.randomDepthSeeds}`);\n  await trWrite(dir,'init.ply',seed.blob);\n"""
s = replace_once(s, old, new, 'dataset geometry seed construction')

old_return = "return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,seedScale:seed.sceneScale};"
new_return = "return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight};"
s = replace_once(s, old_return, new_return, 'dataset return metadata')

s = s.replace("高品質・6面cubemap投影比較", "高品質・幾何整合seed＋6面cubemap")
s = s.replace("品質優先・6面cubemap投影比較", "品質優先・幾何整合seed＋6面cubemap")
s = s.replace("省メモリ・6面cubemap投影比較", "省メモリ・幾何整合seed＋6面cubemap")
s = s.replace('v0.3c17', 'v0.3c18').replace('v=0.3c17', 'v=0.3c18')
p.write_text(s)

for name in ['index.html','video.html']:
    q=Path(name);t=q.read_text().replace('v0.3c17','v0.3c18').replace('v=0.3c17','v=0.3c18');q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c18\n'
    'Geometry-consistent ERP triangulated initialization\n'
    'Cubemap/COLMAP camera self-test runs before Brush training\n'
    'Adjacent and one-skip ERP frame pairs add guarded 2-view triangulated points after BA camera poses are fixed\n'
    'Positive depth, parallax, ray-gap and angular reprojection checks reject weak points\n'
    'Random frustum/depth initialization is removed; init.ply contains only BA/SfM and accepted 2-view geometry neighborhoods\n'
    'Brush training, SH degree 1, six-face cubemap images and bounded GPU growth remain unchanged from v0.3c17\n'
    'Build date: 2026-08-17\n'
)
