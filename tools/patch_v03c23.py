from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'patch target not found: {label}')
    return text.replace(old, new, 1)


p = Path('training.js')
s = p.read_text()

s = replace_once(
    s,
    "import { refinePosesFromTriangulatedPoints } from './pose-refine.js?v=0.3c22';\n",
    "import { refinePosesFromTriangulatedPoints } from './pose-refine.js?v=0.3c23';\nimport { encodeSpzV4, buildViewerUrl, normalizeViewState } from './delivery.js?v=0.3c23';\n",
    'delivery import',
)
s = s.replace("'./geometry-seed.js?v=0.3c22'", "'./geometry-seed.js?v=0.3c23'")
s = s.replace("'./depth-prior.js?v=0.3c22'", "'./depth-prior.js?v=0.3c23'")

s = replace_once(
    s,
    "let trLastTrainEval = null;\n",
    "let trLastTrainEval = null;\nlet trPreviewUrls = [];\n",
    'preview URL storage',
)

old_actions = '<div class="train-result-actions"><button id="train-download" class="train-primary" type="button">3DGS PLYを保存</button><button id="train-show" class="train-secondary" type="button">この画面で3D表示</button></div>'
new_actions = '<div class="train-result-actions"><button id="train-download" class="train-primary" type="button">3DGS PLYを保存</button><button id="train-spz" class="train-secondary" type="button">SPZ v4を保存</button><button id="train-show" class="train-secondary" type="button">この画面で3D表示</button><button id="train-webgl" class="train-secondary" type="button">WebGLビューア</button></div>'
s = replace_once(s, old_actions, new_actions, 'result action buttons')

old_export = "async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats),viewBounds=trViewerBounds(t,o,s.numSplats,bounds),diagnostics=trGaussianDiagnostics(t,o,s.numSplats,bounds);trResultBounds=viewBounds||bounds;trLog(`Gaussian diagnostics: scale p50=${diagnostics.scale50.toFixed(4)} p90=${diagnostics.scale90.toFixed(4)} p99=${diagnostics.scale99.toFixed(4)} / radius ratios p90=${(diagnostics.rel90*100).toFixed(1)}% p99=${(diagnostics.rel99*100).toFixed(1)}% / opacity median=${(diagnostics.opacity50*100).toFixed(1)}%`);if(viewBounds)trLog(`Viewer visible bounds: ${viewBounds.count.toLocaleString()} splats / opacity floor ${(viewBounds.alphaFloor*100).toFixed(1)}% / radius ${viewBounds.radius.toFixed(3)}`);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds,viewBounds,diagnostics};}"
new_export = "async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats),viewBounds=trViewerBounds(t,o,s.numSplats,bounds),diagnostics=trGaussianDiagnostics(t,o,s.numSplats,bounds);trResultBounds=viewBounds||bounds;trLog(`Gaussian diagnostics: scale p50=${diagnostics.scale50.toFixed(4)} p90=${diagnostics.scale90.toFixed(4)} p99=${diagnostics.scale99.toFixed(4)} / radius ratios p90=${(diagnostics.rel90*100).toFixed(1)}% p99=${(diagnostics.rel99*100).toFixed(1)}% / opacity median=${(diagnostics.opacity50*100).toFixed(1)}%`);if(viewBounds)trLog(`Viewer visible bounds: ${viewBounds.count.toLocaleString()} splats / opacity floor ${(viewBounds.alphaFloor*100).toFixed(1)}% / radius ${viewBounds.radius.toFixed(3)}`);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds,viewBounds,diagnostics,spzSource:{count:s.numSplats,degree:s.shDegree,transforms:t,shCoeffs:h,rawOpacities:o}};}"
s = replace_once(s, old_export, new_export, 'SPZ source retention')

s = replace_once(
    s,
    "  const pc=await import('https://cdn.jsdelivr.net/npm/playcanvas@2.21.2/build/playcanvas.mjs');\n",
    "  const pc=await import('./vendor/playcanvas/playcanvas.mjs');\n",
    'local PlayCanvas runtime',
)

s = replace_once(
    s,
    "  const fitButton=document.createElement('button');\n  fitButton.type='button';\n  fitButton.textContent='全体を表示';\n  const help=document.createElement('span');\n",
    "  const fitButton=document.createElement('button');\n  fitButton.type='button';\n  fitButton.textContent='全体を表示';\n  const shareButton=document.createElement('button');\n  shareButton.type='button';\n  shareButton.textContent='視点設定をコピー';\n  const help=document.createElement('span');\n",
    'inline viewer share button',
)
s = replace_once(s, "  toolbar.append(captureButton,fitButton,help);\n", "  toolbar.append(captureButton,fitButton,shareButton,help);\n", 'inline toolbar append')

anchor = "  captureButton.disabled=!view;\n  captureButton.addEventListener('click',capture);\n  fitButton.addEventListener('click',fit);\n"
replacement = """  const currentViewerState=()=>normalizeViewState({
    mode,yaw,pitch,distanceRatio:distance/Math.max(rad,1e-8),fov:mode==='look'?lookFov:55,
    lookPosRatio:mode==='look'?lookPos.map(v=>v/Math.max(rad,1e-8)):undefined
  });
  shareButton.addEventListener('click',async()=>{
    const url=buildViewerUrl({name:'360gs_result.ply',state:currentViewerState(),base:location.href});
    try{await navigator.clipboard.writeText(url);trMsg('現在の視点設定をコピーしました。公開済みSPZ/PLYのURLをWebGLビューアで指定すると同じ視点を共有できます。','success');}
    catch{prompt('視点設定URLをコピーしてください',url);}
  });
  captureButton.disabled=!view;
  captureButton.addEventListener('click',capture);
  fitButton.addEventListener('click',fit);
"""
s = replace_once(s, anchor, replacement, 'inline view state serialization')

