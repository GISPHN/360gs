from pathlib import Path
import re


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


def sub_once(text, pattern, repl, label, flags=0):
    out, count = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"regex patch target not found: {label}")
    return out


# v0.3c7: quality-focused browser update.
# 1) Hold out complete 360 source positions instead of isolated perspective images.
# 2) Seed Brush with a larger BA/SfM-informed hybrid point cloud.
# 3) Give the fixed-budget browser optimizer more iterations while keeping SH=0,
#    so this experiment isolates geometry/capacity improvements.
# Full Brush refinement is still bypassed on wasm because the previous GPU->CPU
# readback path could stall browsers for minutes.


# ---- Brush: source-position grouped evaluation split (4 perspective views per source frame) ----
p = Path('_brush/crates/brush-dataset/src/formats/mod.rs')
s = p.read_text()
old = '''fn split_eval_every(
    views: Vec<SceneView>,
    eval_split_every: Option<usize>,
) -> (Vec<SceneView>, Vec<SceneView>) {
    views.into_iter().enumerate().partition_map(|(i, v)| {
        if let Some(split) = eval_split_every
            && i % split == 0
        {
            Either::Right(v)
        } else {
            Either::Left(v)
        }
    })
}
'''
new = '''fn split_eval_every(
    views: Vec<SceneView>,
    eval_split_every: Option<usize>,
) -> (Vec<SceneView>, Vec<SceneView>) {
    views.into_iter().enumerate().partition_map(|(i, v)| {
        #[cfg(target_family = "wasm")]
        let eval = if let Some(split) = eval_split_every {
            // 360GS writes four contiguous perspective views (front/right/back/left)
            // for every original 360-degree source position. Keep all four views
            // together so evaluation measures a genuinely unseen camera position.
            let source_group = i / 4;
            let offset = split / 2;
            source_group % split == offset
        } else {
            false
        };

        #[cfg(not(target_family = "wasm"))]
        let eval = eval_split_every.is_some_and(|split| i % split == 0);

        if eval {
            Either::Right(v)
        } else {
            Either::Left(v)
        }
    })
}
'''
s = replace_once(s, old, new, 'source-position grouped eval split')
p.write_text(s)


# ---- Brush: training-fit diagnostic samples complete directional groups ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
old = '''    // Four evenly-spaced train views are enough for a diagnostic while keeping
    // browser GPU readback/render overhead bounded.
    let target = n.min(4);
    let mut indices = Vec::<usize>::new();
    for k in 0..target {
        let idx = if target <= 1 { 0 } else { k * (n - 1) / (target - 1) };
        if indices.last().copied() != Some(idx) {
            indices.push(idx);
        }
    }
'''
new = '''    // Evaluate complete four-direction groups instead of isolated images.
    // This avoids direction-specific bias in the train-fit metric.
    let mut indices = Vec::<usize>::new();
    let groups = n / 4;
    if groups > 0 {
        let target_groups = groups.min(2);
        for k in 0..target_groups {
            let g = if target_groups <= 1 { groups / 2 } else { k * (groups - 1) / (target_groups - 1) };
            for j in 0..4 {
                let idx = g * 4 + j;
                if idx < n {
                    indices.push(idx);
                }
            }
        }
    } else {
        indices.extend(0..n.min(4));
    }
'''
s = replace_once(s, old, new, 'balanced train-fit directional groups')
p.write_text(s)


# ---- 360GS frontend ----
p = Path('training.js')
s = p.read_text()

