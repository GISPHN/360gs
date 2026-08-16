from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


p = Path('training.js')
s = p.read_text()

s = replace_once(
    s,
    "import { buildTriangulatedGeometrySeeds } from './geometry-seed.js?v=0.3c18';",
    "import { buildTriangulatedGeometrySeeds } from './geometry-seed.js?v=0.3c19';\nimport { buildGuardedDepthPriorSeeds } from './depth-prior.js?v=0.3c19';",
    'c19 imports',
)

# Replace c18 sparse-anchor replication with surface-aware local seeding.
start = s.index('function trTrustedSpacing(')
end = s.index('async function trDir', start)
new_init = r'''function trTrustedSpacing(points,sceneScale){
  const sample=points.slice(0,Math.min(points.length,900)),nn=[];
  for(let i=0;i<sample.length;i++){
    let best=Infinity;const a=sample[i].position;
    for(let j=0;j<sample.length;j++)if(i!==j){const b=sample[j].position,d=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);if(d>1e-8&&d<best)best=d;}
    if(Number.isFinite(best))nn.push(best);
  }
  const q=trSeedQuantile(nn,.5);
  return Number.isFinite(q)&&q>1e-6?q:Math.max(sceneScale*.02,1e-4);
}
function trDedupeTrusted(points,cell,maxCount=4200){
  const map=new Map(),out=[];
  const ranked=[...points].sort((a,b)=>(b.rankScore||b.score||0)-(a.rankScore||a.score||0));
  for(const p of ranked){
    const k=`${Math.round(p.position[0]/cell)}:${Math.round(p.position[1]/cell)}:${Math.round(p.position[2]/cell)}`;
    if(map.has(k))continue;map.set(k,1);out.push(p);if(out.length>=maxCount)break;
  }
  return out;
}
function trLocalSurface(points,index,fallback){
  const p=points[index].position,near=[];
  for(let j=0;j<points.length;j++)if(j!==index){const q=points[j].position,d=Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]);if(d>1e-8){near.push({j,d,v:[q[0]-p[0],q[1]-p[1],q[2]-p[2]]});}}
  near.sort((a,b)=>a.d-b.d);const first=near.slice(0,8),spacing=trSeedQuantile(first.map(x=>x.d),.45)||fallback;
  if(!first.length)return{spacing,t1:[1,0,0],t2:[0,1,0],normal:[0,0,1]};
  const unit=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const t1=unit(first[0].v);let normal=null;
  for(let k=1;k<first.length;k++){const n=cross(t1,unit(first[k].v)),nn=Math.hypot(...n);if(nn>.16){normal=n.map(x=>x/nn);break;}}
  if(!normal){const ref=Math.abs(t1[1])<.8?[0,1,0]:[1,0,0],n=cross(t1,ref),nn=Math.hypot(...n)||1;normal=n.map(x=>x/nn);}
  const t2=unit(cross(normal,t1));return{spacing,t1,t2,normal};
}
function trInitPly(tracks,poses,target,pairSeeds=[],depthSeeds=[]){
  const src=(tracks||[]).filter(t=>t.position?.every(Number.isFinite)).map(t=>({position:t.position,color:[150,150,150],score:5,rankScore:5,source:'ba'}));
  const stereo=(pairSeeds||[]).filter(t=>t.position?.every(Number.isFinite)).map(t=>({...t,rankScore:2.5+(t.score||0),source:'stereo'}));
  const depth=(depthSeeds||[]).filter(t=>t.position?.every(Number.isFinite)).map(t=>({...t,rankScore:.8+.18*Math.min(10,t.score||0),source:'depth-prior'}));
  const cams=(poses||[]).filter(p=>p.position?.every(Number.isFinite)&&Array.isArray(p.cameraToWorld)&&p.cameraToWorld.length===9);
  const raw=[...src,...stereo,...depth],sceneScale=trSeedScale(raw,cams),dedupeCell=Math.max(sceneScale*.0016,1e-5),trusted=trDedupeTrusted(raw,dedupeCell);
  if(trusted.length<160)throw new Error(`幾何学的に検証できた初期3D点が不足しています（${trusted.length}点）。c19では疎な点を3万個へ複製せず、安全のため停止します。`);
  const globalSpacing=trTrustedSpacing(trusted,sceneScale),budget=target||trSeedBudget(),count=Math.min(budget,Math.max(6000,Math.min(30000,trusted.length*12))),rng=trSeedRng((trusted.length*2654435761+cams.length*40503+count)>>>0),points=[],frames=new Array(trusted.length);
  const sourceCounts={ba:0,stereo:0,depth:0};for(const t of trusted){if(t.source==='ba')sourceCounts.ba++;else if(t.source==='stereo')sourceCounts.stereo++;else if(t.source==='depth-prior')sourceCounts.depth++;}
  for(let i=0;i<count;i++){
    const bi=i%trusted.length,base=trusted[bi],p0=trReflectY3(base.position),exact=i<trusted.length;let x=p0[0],y=p0[1],z=p0[2];
    if(!exact){
      const f=frames[bi]||(frames[bi]=trLocalSurface(trusted,bi,globalSpacing)),r=f.spacing*(.035+.24*Math.sqrt(rng())),a=rng()*Math.PI*2,n=(rng()-.5)*f.spacing*.035;
      // Apply offsets in the source (+Y-up) geometry, then reflect once into
      // the COLMAP/Brush convention.  Most variance lies in the estimated
      // local surface tangent plane; normal jitter is deliberately small.
      const q=[base.position[0]+r*(Math.cos(a)*f.t1[0]+Math.sin(a)*f.t2[0])+n*f.normal[0],base.position[1]+r*(Math.cos(a)*f.t1[1]+Math.sin(a)*f.t2[1])+n*f.normal[1],base.position[2]+r*(Math.cos(a)*f.t1[2]+Math.sin(a)*f.t2[2])+n*f.normal[2]],p=trReflectY3(q);x=p[0];y=p[1];z=p[2];
    }
    const c=base.color||[150,150,150];points.push([x,y,z,Math.max(0,Math.min(255,c[0]|0)),Math.max(0,Math.min(255,c[1]|0)),Math.max(0,Math.min(255,c[2]|0))]);
  }
  const h=`ply\nformat ascii 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`,body=points.map(v=>`${v[0]} ${v[1]} ${v[2]} ${v[3]} ${v[4]} ${v[5]}`).join('\n');
  return{blob:new Blob([h,body,'\n'],{type:'application/octet-stream'}),count:points.length,anchors:trusted.length,sourceTracks:sourceCounts.ba,stereoPoints:sourceCounts.stereo,depthPoints:sourceCounts.depth,sceneScale,spacing:globalSpacing,randomDepthSeeds:0};
}

'''
s = s[:start] + new_init + s[end:]