old_result = """    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,`360gs_segment_${item.source.segment.id}.ply`);
    res.querySelector('#train-show').onclick=()=>trShow(ex.blob,ex.viewBounds||ex.bounds,ex.view).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));
    trProgress(100,'3DGS生成が完了しました');
    trMsg('3DGS学習が完了しました。PLYとして保存するか、この画面で3D表示できます。','success');
    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id,geometrySeed:{total:ds.seedCount,anchors:ds.seedAnchors,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,depthPoints:ds.depthPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight,depthPrior:ds.depthPrior,poseRefinement:ds.poseRefinement}};
"""
new_result = """    const plyName=`360gs_segment_${item.source.segment.id}.ply`,spzName=`360gs_segment_${item.source.segment.id}.spz`;
    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,plyName);
    const spzButton=res.querySelector('#train-spz');
    spzButton.onclick=async()=>{
      const old=spzButton.textContent;spzButton.disabled=true;spzButton.textContent='SPZ v4変換中…';
      try{
        if(!ex.spzBlob){trMsg('SPZ v4へローカル変換しています。3DGSデータは外部へ送信しません。','success');ex.spzBlob=await encodeSpzV4(ex.spzSource,{bounds:ex.viewBounds||ex.bounds});}
        trDownload(ex.spzBlob,spzName);spzButton.textContent=`SPZ v4を保存 (${(ex.spzBlob.size/1024/1024).toFixed(2)} MB)`;
        if(window.__360gsTrainingResult)window.__360gsTrainingResult.spzBlob=ex.spzBlob;
      }catch(e){spzButton.textContent=old;trMsg(`SPZ v4変換: ${e?.message||e}`,'warning');}
      finally{spzButton.disabled=false;}
    };
    res.querySelector('#train-show').onclick=()=>trShow(ex.blob,ex.viewBounds||ex.bounds,ex.view).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));
    res.querySelector('#train-webgl').onclick=()=>{
      const u=URL.createObjectURL(ex.blob);trPreviewUrls.push(u);
      const url=buildViewerUrl({src:u,name:plyName,base:location.href});
      window.open(url,'_blank','noopener');
    };
    trProgress(100,'3DGS生成が完了しました');
    trMsg('3DGS学習が完了しました。PLYまたはSPZ v4として保存でき、WebGL 2でも表示できます。','success');
    window.__360gsTrainingResult={ready:true,blob:ex.blob,spzBlob:null,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id,geometrySeed:{total:ds.seedCount,anchors:ds.seedAnchors,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,depthPoints:ds.depthPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight,depthPrior:ds.depthPrior,poseRefinement:ds.poseRefinement}};
"""
s = replace_once(s, old_result, new_result, 'result delivery actions')

s = replace_once(
    s,
    "trVideo?.addEventListener('loadedmetadata',()=>{trRunId++;trCancelled=true;try{trTraining?.free();}catch{}trTraining=null;trRunning=false;const p=document.querySelector('#train-panel');if(p)p.hidden=true;window.__360gsTrainingResult=null;});",
    "trVideo?.addEventListener('loadedmetadata',()=>{trRunId++;trCancelled=true;try{trTraining?.free();}catch{}trTraining=null;trRunning=false;for(const u of trPreviewUrls)try{URL.revokeObjectURL(u);}catch{}trPreviewUrls=[];const p=document.querySelector('#train-panel');if(p)p.hidden=true;window.__360gsTrainingResult=null;});",
    'preview URL cleanup',
)

s = s.replace('0.3c22', '0.3c23')
p.write_text(s)

for name in ['index.html', 'video.html']:
    p = Path(name)
    p.write_text(p.read_text().replace('0.3c22', '0.3c23'))

p = Path('README.md')
x = p.read_text().replace('v0.3c22', 'v0.3c23').replace('0.3c22', '0.3c23')
if 'c23 Gauzilla-inspired delivery' not in x:
    x += '''\n\n### c23 Gauzilla-inspired delivery and viewing\n\nv0.3c23 keeps the c22 direct ERP training and effective-rank regularization unchanged. It adds browser-local SPZ v4 export, serializable camera viewpoint state, a standalone WebGL 2 PLY/SPZ viewer, and locally vendored PlayCanvas runtime/SPZ parser assets. The design is inspired by Gauzilla's browser-first renderer, compact splat delivery and explicit camera controls, while reconstruction continues to use the c22 Brush/WebGPU spherical pipeline.\n'''
p.write_text(x)

Path('BUILD_VERSION.txt').write_text('''360GS v0.3c23\nGauzilla-inspired browser delivery: SPZ v4 export, viewpoint URLs, and WebGL 2 fallback viewer\nc22 direct ERP training, spherical geometry, post-triangulation pose refinement, SH1 and effective-rank regularization are unchanged\nGenerated Brush arrays can be converted locally to official SPZ v4 using the vendored @adobe/spz 0.2.2 WebAssembly package\nSPZ conversion declares the source as RDF and lets the official encoder convert to canonical SPZ coordinates; quaternion data are reordered from Brush wxyz to SPZ xyzw\nThe standalone viewer loads PLY or SPZ v4 through PlayCanvas 2.21.2 and explicitly requests WebGL 2, so viewing does not require WebGPU\nSPZ v4 viewing uses PlayCanvas's external SPZ parser plus the vendored ZSTD WASM decoder\nCamera yaw, pitch, normalized distance, FOV and optional look position can be serialized into a URL hash and restored on load\nThe current inline result viewer can copy its viewpoint state and launch the standalone WebGL viewer for the generated PLY\nNo c22 Gaussian optimization parameter, loss weight, seed budget, camera model or evaluation split is changed in c23\nBuild date: 2026-08-21\n''')
