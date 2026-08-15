from pathlib import Path

p = Path('training.js')
s = p.read_text()
s = s.replace('?v=0.3b5', '?v=0.3b6').replace('Prototype v0.3b5', 'Prototype v0.3b6')

old = "  if(k==='Warning'&&msg.text)trLog(`Brush warning: ${msg.text}`);"
new = """  if(k==='Warning'&&msg.text){
    const tx=String(msg.text);
    if(tx.startsWith('360GS_STAGE:')){
      const stage=tx.slice('360GS_STAGE:'.length).trim();
      const labels={
        post_loading_enter:'Brush学習環境の後処理を開始しました',
        bounds_begin:'Gaussian境界を計算しています',
        bounds_done:'Gaussian境界の計算が完了しました',
        view_cams_begin:'学習カメラ情報を準備しています',
        view_cams_done:'学習カメラ情報を準備できました',
        trainer_ready:'学習器の準備が完了しました',
        first_batch_begin:'最初の学習画像をGPU用に取得しています',
        first_batch_ready:'最初の学習画像を取得できました',
        autodiff_begin:'Gaussianを自動微分用に準備しています',
        autodiff_ready:'Gaussianの自動微分準備が完了しました',
        trainer_step_begin:'レンダリング・損失計算・逆伝播を実行しています',
        trainer_step_done:'最初のGPU学習計算が完了しました'
      };
      trProgress(20,labels[stage]||`Brush内部処理: ${stage}`);
      trLog(`Brush stage: ${stage}`);
    }else trLog(`Brush warning: ${tx}`);
  }"""
assert old in s, 'warning handler target not found'
s = s.replace(old, new, 1)

old = """      const msgs=await trWaitStage(t.trainSteps(batch),waitMs,label,t,rt);
      if(!msgs.length)break;
      for(const m of msgs){
        trApply(rt,m,plan);
        if(trKind(rt.mod,m)==='DoneTraining')done=true;
      }
"""
new = """      let msgs=[];
      if(firstStep&&rt.progressApi){
        let sawStep=false;
        while(!sawStep&&!done&&!trCancelled){
          const one=await trWaitStage(t.trainSteps(0),waitMs,label,t,rt);
          if(!one.length)break;
          msgs.push(...one);
          for(const m of one){
            const kk=trKind(rt.mod,m);
            trApply(rt,m,plan);
            if(kk==='TrainStep')sawStep=true;
            if(kk==='DoneTraining')done=true;
          }
          await new Promise(r=>setTimeout(r,0));
        }
        if(!sawStep&&!done&&!trCancelled)throw new Error('Brush内部診断は完了しましたが、最初のTrainStepまで到達できませんでした。');
      }else{
        msgs=await trWaitStage(t.trainSteps(batch),waitMs,label,t,rt);
        for(const m of msgs){
          trApply(rt,m,plan);
          if(trKind(rt.mod,m)==='DoneTraining')done=true;
        }
      }
      if(!msgs.length)break;
"""
assert old in s, 'first step pump target not found'
s = s.replace(old, new, 1)
p.write_text(s)

for name in ['video.html', 'index.html', 'README.md']:
    q = Path(name)
    if q.exists():
        t = q.read_text().replace('v0.3b5', 'v0.3b6').replace('v=0.3b5', 'v=0.3b6')
        q.write_text(t)
