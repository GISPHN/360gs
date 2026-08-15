from pathlib import Path
import re

path = Path('training.js')
text = path.read_text(encoding='utf-8')

text = text.replace('const TR_BATCH = 5;', 'const TR_BATCH = 5;')
text = text.replace("await mod.default();", "await mod.default(new URL('./vendor/brush-js/brush_js_bg.wasm?v=0.3b2', window.location.href));", 1)

apply_re = re.compile(r"function trApply\(rt,msg,plan\)\{.*?\}\nfunction trTogglePause", re.S)
apply_new = r'''function trApply(rt,msg,plan){
  const p=trPanel(),k=trKind(rt.mod,msg);
  if(k==='NewProcess'){
    trProgress(11,'Brushの処理を開始しました');
    trLog('Brush process started');
  }
  if(k==='StartLoading'){
    const name=msg.name||'データセット';
    trProgress(12,`Brush: ${name} を読み込んでいます`);
    trLog(`Loading ${name}`);
  }
  if(k==='DatasetLoaded'){
    const n=msg.trainViews??0;
    p.querySelector('#train-views').textContent=`${n}枚`;
    trProgress(15,`Brushが学習画像 ${n}枚を認識しました`);
    trLog(`Dataset loaded: ${n} train views / ${msg.evalViews??0} eval views`);
  }
  if(k==='SplatsUpdated'){
    if(msg.numSplats!=null)p.querySelector('#train-splats').textContent=Number(msg.numSplats).toLocaleString();
    trProgress(17,'初期Gaussianを準備しています');
    if(msg.numSplats!=null)trLog(`Initial splats: ${Number(msg.numSplats).toLocaleString()}`);
  }
  if(k==='DoneLoading'){
    trProgress(19,'データセットと初期Gaussianの準備が完了しました');
    trLog('Brush loading done');
  }
  if(k==='RefineStep'&&msg.numSplats!=null)p.querySelector('#train-splats').textContent=Number(msg.numSplats).toLocaleString();
  if(k==='TrainStep'){
    const i=msg.iter??0;
    p.querySelector('#train-iter').textContent=`${i.toLocaleString()} / ${plan.iters.toLocaleString()}`;
    if(msg.elapsedMs!=null)p.querySelector('#train-elapsed').textContent=`${(msg.elapsedMs/1000).toFixed(1)}秒`;
    trProgress(20+77*i/plan.iters,`3DGSを学習しています ${Math.min(100,Math.round(i/plan.iters*100))}%`);
  }
  if(k==='EvalResult'){
    if(msg.psnr!=null)p.querySelector('#train-psnr').textContent=Number(msg.psnr).toFixed(2);
    if(msg.ssim!=null)p.querySelector('#train-ssim').textContent=Number(msg.ssim).toFixed(3);
  }
  if(k==='DoneTraining')trLog('Brush training done');
  if(k==='Warning'&&msg.text)trLog(`Brush warning: ${msg.text}`);
}

async function trWaitStage(promise, timeoutMs, label, training){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      try{training?.free();}catch{}
      if(trTraining===training)trTraining=null;
      reject(new Error(`${label}が${Math.round(timeoutMs/60000)}分以上応答しませんでした。処理を安全に停止しました。GPU・ブラウザ・データ初期化の互換性を確認します。`));
    },timeoutMs);
  });
  try{return await Promise.race([promise,timeout]);}
  finally{clearTimeout(timer);}
}

function trTogglePause'''
text, n = apply_re.subn(apply_new, text, count=1)
if n != 1:
    raise SystemExit(f'trApply replacement failed: {n}')

