from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# ---- geometry-seed.js: retain independent spherical observations ----
p = Path('geometry-seed.js')
s = p.read_text()
s = replace_once(
    s,
    "  return{angleDeg:bestAngle,correlation:corr};\n",
    "  return{angleDeg:bestAngle,correlation:corr,frameIndex:candidateIndex,bearing:[...best.bearing],weight:clamp(.55+.45*Math.max(0,corr),.25,1.25)};\n",
    'third-view feature payload',
)
s = replace_once(
    s,
    "  let support=0,bestAngle=Infinity;\n  for(const i of near){const s=nearestFeatureSupport(point,sourceDescriptor,i,captured,poses);if(s){support++;bestAngle=Math.min(bestAngle,s.angleDeg);}}\n  return{support,bestAngle:Number.isFinite(bestAngle)?bestAngle:null};\n",
    "  let support=0,bestAngle=Infinity;const observations=[];\n  for(const i of near){const s=nearestFeatureSupport(point,sourceDescriptor,i,captured,poses);if(s){support++;bestAngle=Math.min(bestAngle,s.angleDeg);observations.push({frameIndex:s.frameIndex,bearing:s.bearing,weight:s.weight});}}\n  return{support,bestAngle:Number.isFinite(bestAngle)?bestAngle:null,observations};\n",
    'third-view observation list',
)
s = replace_once(
    s,
    "      points.push({position:tri.point,color,score,parallaxDeg:parallax,reprojDeg:reproj,epipolarDeg:m.epipolarDeg,supportViews:2+third.support,pair:[ia,ib],source:'stereo'});accepted++;acceptedRaw++;\n",
    "      const observations=[\n        {frameIndex:ia,bearing:[...m.left.bearing],weight:clamp(.55+.75*(m.confidence||.1),.3,1.4)},\n        {frameIndex:ib,bearing:[...m.right.bearing],weight:clamp(.55+.75*(m.confidence||.1),.3,1.4)},\n        ...(third.observations||[]),\n      ];\n      points.push({position:tri.point,color,score,parallaxDeg:parallax,reprojDeg:reproj,epipolarDeg:m.epipolarDeg,supportViews:observations.length,pair:[ia,ib],observations,source:'stereo'});accepted++;acceptedRaw++;\n",
    'accepted point observations',
)
s = s.replace("./spherical.js?v=0.3c19", "./spherical.js?v=0.3c20")
p.write_text(s)


# ---- pose-refine.js: also re-triangulate the original BA anchors after pose update ----
p = Path('pose-refine.js')
s = p.read_text()
insert = """
function retriangulateBATracks(baTracks,poses){
  return (baTracks||[]).map(t=>{
    const obs=(t.observations||[]).filter(o=>Number.isInteger(o.frameIndex)&&Array.isArray(o.bearing)&&o.bearing.length===3).map(o=>({frameIndex:o.frameIndex,bearing:normalize(o.bearing),weight:1}));
    if(obs.length<3)return t;
    const position=solvePoint(obs,poses);
    return position?{...t,position:[...position]}:t;
  });
}
"""
s = replace_once(s, "export function refinePosesFromTriangulatedPoints(inputPoses,points,selectedIndices){\n", insert + "\nexport function refinePosesFromTriangulatedPoints(inputPoses,points,selectedIndices,baTracks=[]){\n", 'pose refine signature')
s = s.replace("poses:inputPoses,points,usedTracks:0,usedObservations:0", "poses:inputPoses,points,baTracks,usedTracks:0,usedObservations:0")
s = s.replace("poses:inputPoses,points,usedTracks:tracks.length,usedObservations:obs", "poses:inputPoses,points,baTracks,usedTracks:tracks.length,usedObservations:obs")
s = s.replace("poses:inputPoses,points,initial,final:best,iterations", "poses:inputPoses,points,baTracks,initial,final:best,iterations")
s = replace_once(
    s,
    "  const bySource=new Map(bestTracks.map(t=>[t.source,t.position]));const refinedPoints=(points||[]).map(p=>bySource.has(p)?{...p,position:[...bySource.get(p)]}:p);\n  return{accepted:true,reason:'独立した3視点以上の球面2D–3D対応で角度誤差が改善したため、再調整したcamera poseを採用します。',poses:bestPoses,points:refinedPoints,initial,final:best,iterations,usedTracks:tracks.length,usedObservations:obs,fixed:[...fixed],motion,baseline,medianImprovement:improvement,p90Improvement};\n",
    "  const bySource=new Map(bestTracks.map(t=>[t.source,t.position]));const refinedPoints=(points||[]).map(p=>bySource.has(p)?{...p,position:[...bySource.get(p)]}:p),refinedBA=retriangulateBATracks(baTracks,bestPoses);\n  return{accepted:true,reason:'独立した3視点以上の球面2D–3D対応で角度誤差が改善したため、再調整したcamera poseを採用します。',poses:bestPoses,points:refinedPoints,baTracks:refinedBA,initial,final:best,iterations,usedTracks:tracks.length,usedObservations:obs,fixed:[...fixed],motion,baseline,medianImprovement:improvement,p90Improvement};\n",
    'accepted refined BA tracks',
)
p.write_text(s)


