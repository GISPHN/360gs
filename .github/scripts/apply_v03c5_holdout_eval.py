from pathlib import Path

p = Path('training.js')
s = p.read_text(encoding='utf-8')

# Track held-out evaluation metrics separately from training progress.
anchor = "let trResultView = null;\n"
insert = "let trLastEval = null;\nlet trEvalHistory = [];\n"
if 'let trLastEval = null;' not in s:
    if anchor not in s:
        raise SystemExit('global state anchor not found')
    s = s.replace(anchor, anchor + insert, 1)

# Upgrade EvalResult handling so the last held-out result is retained and logged.
old_eval = """  if(k==='EvalResult'){\n    if(msg.psnr!=null)p.querySelector('#train-psnr').textContent=Number(msg.psnr).toFixed(2);\n    if(msg.ssim!=null)p.querySelector('#train-ssim').textContent=Number(msg.ssim).toFixed(3);\n  }"""
new_eval = """  if(k==='EvalResult'){\n    const psnr=msg.psnr==null?NaN:Number(msg.psnr),ssim=msg.ssim==null?NaN:Number(msg.ssim),iter=msg.iter==null?null:Number(msg.iter);\n    if(Number.isFinite(psnr))p.querySelector('#train-psnr').textContent=psnr.toFixed(2);\n    if(Number.isFinite(ssim))p.querySelector('#train-ssim').textContent=ssim.toFixed(3);\n    trLastEval={psnr,ssim,iter};trEvalHistory.push(trLastEval);\n    trLog(`Held-out evaluation${iter!=null?` @ ${iter}`:''}: PSNR ${Number.isFinite(psnr)?psnr.toFixed(2):'—'} dB / SSIM ${Number.isFinite(ssim)?ssim.toFixed(3):'—'}`);\n  }"""
if old_eval in s:
    s = s.replace(old_eval, new_eval, 1)
elif new_eval not in s:
    raise SystemExit('EvalResult handler anchor not found')

# Add a result-panel diagnostic that explicitly distinguishes held-out fit from Gaussian scale diagnostics.
anchor_diag = "function trRepresentativeView(item){"
if 'function trRenderHoldoutEvaluation(' not in s:
    diag = r'''function trHoldoutInterpretation(e){
  if(!e||!Number.isFinite(e.psnr)||!Number.isFinite(e.ssim))return '検証画像の評価値を取得できませんでした。';
  if(e.psnr>=22&&e.ssim>=.70)return '未学習画像も比較的よく再現できています。カメラ姿勢・幾何の大きな不整合より、Gaussian数・SH degree・densificationなど表現力側を次に検討します。';
  if(e.psnr<15||e.ssim<.45)return '未学習画像の再現性が低い状態です。Gaussian数だけを増やす前に、カメラ姿勢・対応点・3D幾何の不整合を優先して確認します。';
  return '未学習画像の再現性は中間的です。カメラ姿勢・幾何とGaussian表現力の両方が制約になっている可能性があるため、次段階では再投影誤差と容量増加の比較試験を行います。';
}
function trRenderHoldoutEvaluation(res,e,history){
  if(!res)return;
  let box=res.querySelector('#train-result-eval');
  if(!box){box=document.createElement('div');box.id='train-result-eval';box.className='train-result-meta';const d=res.querySelector('#train-result-diagnostics');(d||res.querySelector('#train-result-meta'))?.insertAdjacentElement('afterend',box);}
  const n=Array.isArray(history)?history.length:0;
  const psnr=e&&Number.isFinite(e.psnr)?`${e.psnr.toFixed(2)} dB`:'—';
  const ssim=e&&Number.isFinite(e.ssim)?e.ssim.toFixed(3):'—';
  box.innerHTML=`<strong>未学習画像での再投影評価</strong><br>PSNR ${psnr} / SSIM ${ssim}${n?` / 評価 ${n}回`:''}<br><span>約1/8の画像を3DGS学習には使用せず、Brushが同じ推定カメラから再レンダリングして評価しています。</span><br>${trHoldoutInterpretation(e)}`;
}
'''
    if anchor_diag not in s:
        raise SystemExit('diagnostic insertion anchor not found')
    s = s.replace(anchor_diag, diag + anchor_diag, 1)

# Reset held-out evaluation state for every run.
reset_anchor = "  p.querySelector('#train-ssim').textContent='—';\n"
if 'trLastEval=null;trEvalHistory=[];' not in s:
    if reset_anchor not in s:
        raise SystemExit('run reset anchor not found')
    s = s.replace(reset_anchor, reset_anchor + "  trLastEval=null;trEvalHistory=[];\n", 1)

# Reserve every eighth image for true held-out evaluation. Brush already supports this natively.
config_anchor = "      if('max-resolution'in c)c['max-resolution']=plan.res;\n"
config_insert = "      if('eval-split-every'in c)c['eval-split-every']=8;\n"
if "c['eval-split-every']=8" not in s:
    if config_anchor not in s:
        raise SystemExit('config anchor not found')
    s = s.replace(config_anchor, config_anchor + config_insert, 1)

old_log = "trLog(`Training config: ${plan.iters} iterations / fixed browser Gaussian budget / ${plan.res}px / SH degree 0 / stats reset every ${refineEvery} / random initialization`);"
new_log = "trLog(`Training config: ${plan.iters} iterations / fixed browser Gaussian budget / ${plan.res}px / SH degree 0 / hold-out every 8th image / eval every ${Math.max(500,Math.floor(plan.iters/4))} steps / stats reset every ${refineEvery} / random initialization`);"
if old_log in s:
    s = s.replace(old_log, new_log, 1)
elif new_log not in s:
    raise SystemExit('training config log anchor not found')

# Show the final held-out metrics next to the Gaussian diagnostics and persist them for later comparison.
result_anchor = "    trRenderGaussianDiagnostics(res,ex.diagnostics);\n"
if 'trRenderHoldoutEvaluation(res,trLastEval,trEvalHistory);' not in s:
    if result_anchor not in s:
        raise SystemExit('result render anchor not found')
    s = s.replace(result_anchor, result_anchor + "    trRenderHoldoutEvaluation(res,trLastEval,trEvalHistory);\n", 1)

old_result = "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,diagnostics:ex.diagnostics,view:ex.view,segmentId:item.source.segment.id};"
new_result = "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,diagnostics:ex.diagnostics,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id};"
if old_result in s:
    s = s.replace(old_result, new_result, 1)
elif new_result not in s:
    raise SystemExit('training result anchor not found')

# Cache-bust all current static/runtime references.
s = s.replace('v0.3c4', 'v0.3c5')
s = s.replace('Prototype v0.3c4', 'Prototype v0.3c5')
p.write_text(s, encoding='utf-8')

for name in ['video.html', 'index.html']:
    q = Path(name)
    if q.exists():
        x = q.read_text(encoding='utf-8').replace('v0.3c4', 'v0.3c5')
        x = x.replace('Prototype v0.3c4', 'Prototype v0.3c5')
        q.write_text(x, encoding='utf-8')

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c5\nHeld-out reprojection evaluation with Brush PSNR and SSIM\nBuild date: 2026-08-16\n',
    encoding='utf-8',
)