old_block = """  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);\n  const preflight=trGeometryPreflight(selectedPoses);\n  trLog(`Geometry preflight: ${preflight.checked} camera-face tests / face ${preflight.maxFaceDeg.toFixed(6)} deg / ray ${preflight.maxRayDeg.toFixed(6)} deg / camera-center ${preflight.maxCenterError.toExponential(2)} / ortho ${preflight.maxOrtho.toExponential(2)} / det ${preflight.minDet.toFixed(5)}..${preflight.maxDet.toFixed(5)}`);\n  if(!preflight.ok)throw new Error('6面cubemapとCOLMAP/Brushカメラ外部パラメータの自己検査に失敗しました。誤った幾何で学習せず安全に停止しました。');\n  trProgress(2.2,'ERP対応点から幾何学的な初期3D点を追加しています');\n  const stereo=await buildTriangulatedGeometrySeeds(trVideo,item,sel,(f,text)=>trProgress(2.2+2.3*f,text));\n  trLog(`Geometry seeds: ${stereo.points.length.toLocaleString()} accepted 2-view points / ${stereo.acceptedPairs}/${stereo.pairs} useful pairs / ${stereo.rawMatches.toLocaleString()} raw matches / median parallax ${Number(stereo.medianParallaxDeg||0).toFixed(2)} deg / median reprojection ${Number(stereo.medianReprojDeg||0).toFixed(2)} deg`);\n  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget(),stereo.points);\n  trLog(`Initial geometry cloud: ${seed.sourceTracks} BA tracks + ${seed.stereoPoints} 2-view points -> ${seed.count.toLocaleString()} surface-anchored seeds / spacing ${seed.spacing.toFixed(4)} / random-depth seeds ${seed.randomDepthSeeds}`);\n  await trWrite(dir,'init.ply',seed.blob);\n"""
new_block = """  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);\n  const preflight=trGeometryPreflight(selectedPoses);\n  trLog(`Geometry preflight: ${preflight.checked} camera-face tests / face ${preflight.maxFaceDeg.toFixed(6)} deg / ray ${preflight.maxRayDeg.toFixed(6)} deg / camera-center ${preflight.maxCenterError.toExponential(2)} / ortho ${preflight.maxOrtho.toExponential(2)} / det ${preflight.minDet.toFixed(5)}..${preflight.maxDet.toFixed(5)}`);\n  if(!preflight.ok)throw new Error('6面cubemapとCOLMAP/Brushカメラ外部パラメータの自己検査に失敗しました。誤った幾何で学習せず安全に停止しました。');\n  trProgress(2.0,'pose既知の球面epipolar制約でERP対応点を高密度化しています');\n  const stereo=await buildTriangulatedGeometrySeeds(trVideo,item,sel,(f,text)=>trProgress(2.0+2.0*f,text));\n  trLog(`Dense geometry: ${stereo.points.length.toLocaleString()} accepted points / ${stereo.multiViewPoints||0} with >=3-view support / ${stereo.acceptedPairs}/${stereo.pairs} useful pairs / ${stereo.featureCount||0} ERP features / median epipolar ${Number(stereo.medianEpipolarDeg||0).toFixed(2)} deg / reprojection ${Number(stereo.medianReprojDeg||0).toFixed(2)} deg`);\n  const baseTrusted=[...(item.optimization.tracks||[]).filter(t=>t.position?.every(Number.isFinite)).map(t=>({position:t.position,color:[150,150,150],source:'ba'})),...stereo.points];\n  let depthRenderer=null;\n  const renderDepthFace=async(fi,face,px)=>{\n    if(id!==trRunId)throw new Error('処理が更新されました。');\n    await trSeek(item.source.frames[fi].time);\n    if(!depthRenderer||depthRenderer.canvas.width!==px)depthRenderer=trRenderer(px);\n    depthRenderer.render(trVideo,face.yaw,face.pitch);\n    const out=document.createElement('canvas');out.width=px;out.height=px;const ctx=out.getContext('2d',{alpha:false});if(!ctx)throw new Error('depth prior用Canvasを作成できません。');ctx.drawImage(depthRenderer.canvas,0,0,px,px);return out;\n  };\n  const depth=await buildGuardedDepthPriorSeeds({item,selectedIndices:sel,trustedPoints:baseTrusted,faces:TR_FACES,renderFace:renderDepthFace,onProgress:(f,text)=>trProgress(4.0+1.6*f,text)});\n  trLog(`Guarded depth prior: ${depth.points.length.toLocaleString()} accepted / attempted ${depth.attempted?'yes':'no'} / valid faces ${depth.validFaces||0} / ${depth.reason}${Number.isFinite(depth.medianAlignment)?` / median align ${(depth.medianAlignment*100).toFixed(1)}%`:''}`);\n  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget(),stereo.points,depth.points);\n  trLog(`Initial geometry cloud: ${seed.anchors.toLocaleString()} trusted anchors (${seed.sourceTracks} BA + ${seed.stereoPoints} triangulated + ${seed.depthPoints} depth-consistent) -> ${seed.count.toLocaleString()} surface-aware seeds / spacing ${seed.spacing.toFixed(4)} / random-depth ${seed.randomDepthSeeds}`);\n  await trWrite(dir,'init.ply',seed.blob);\n"""
s = replace_once(s, old_block, new_block, 'c19 geometry and depth construction')