# ---- training.js: feed c19 multi-view correspondences back into camera poses ----
p = Path('training.js')
s = p.read_text()
s = replace_once(
    s,
    "import { buildTriangulatedGeometrySeeds } from './geometry-seed.js?v=0.3c19';\nimport { buildGuardedDepthPriorSeeds } from './depth-prior.js?v=0.3c19';\n",
    "import { buildTriangulatedGeometrySeeds } from './geometry-seed.js?v=0.3c20';\nimport { buildGuardedDepthPriorSeeds } from './depth-prior.js?v=0.3c20';\nimport { refinePosesFromTriangulatedPoints } from './pose-refine.js?v=0.3c20';\n",
    'training imports',
)
old = """  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);
  const preflight=trGeometryPreflight(selectedPoses);
  trLog(`Geometry preflight: ${preflight.checked} camera-face tests / face ${preflight.maxFaceDeg.toFixed(6)} deg / ray ${preflight.maxRayDeg.toFixed(6)} deg / camera-center ${preflight.maxCenterError.toExponential(2)} / ortho ${preflight.maxOrtho.toExponential(2)} / det ${preflight.minDet.toFixed(5)}..${preflight.maxDet.toFixed(5)}`);
  if(!preflight.ok)throw new Error('6面cubemapとCOLMAP/Brushカメラ外部パラメータの自己検査に失敗しました。誤った幾何で学習せず安全に停止しました。');
  trProgress(2.0,'pose既知の球面epipolar制約でERP対応点を高密度化しています');
  const stereo=await buildTriangulatedGeometrySeeds(trVideo,item,sel,(f,text)=>trProgress(2.0+2.0*f,text));
  trLog(`Dense geometry: ${stereo.points.length.toLocaleString()} accepted points / ${stereo.multiViewPoints||0} with >=3-view support / ${stereo.acceptedPairs}/${stereo.pairs} useful pairs / ${stereo.featureCount||0} ERP features / median epipolar ${Number(stereo.medianEpipolarDeg||0).toFixed(2)} deg / reprojection ${Number(stereo.medianReprojDeg||0).toFixed(2)} deg`);
  const baseTrusted=[...(item.optimization.tracks||[]).filter(t=>t.position?.every(Number.isFinite)).map(t=>({position:t.position,color:[150,150,150],source:'ba'})),...stereo.points];
"""
new = """  const originalSelectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);
  const preflight=trGeometryPreflight(originalSelectedPoses);
  trLog(`Geometry preflight: ${preflight.checked} camera-face tests / face ${preflight.maxFaceDeg.toFixed(6)} deg / ray ${preflight.maxRayDeg.toFixed(6)} deg / camera-center ${preflight.maxCenterError.toExponential(2)} / ortho ${preflight.maxOrtho.toExponential(2)} / det ${preflight.minDet.toFixed(5)}..${preflight.maxDet.toFixed(5)}`);
  if(!preflight.ok)throw new Error('6面cubemapとCOLMAP/Brushカメラ外部パラメータの自己検査に失敗しました。誤った幾何で学習せず安全に停止しました。');
  trProgress(2.0,'pose既知の球面epipolar制約でERP対応点を高密度化しています');
  const stereoInitial=await buildTriangulatedGeometrySeeds(trVideo,item,sel,(f,text)=>trProgress(2.0+1.7*f,text));
  trLog(`Dense geometry: ${stereoInitial.points.length.toLocaleString()} accepted points / ${stereoInitial.multiViewPoints||0} with >=3-view support / ${stereoInitial.acceptedPairs}/${stereoInitial.pairs} useful pairs / ${stereoInitial.featureCount||0} ERP features / median epipolar ${Number(stereoInitial.medianEpipolarDeg||0).toFixed(2)} deg / reprojection ${Number(stereoInitial.medianReprojDeg||0).toFixed(2)} deg`);
  trProgress(3.75,'独立した3視点以上の球面2D–3D対応でcamera poseを再調整しています');
  const poseRefinement=refinePosesFromTriangulatedPoints(item.optimization.poses,stereoInitial.points,sel,item.optimization.tracks||[]);
  const workingPoses=poseRefinement.accepted?poseRefinement.poses:item.optimization.poses;
  const workingTracks=poseRefinement.accepted&&Array.isArray(poseRefinement.baTracks)?poseRefinement.baTracks:(item.optimization.tracks||[]);
  const stereo={...stereoInitial,points:poseRefinement.accepted?poseRefinement.points:stereoInitial.points};
  const workingItem={...item,optimization:{...item.optimization,poses:workingPoses,tracks:workingTracks}};
  const selectedPoses=sel.map(fi=>workingPoses[fi]).filter(Boolean);
  const pi=poseRefinement.initial,pf=poseRefinement.final,pm=poseRefinement.motion;
  trLog(`Post-triangulation pose refinement: ${poseRefinement.accepted?'accepted':'kept c19 poses'} / ${poseRefinement.usedTracks||0} multi-view points / ${poseRefinement.usedObservations||0} observations / ${poseRefinement.reason}`);
  if(pi&&pf)trLog(`Pose angular residual: median ${pi.medianDeg.toFixed(3)} -> ${pf.medianDeg.toFixed(3)} deg / p90 ${pi.p90Deg.toFixed(3)} -> ${pf.p90Deg.toFixed(3)} / RMS ${pi.rmsDeg.toFixed(3)} -> ${pf.rmsDeg.toFixed(3)}${pm?` / motion p90 ${pm.p90RotationDeg.toFixed(3)} deg, ${(pm.p90Translation/Math.max(poseRefinement.baseline||1,1e-8)*100).toFixed(1)}% baseline`:''}`);
  const baseTrusted=[...workingTracks.filter(t=>t.position?.every(Number.isFinite)).map(t=>({position:t.position,color:[150,150,150],source:'ba'})),...stereo.points];
"""
s = replace_once(s, old, new, 'post triangulation pose refinement block')
s = replace_once(s, "  const depth=await buildGuardedDepthPriorSeeds({item,selectedIndices:sel,trustedPoints:baseTrusted,faces:TR_FACES,renderFace:renderDepthFace,onProgress:(f,text)=>trProgress(4.0+1.6*f,text)});\n", "  const depth=await buildGuardedDepthPriorSeeds({item:workingItem,selectedIndices:sel,trustedPoints:baseTrusted,faces:TR_FACES,renderFace:renderDepthFace,onProgress:(f,text)=>trProgress(4.0+1.6*f,text)});\n", 'depth uses refined poses')
s = replace_once(s, "  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget(),stereo.points,depth.points);\n", "  const seed=trInitPly(workingTracks,selectedPoses,trSeedBudget(),stereo.points,depth.points);\n", 'seed uses refined tracks')
s = replace_once(s, "    const fi=sel[o],pose=item.optimization.poses[fi],tm=item.source.frames[fi].time;\n", "    const fi=sel[o],pose=workingPoses[fi],tm=item.source.frames[fi].time;\n", 'Brush camera uses refined pose')
s = replace_once(
    s,
    "  return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,depthPoints:seed.depthPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight,depthPrior:depth};\n",
    "  return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,depthPoints:seed.depthPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight,depthPrior:depth,poseRefinement,refinedPoses:workingPoses};\n",
    'dataset pose diagnostics',
)