run_re = re.compile(r"async function trRun\(item\)\{.*?\}\nfunction trLatest", re.S)
run_new = r'''async function trRun(item){
  if(trRunning)return;
  const id=++trRunId;
  trRunning=true;trCancelled=false;trPaused=false;
  const p=trPanel();
  p.hidden=false;
  p.querySelector('#train-result').hidden=true;
  p.querySelector('#train-log').textContent='';
  p.querySelector('#train-log').hidden=true;
  p.querySelector('#train-message').hidden=true;
  p.querySelector('#train-webgpu').textContent=navigator.gpu?'利用可':'利用不可';
  p.querySelector('#train-splats').textContent='—';
  p.querySelector('#train-elapsed').textContent='—';
  p.querySelector('#train-psnr').textContent='—';
  p.querySelector('#train-ssim').textContent='—';
  trButtons(true);
  try{
    trProgress(1,'Brush学習エンジンを初期化しています');
    const rt=await trRuntimeReady();
    if(id!==trRunId)return;
    trLog('Brush WebGPU runtime ready');

    trProgress(2,'Brush用の学習画像を準備しています');
    const ds=await trBuildDataset(item,id),plan=trPlan(ds.size);
    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px`);
    p.querySelector('#train-views').textContent=`${ds.views}枚`;
    p.querySelector('#train-plan').textContent=`${plan.label} ${plan.iters.toLocaleString()}回`;
    p.querySelector('#train-iter').textContent=`0 / ${plan.iters.toLocaleString()}`;

    trProgress(10,'Brushへデータセットを渡しています');
    const t=rt.app.startTrainingFromDirectory(ds.dir,async init=>{
      trLog('Brush training configuration received');
      const c={...init};
      if('total-train-iters'in c)c['total-train-iters']=plan.iters;
      if('max-splats'in c)c['max-splats']=plan.max;
      if('max-resolution'in c)c['max-resolution']=plan.res;
      if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));
      trLog(`Training config: ${plan.iters} iterations / max ${plan.max.toLocaleString()} splats / ${plan.res}px`);
      return c;
    });
    trTraining=t;
    trLog('Brush training process created');

    let loaded=false,loadEvents=0;
    while(!loaded&&!trCancelled){
      const msgs=await trWaitStage(t.trainSteps(0),120000,'Brushのデータ読み込み',t);
      if(!msgs.length)throw new Error('Brushのデータ読み込みストリームが学習開始前に終了しました。');
      for(const m of msgs){
        const kind=trKind(rt.mod,m);
        trApply(rt,m,plan);
        if(kind==='DoneLoading')loaded=true;
      }
      loadEvents+=msgs.length;
      if(loadEvents>100)throw new Error('Brushの初期化イベントが通常より多く、学習開始まで到達できませんでした。');
      await new Promise(r=>setTimeout(r,0));
    }
    if(trCancelled)return;
    if(!loaded)throw new Error('Brushのデータセット初期化を完了できませんでした。');

    trProgress(20,'最初のGPU学習ステップを準備しています');
    trLog('Starting first GPU training step');
    let done=false,firstStep=true;
    while(!done&&!trCancelled){
      while(trPaused)await new Promise(r=>trResume=r);
      if(trCancelled)break;
      const batch=firstStep?1:TR_BATCH;
      const waitMs=firstStep?300000:180000;
      const label=firstStep?'最初のGPU学習ステップ':'GPU学習ステップ';
      const msgs=await trWaitStage(t.trainSteps(batch),waitMs,label,t);
      if(!msgs.length)break;
      for(const m of msgs){
        trApply(rt,m,plan);
        if(trKind(rt.mod,m)==='DoneTraining')done=true;
      }
      if(firstStep){
        firstStep=false;
        trLog('First GPU training step completed');
      }
      await new Promise(r=>setTimeout(r,0));
    }
    if(trCancelled)return;
    if(firstStep)throw new Error('GPU学習の最初のステップを完了できませんでした。');

    const ex=await trExport(rt,t),res=p.querySelector('#train-result');
    res.hidden=false;
    res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB`;
    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,`360gs_segment_${item.source.segment.id}.ply`);
    res.querySelector('#train-show').onclick=()=>trShow(ex.blob).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));
    trProgress(100,'3DGS生成が完了しました');
    trMsg('3DGS学習が完了しました。PLYとして保存するか、この画面で3D表示できます。','success');
    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,segmentId:item.source.segment.id};
    window.dispatchEvent(new CustomEvent('360gs:training-ready',{detail:{ready:true,count:ex.count,segmentId:item.source.segment.id}}));
  }catch(e){
    trProgress(0,'3DGS学習を継続できませんでした');
    trMsg(e?.message||String(e),'warning');
    trLog(String(e?.stack||e));
  }finally{
    trRunning=false;trTraining=null;trButtons(false);
  }
}
function trLatest'''
text, n = run_re.subn(run_new, text, count=1)
if n != 1:
    raise SystemExit(f'trRun replacement failed: {n}')

text = text.replace('0.3b1', '0.3b2')
path.write_text(text, encoding='utf-8')

video = Path('video.html')
v = video.read_text(encoding='utf-8').replace('0.3b1', '0.3b2')
video.write_text(v, encoding='utf-8')

index = Path('index.html')
i = index.read_text(encoding='utf-8').replace('0.3b', '0.3b2')
index.write_text(i, encoding='utf-8')
