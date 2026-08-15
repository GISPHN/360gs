from pathlib import Path
import re

path = Path('training.js')
text = path.read_text(encoding='utf-8')

# Browser training: use Brush random initialization for compatibility.
text = text.replace("await trWrite(dir,'sparse/0/points3D.txt','# Empty points; init.ply supplies initialization.\\n');await trWrite(dir,'init.ply',trInitPly(item.optimization.tracks));", "await trWrite(dir,'sparse/0/points3D.txt','# Empty points; Brush random initialization is used for browser training.\\n');")

# Conservative first successful WebGPU run. Quality will be raised after compatibility is proven.
text = re.sub(
    r"function trPlan\(size\)\{.*?\}\nasync function trRuntimeReady",
    "function trPlan(size){const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4;if(m>=12&&c>=8)return{iters:2000,max:150000,res:Math.min(size,512),label:'互換優先'};if(m>=8&&c>=6)return{iters:1600,max:120000,res:Math.min(size,512),label:'互換優先'};return{iters:1200,max:80000,res:Math.min(size,384),label:'省メモリ'};}\nasync function trRuntimeReady",
    text,
    count=1,
    flags=re.S,
)

# Add GPU device-lost diagnostics to the runtime.
old = "const app=new mod.BrushApp();app.initExisting(ad,dev,dev.queue);let progressApi=false;"
new = "const app=new mod.BrushApp();app.initExisting(ad,dev,dev.queue);const lostPromise=dev.lost.then(info=>{throw new Error(`WebGPUデバイスが失われました: ${info?.message||info?.reason||'unknown'}`);});let progressApi=false;"
if old not in text:
    raise SystemExit('runtime insertion point not found')
text = text.replace(old, new, 1)
text = text.replace("trRuntime={mod,device:dev,app,progressApi};", "trRuntime={mod,device:dev,app,progressApi,lostPromise};", 1)

# Heartbeat + timeout + device-lost race, so the UI never looks frozen.
wait_re = re.compile(r"async function trWaitStage\(promise, timeoutMs, label, training\)\{.*?\n\}\n\nfunction trTogglePause", re.S)
wait_new = r'''async function trWaitStage(promise, timeoutMs, label, training, rt){
  let timer,heartbeat;
  const started=performance.now();
  const p=trPanel();
  const tick=()=>{
    const sec=Math.max(0,Math.floor((performance.now()-started)/1000));
    const maxSec=Math.round(timeoutMs/1000);
    p?.querySelector('#train-elapsed') && (p.querySelector('#train-elapsed').textContent=`${sec}秒`);
    const base=label.includes('GPU')?20:12;
    trProgress(base,`${label}を実行中（${sec}秒 / 最大${maxSec}秒）`);
  };
  tick();
  heartbeat=setInterval(tick,1000);
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      try{training?.free();}catch{}
      if(trTraining===training)trTraining=null;
      reject(new Error(`${label}が${Math.round(timeoutMs/60000)}分以上応答しませんでした。処理を安全に停止しました。`));
    },timeoutMs);
  });
  const races=[promise,timeout];
  if(rt?.lostPromise)races.push(rt.lostPromise);
  try{return await Promise.race(races);}
  finally{clearTimeout(timer);clearInterval(heartbeat);}
}

function trTogglePause'''
text, n = wait_re.subn(wait_new, text, count=1)
if n != 1:
    raise SystemExit(f'wait replacement failed: {n}')

# Pass runtime to watchdog and force low-complexity SH for the first compatibility run.
text = text.replace("if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));", "if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));if('sh-degree'in c)c['sh-degree']=0;", 1)
text = text.replace("${plan.res}px`);", "${plan.res}px / SH degree 0 / random initialization`);", 1)
text = text.replace("trWaitStage(t.trainSteps(0),120000,'Brushのデータ読み込み',t)", "trWaitStage(t.trainSteps(0),120000,'Brushのデータ読み込み',t,rt)")
text = text.replace("trWaitStage(t.trainSteps(batch),waitMs,label,t)", "trWaitStage(t.trainSteps(batch),waitMs,label,t,rt)")

text = text.replace('0.3b2', '0.3b3')
path.write_text(text, encoding='utf-8')

video = Path('video.html')
v = video.read_text(encoding='utf-8').replace('0.3b2', '0.3b3')
video.write_text(v, encoding='utf-8')

index = Path('index.html')
i = index.read_text(encoding='utf-8').replace('0.3b2', '0.3b3')
index.write_text(i, encoding='utf-8')
