from pathlib import Path
import re

p = Path('training.js')
s = p.read_text(encoding='utf-8')

s, n = re.subn(
    r"function trPlan\(size\)\{.*?\}\nasync function trRuntimeReady",
    "function trPlan(size){const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4;if(m>=12&&c>=8)return{iters:4500,max:350000,res:Math.min(size,768),label:'標準'};if(m>=8&&c>=6)return{iters:3500,max:250000,res:Math.min(size,640),label:'軽量'};return{iters:2500,max:150000,res:Math.min(size,512),label:'省メモリ'};}\nasync function trRuntimeReady",
    s,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit(f'trPlan patch failed: {n}')

needle = "const app=new mod.BrushApp();app.initExisting(ad,dev,dev.queue);trRuntime={mod,device:dev,app};return trRuntime;}"
replacement = "const app=new mod.BrushApp();app.initExisting(ad,dev,dev.queue);let progressApi=false;try{const info=await fetch('./vendor/brush-js/BUILD_INFO.txt?v=0.3b2',{cache:'no-store'});progressApi=(await info.text()).includes('trainSteps(0)');}catch{}trRuntime={mod,device:dev,app,progressApi};return trRuntime;}"
if needle not in s:
    raise SystemExit('trRuntimeReady patch target not found')
s = s.replace(needle, replacement, 1)

old = '''    let loaded=false,loadEvents=0;
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
'''
new = '''    let loaded=false,loadEvents=0;
    if(rt.progressApi){
      trLog('Brush staged loading progress API available');
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
    }else{
      trLog('Brush staged progress runtime is not active yet; using compatible startup mode');
      trProgress(12,'Brushデータセットを読み込み、最初のGPU計算を準備しています');
    }

    trProgress(20,'最初のGPU学習ステップを準備しています');
'''
if old not in s:
    raise SystemExit('loading block patch target not found')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