# Diagnostics: c19 output showed p90 anisotropy ~44x, so make that visible.
s = replace_once(
    s,
    "  if(d.rel90>.12||d.rel99>.35)d.verdict='大きなGaussianが多く、ぼけの主因になっている可能性があります。';\n  else if(d.opacity50<.04)d.verdict='Gaussianの透明度が低く、復元が薄くなっている可能性があります。';\n",
    "  if(d.ratio90>25)d.verdict=`Gaussianの異方性が高く（p90 ${d.ratio90.toFixed(1)}倍）、不正確な幾何を細長いGaussianで補償している可能性があります。`;\n  else if(d.rel90>.12||d.rel99>.35)d.verdict='大きなGaussianが多く、ぼけの主因になっている可能性があります。';\n  else if(d.opacity50<.04)d.verdict='Gaussianの透明度が低く、復元が薄くなっている可能性があります。';\n",
    'anisotropy diagnostic',
)

# Add a dedicated pose/depth diagnostic card to the result.
marker = "function trFitInterpretation(trainEval,holdout){\n"
insert = """function trRenderGeometryDiagnostics(res,ds){
  if(!res||!ds)return;let e=res.querySelector('#train-result-geometry');
  if(!e){e=document.createElement('div');e.id='train-result-geometry';e.className='train-result-meta';res.querySelector('#train-result-meta')?.insertAdjacentElement('afterend',e);}
  const pr=ds.poseRefinement||{},a=pr.initial,b=pr.final,m=pr.motion,depth=ds.depthPrior||{};
  const f=v=>Number.isFinite(v)?v.toFixed(3):'—';
  const poseLine=a&&b?`角度誤差 中央値 ${f(a.medianDeg)}° → ${f(b.medianDeg)}° / p90 ${f(a.p90Deg)}° → ${f(b.p90Deg)}° / RMS ${f(a.rmsDeg)}° → ${f(b.rmsDeg)}°`:'角度誤差: 評価対象不足';
  const motion=m?`camera移動 p90: ${f(m.p90RotationDeg)}° / ${Number.isFinite(m.p90Translation)&&Number.isFinite(pr.baseline)?(m.p90Translation/Math.max(pr.baseline,1e-8)*100).toFixed(1):'—'}% baseline`:'';
  e.innerHTML=`<strong>球面幾何・camera pose診断</strong><br>post-triangulation pose refinement: ${pr.accepted?'採用':'c19姿勢を維持'} / ${pr.usedTracks||0}点・${pr.usedObservations||0}観測<br>${poseLine}${motion?`<br>${motion}`:''}<br>depth prior: ${ds.depthPoints||0}点 / ${depth.reason||'未実行'}<br><span>${pr.reason||''}</span>`;
}
"""
s = replace_once(s, marker, insert + marker, 'geometry result diagnostics')
s = replace_once(s, "function trRepresentativeView(item){const poses=item?.optimization?.poses||[];", "function trRepresentativeView(item,posesOverride=null){const poses=posesOverride||item?.optimization?.poses||[];", 'representative view pose override')