seed_helpers = r'''function trSeedBudget(){
  const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4;
  if(m>=12&&c>=8)return 30000;
  if(m>=8&&c>=6)return 24000;
  return 16000;
}
function trSeedRng(seed){let x=(seed>>>0)||0x6d2b79f5;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
function trSeedQuantile(a,q){if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p),t=p-i;return b[i]*(1-t)+b[Math.min(i+1,b.length-1)]*t;}
function trSeedScale(tracks,poses){
  const validTracks=(tracks||[]).filter(t=>t.position?.every(Number.isFinite));
  const validPoses=(poses||[]).filter(p=>p.position?.every(Number.isFinite));
  const d=[];
  for(const t of validTracks){
    let best=Infinity;
    for(const p of validPoses)best=Math.min(best,Math.hypot(t.position[0]-p.position[0],t.position[1]-p.position[1],t.position[2]-p.position[2]));
    if(Number.isFinite(best)&&best>1e-5)d.push(best);
  }
  const q=trSeedQuantile(d,.8);
  if(Number.isFinite(q)&&q>1e-4)return Math.max(.1,q*1.25);
  const nn=[];
  for(let i=0;i<validPoses.length;i++){
    let best=Infinity;
    for(let j=0;j<validPoses.length;j++)if(i!==j)best=Math.min(best,Math.hypot(validPoses[i].position[0]-validPoses[j].position[0],validPoses[i].position[1]-validPoses[j].position[1],validPoses[i].position[2]-validPoses[j].position[2]));
    if(Number.isFinite(best)&&best>1e-6)nn.push(best);
  }
  const base=trSeedQuantile(nn,.5);
  return Number.isFinite(base)?Math.max(.1,base*3):1;
}
function trInitPly(tracks,poses,target){
  const src=(tracks||[]).filter(t=>t.position?.every(Number.isFinite));
  const cams=(poses||[]).filter(p=>p.position?.every(Number.isFinite)&&Array.isArray(p.cameraToWorld)&&p.cameraToWorld.length===9);
  const count=Math.max(10000,target||trSeedBudget()),rng=trSeedRng((src.length*2654435761+cams.length*40503+count)>>>0);
  const sceneScale=trSeedScale(src,cams),points=[];
  const anchorBudget=src.length?Math.min(count,Math.max(src.length,Math.round(count*.35))):0;
  for(let i=0;i<anchorBudget;i++){
    const t=src[i%src.length],p=trReflectY3(t.position),exact=i<src.length;
    const j=exact?0:sceneScale*(.0015+.004*rng());
    const rx=(rng()*2-1)*j,ry=(rng()*2-1)*j,rz=(rng()*2-1)*j;
    points.push([p[0]+rx,p[1]+ry,p[2]+rz]);
  }
  const half=Math.tan(TR_FOV*Math.PI/360),near=Math.max(sceneScale*.04,1e-4),far=Math.max(near*2,sceneScale);
  while(points.length<count){
    if(!cams.length){
      const r=sceneScale*(.15+.85*Math.cbrt(rng())),z=rng()*2-1,a=rng()*Math.PI*2,s=Math.sqrt(Math.max(0,1-z*z));
      points.push([r*s*Math.cos(a),r*z,r*s*Math.sin(a)]);
      continue;
    }
    const pose=cams[Math.floor(rng()*cams.length)],yaw=TR_YAWS[Math.floor(rng()*TR_YAWS.length)];
    const dx=(rng()*2-1)*half,dy=(rng()*2-1)*half,local=[dx,dy,1];
    const R=trMul(pose.cameraToWorld,trYaw(yaw)),v=trMv(R,local),n=Math.hypot(v[0],v[1],v[2])||1;
    const depth=Math.exp(Math.log(near)+rng()*(Math.log(far)-Math.log(near)));
    const world=[pose.position[0]+v[0]/n*depth,pose.position[1]+v[1]/n*depth,pose.position[2]+v[2]/n*depth];
    points.push(trReflectY3(world));
  }
  const h=`ply\nformat ascii 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body=points.map(v=>`${v[0]} ${v[1]} ${v[2]} 150 150 150`).join('\n');
  return{blob:new Blob([h,body,'\n'],{type:'application/octet-stream'}),count:points.length,anchors:anchorBudget,sourceTracks:src.length,sceneScale};
}
'''

s = sub_once(
    s,
    r'function trInitPly\(tracks\)\{.*?\}\nasync function trDir',
    seed_helpers + '\nasync function trDir',
    'hybrid BA/SfM seed helpers',
    re.S,
)

new_build = r'''async function trBuildDataset(item,id){
  if(!navigator.storage?.getDirectory)throw new Error('ブラウザ内の一時学習領域を利用できません。Chrome / Edgeを使用してください。');
  const root=await navigator.storage.getDirectory(),base=await trDir(root,'360gs-brush'),dn=`segment-${item.source.segment.id}`;
  try{await base.removeEntry(dn,{recursive:true});}catch{}
  const dir=await trDir(base,dn),sel=trSelect(Math.min(item.optimization.poses.length,item.source.frames.length));
  const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,rr=trRenderer(size),focal=(size/2)/Math.tan(TR_FOV*Math.PI/360);
  await trWrite(dir,'sparse/0/cameras.txt',`# CAMERA_ID MODEL WIDTH HEIGHT PARAMS\n1 PINHOLE ${size} ${size} ${focal} ${focal} ${size/2} ${size/2}\n`);
  await trWrite(dir,'sparse/0/points3D.txt','# 360GS uses root init.ply for BA/SfM-informed browser initialization.\n');
  const selectedPoses=sel.map(fi=>item.optimization.poses[fi]).filter(Boolean);
  const seed=trInitPly(item.optimization.tracks||[],selectedPoses,trSeedBudget());
  await trWrite(dir,'init.ply',seed.blob);
  const lines=['# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME'];let iid=1,made=0;
  for(let o=0;o<sel.length;o++){
    if(id!==trRunId)throw new Error('処理が更新されました。');
    const fi=sel[o],pose=item.optimization.poses[fi],tm=item.source.frames[fi].time;
    await trSeek(tm);
    for(let k=0;k<4;k++){
      rr.render(trVideo,TR_YAWS[k]);
      const blob=await trJpeg(rr.canvas),name=`f${String(o).padStart(3,'0')}_${TR_NAMES[k]}.jpg`;
      await trWrite(dir,`images/${name}`,blob);
      const Rcw=trReflectYMat(trMul(pose.cameraToWorld,trYaw(TR_YAWS[k]))),C=trReflectY3(pose.position),R=trT(Rcw),pv=trMv(R,C),q=trQuat(R);
      lines.push(`${iid} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${-pv[0]} ${-pv[1]} ${-pv[2]} 1 ${name}`,'');
      iid++;made++;trProgress(2+8*made/(sel.length*4),`Brush用データを準備しています ${made}/${sel.length*4}`);
      await new Promise(r=>setTimeout(r,0));
    }
  }
  await trWrite(dir,'sparse/0/images.txt',lines.join('\n')+'\n');
  return{dir,views:sel.length*4,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,seedScale:seed.sceneScale};
}'''