old_return = "return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight};"
new_return = "return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,depthPoints:seed.depthPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight,depthPrior:depth};"
s = replace_once(s, old_return, new_return, 'c19 dataset return')

# Dynamic initial density and a third browser-safe GPU growth event.  This is
# still far less aggressive than native PFGS360/3DGS refinement, but avoids the
# CPU readback that previously froze the browser.
start = s.index('function trPlan(size){')
end = s.index('function trShouldEarlyStop', start)
new_plan = r'''function trPlan(size,seedCount=trSeedBudget()){
  const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4;
  if(m>=12&&c>=8)return{iters:7600,minIters:5200,max:Math.max(60000,Math.ceil(seedCount*3.0)),res:Math.min(size,512),label:'高品質・高密度球面幾何＋depth整合',refineEvery:1200,growthStop:4200,growthFraction:.28,evalEvery:800,plateauDb:.15,plateauSsim:.008};
  if(m>=8&&c>=6)return{iters:6800,minIters:4800,max:Math.max(50000,Math.ceil(seedCount*3.0)),res:Math.min(size,512),label:'品質優先・高密度球面幾何＋depth整合',refineEvery:1200,growthStop:4200,growthFraction:.25,evalEvery:800,plateauDb:.15,plateauSsim:.008};
  return{iters:5200,minIters:4000,max:Math.max(36000,Math.ceil(seedCount*2.6)),res:Math.min(size,384),label:'省メモリ・高密度球面幾何',refineEvery:1400,growthStop:3000,growthFraction:.20,evalEvery:600,plateauDb:.12,plateauSsim:.006};
}
'''
s = s[:start] + new_plan + s[end:]