# Result wiring.
s = replace_once(s, "    ex.view=trRepresentativeView(item);trResultView=ex.view;\n", "    ex.view=trRepresentativeView(item,ds.refinedPoses||null);trResultView=ex.view;\n", 'viewer refined pose')
s = replace_once(s, "    trRenderGaussianDiagnostics(res,ex.diagnostics);\n    trRenderFitEvaluation(res,trLastTrainEval,trLastEval,trEvalHistory);\n", "    trRenderGeometryDiagnostics(res,ds);\n    trRenderGaussianDiagnostics(res,ex.diagnostics);\n    trRenderFitEvaluation(res,trLastTrainEval,trLastEval,trEvalHistory);\n", 'render pose diagnostics')
s = replace_once(
    s,
    "    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id,geometrySeed:{total:ds.seedCount,anchors:ds.seedAnchors,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,depthPoints:ds.depthPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight,depthPrior:ds.depthPrior}};\n",
    "    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id,geometrySeed:{total:ds.seedCount,anchors:ds.seedAnchors,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,depthPoints:ds.depthPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight,depthPrior:ds.depthPrior,poseRefinement:ds.poseRefinement}};\n",
    'result pose diagnostics object',
)

# Visible labels and cache keys.
s = s.replace('高品質・高密度球面幾何＋depth整合', '高品質・球面幾何＋post-pose再調整')
s = s.replace('品質優先・高密度球面幾何＋depth整合', '品質優先・球面幾何＋post-pose再調整')
s = s.replace('省メモリ・高密度球面幾何', '省メモリ・球面幾何＋post-pose再調整')
s = s.replace('v0.3c19', 'v0.3c20').replace('v=0.3c19', 'v=0.3c20')
p.write_text(s)

for name in ['index.html','video.html','README.md']:
    q=Path(name)
    if q.exists():
        t=q.read_text().replace('v0.3c19','v0.3c20').replace('v=0.3c19','v=0.3c20')
        q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c20\n'
    'Post-triangulation spherical 2D-3D camera pose refinement\n'
    'c19 dense ERP geometry is retained, but accepted >=3-view correspondences are fed back into a conservative pose-only / point re-triangulation loop before Brush training\n'
    'Two reference cameras preserve gauge; rotation and translation updates are capped per iteration and globally\n'
    'Pose updates are accepted only when robust median/p90/RMS angular metrics improve; otherwise all c19 poses are restored\n'
    'Original BA anchors are re-triangulated only after an accepted pose update\n'
    'Gaussian anisotropy p90 above 25x is now surfaced as a geometry-compensation warning\n'
    'Brush training remains six-face 90 degree cubemap, SH degree 1, and browser-safe GPU-only growth so c20 isolates pose consistency\n'
    'Build date: 2026-08-17\n'
)