s = sub_once(
    s,
    r'async function trBuildDataset\(item,id\)\{.*?\}\n\nfunction trPlan',
    new_build + '\n\nfunction trPlan',
    'dataset build with init ply',
    re.S,
)

new_plan = r'''function trPlan(size){
  const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4,seed=trSeedBudget();
  if(m>=12&&c>=8)return{iters:3200,max:Math.max(60000,seed),res:Math.min(size,512),seed,label:'品質優先'};
  if(m>=8&&c>=6)return{iters:2800,max:Math.max(50000,seed),res:Math.min(size,512),seed,label:'品質優先'};
  return{iters:2200,max:Math.max(32000,seed),res:Math.min(size,384),seed,label:'省メモリ品質'};
}'''
s = sub_once(
    s,
    r'function trPlan\(size\)\{.*?\}\nasync function trRuntimeReady',
    new_plan + '\nasync function trRuntimeReady',
    'quality plan',
    re.S,
)

s = replace_once(
    s,
    "if('eval-split-every'in c)c['eval-split-every']=8;",
    "if('eval-split-every'in c)c['eval-split-every']=6;",
    'grouped holdout interval',
)
s = replace_once(
    s,
    "trLog(`Training config: ${plan.iters} iterations / fixed browser Gaussian budget / ${plan.res}px / SH degree 0 / hold-out every 8th image / eval every ${Math.max(500,Math.floor(plan.iters/4))} steps / stats reset every ${refineEvery} / random initialization`);",
    "trLog(`Training config: ${plan.iters} iterations / ${ds.seedCount.toLocaleString()} BA/SfM-informed seed Gaussians / ${plan.res}px / SH degree 0 / source-position hold-out every 6th group / eval every ${Math.max(500,Math.floor(plan.iters/4))} steps / browser refine stats reset every ${refineEvery}`);",
    'truthful c7 training config log',
)
s = replace_once(
    s,
    "    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px`);",
    "    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px / ${ds.seedCount.toLocaleString()} hybrid seeds (${ds.sourceTracks} optimized BA/SfM tracks, ${ds.seedAnchors.toLocaleString()} track-anchored samples)`);",
    'seed dataset log',
)
s = replace_once(
    s,
    "res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB${range?` / ${range}`:''}`;",
    "res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB / 初期seed ${ds.seedCount.toLocaleString()}${range?` / ${range}`:''}`;",
    'result seed metadata',
)
s = s.replace(
    'Gaussian scaleの極端な膨張は目立ちません。固定10,000 Gaussian・densificationなし・SH degree 0による表現力不足が主因候補です。',
    'Gaussian scaleの極端な膨張は目立ちません。BA/SfM情報で増量した固定seed Gaussian・densificationなし・SH degree 0でなお表現力または最適化が不足している可能性を確認します。',
)
s = s.replace(
    '学習に使った画像自体への適合が低いため、現時点ではカメラ姿勢よりも固定10,000 Gaussian・SH degree 0・densificationなしによる表現力不足または最適化不足を優先して改善します。',
    '学習に使った画像自体への適合が低いため、現時点ではカメラ姿勢だけを主因とせず、固定seed Gaussian・SH degree 0・densificationなしによる表現力または最適化不足を引き続き評価します。',
)
s = s.replace(
    '学習画像への適合度と、約1/8を除外した未学習画像への一般化を比較しています。',
    '学習画像への適合度と、元360°動画の撮影位置単位で除外した未学習位置への一般化を比較しています。',
)
s = s.replace("brush_js_bg.wasm?v=0.3c6", "brush_js_bg.wasm?v=0.3c7")
s = s.replace("brush_js.js?v=0.3c6", "brush_js.js?v=0.3c7")
s = s.replace("Prototype v0.3c6", "Prototype v0.3c7")
p.write_text(s)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c7\n'
    'Source-position holdout + BA/SfM-informed hybrid Gaussian initialization\n'
    'Build date: 2026-08-16\n'
)