# Build geometry (including the optional depth model) before allocating Brush's
# long-lived WebGPU device so the depth pipeline can dispose its GPU resources.
old_run = """    trProgress(1,'Brush学習エンジンを初期化しています');\n    const rt=await trRuntimeReady();\n    if(id!==trRunId)return;\n    trLog('Brush WebGPU runtime ready');\n\n    trProgress(2,'Brush用の学習画像を準備しています');\n    const ds=await trBuildDataset(item,id),plan=trPlan(ds.size);\n    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px / ${ds.seedCount.toLocaleString()} hybrid seeds (${ds.sourceTracks} optimized BA/SfM tracks, ${ds.seedAnchors.toLocaleString()} track-anchored samples)`);\n"""
new_run = """    trProgress(1,'高密度な球面幾何と学習画像を準備しています');\n    const ds=await trBuildDataset(item,id),plan=trPlan(ds.size,ds.seedCount);\n    if(id!==trRunId)return;\n    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px / ${ds.seedCount.toLocaleString()} surface-aware seeds from ${ds.seedAnchors.toLocaleString()} trusted 3D anchors`);\n    trProgress(8,'Brush学習エンジンを初期化しています');\n    const rt=await trRuntimeReady();\n    if(id!==trRunId)return;\n    trLog('Brush WebGPU runtime ready');\n"""
s = replace_once(s, old_run, new_run, 'c19 depth before Brush allocation')

s = s.replace("${ds.sourceTracks} BA tracks + ${ds.stereoPoints} 2-view triangulated points / random-depth ${ds.randomDepthSeeds}", "${ds.sourceTracks} BA + ${ds.stereoPoints} pose-guided triangulated + ${ds.depthPoints||0} depth-consistent / random-depth ${ds.randomDepthSeeds}")
s = s.replace("幾何seed ${ds.seedCount.toLocaleString()}（BA ${ds.sourceTracks}点 + 2視点 ${ds.stereoPoints}点 / ランダム深度 ${ds.randomDepthSeeds}）", "surface seed ${ds.seedCount.toLocaleString()}（実3D anchor ${ds.seedAnchors.toLocaleString()}: BA ${ds.sourceTracks} + 球面三角測量 ${ds.stereoPoints} + depth整合 ${ds.depthPoints||0} / ランダム深度 ${ds.randomDepthSeeds}）")
s = s.replace("geometrySeed:{total:ds.seedCount,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight}", "geometrySeed:{total:ds.seedCount,anchors:ds.seedAnchors,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,depthPoints:ds.depthPoints||0,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight,depthPrior:ds.depthPrior}")

s = s.replace("c18ではランダム深度seedを廃止し、BA点とERP 2視点三角測量点だけに初期Gaussianを拘束しています。改善が限定的なら、次は直接ERP rasterizationとカメラ自己較正を優先して比較します。", "c19ではpose既知の球面epipolar対応、複数視点支持、実測点で較正したcross-view depth inlier、surface-aware初期化を組み合わせています。改善が限定的なら、次はcubemap学習を終了し直接ERP rasterizationとカメラ自己較正へ進みます。")

s = s.replace('v0.3c18','v0.3c19').replace('v=0.3c18','v=0.3c19')
p.write_text(s)

for name in ['index.html','video.html']:
    q=Path(name);t=q.read_text().replace('v0.3c18','v0.3c19').replace('v=0.3c18','v=0.3c19');q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c19\n'
    'Pose-guided dense spherical geometry + guarded browser depth inliers\n'
    'ERP features increased and matched under optimized-pose spherical epipolar constraints across offsets 1-3\n'
    'Triangulated points require positive depth, parallax, ray-gap, angular reprojection and multi-view or exceptionally strong two-view support\n'
    'Optional Depth Anything V2 Small q4 runs locally with Transformers.js 4.2.0 only when geometry remains sparse\n'
    'Relative depth is accepted only on faces calibrated by measured 3D anchors and confirmed from another camera position\n'
    'Sparse anchors are no longer duplicated with tiny isotropic jitter; initial Gaussians use local surface tangent neighborhoods and scale with trusted-anchor count\n'
    'Random frustum/depth initialization remains disabled; Brush still uses six-face 90 degree images and SH degree 1 for controlled evaluation\n'
    'Build date: 2026-08-17\n'
)
