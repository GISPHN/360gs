from pathlib import Path

p = Path('training.js')
s = p.read_text(encoding='utf-8')

anchor = "function trRepresentativeView(item){"
if 'function trGaussianDiagnostics(' not in s:
    insert = r'''function trQuantile(values,q){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;const k=(a.length-1)*q,i=Math.floor(k),f=k-i;return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*f;}
function trSigmoid(x){if(x>=0)return 1/(1+Math.exp(-x));const e=Math.exp(x);return e/(1+e);}
function trGaussianDiagnostics(t,o,n,bounds){
  const maxScale=[],geoScale=[],axisRatio=[],opacity=[];
  for(let i=0;i<n;i++){
    const z=i*10,logs=[t[z+7],t[z+8],t[z+9]];
    if(logs.every(Number.isFinite)){
      const sc=logs.map(v=>Math.exp(Math.max(-30,Math.min(30,v))));
      const mx=Math.max(...sc),mn=Math.max(1e-12,Math.min(...sc));
      maxScale.push(mx);geoScale.push(Math.exp((logs[0]+logs[1]+logs[2])/3));axisRatio.push(mx/mn);
    }
    const ov=o[i];if(Number.isFinite(ov))opacity.push(trSigmoid(ov));
  }
  const radius=Math.max(1e-9,bounds?.radius||1);
  const d={
    scale50:trQuantile(maxScale,.5),scale90:trQuantile(maxScale,.9),scale99:trQuantile(maxScale,.99),
    geo50:trQuantile(geoScale,.5),ratio90:trQuantile(axisRatio,.9),
    opacity10:trQuantile(opacity,.1),opacity50:trQuantile(opacity,.5),opacity90:trQuantile(opacity,.9),radius
  };
  d.rel90=d.scale90/radius;d.rel99=d.scale99/radius;
  if(d.rel90>.12||d.rel99>.35)d.verdict='大きなGaussianが多く、ぼけの主因になっている可能性があります。';
  else if(d.opacity50<.04)d.verdict='Gaussianの透明度が低く、復元が薄くなっている可能性があります。';
  else d.verdict='Gaussian scaleの極端な膨張は目立ちません。固定10,000 Gaussian・densificationなし・SH degree 0による表現力不足が主因候補です。';
  return d;
}
function trRenderGaussianDiagnostics(res,d){
  if(!res||!d)return;
  let e=res.querySelector('#train-result-diagnostics');
  if(!e){e=document.createElement('div');e.id='train-result-diagnostics';e.className='train-result-meta';res.querySelector('#train-result-meta')?.insertAdjacentElement('afterend',e);}
  const f=v=>Number.isFinite(v)?v.toFixed(4):'—',pct=v=>Number.isFinite(v)?`${(v*100).toFixed(1)}%`:'—';
  e.innerHTML=`<strong>Gaussian品質診断</strong><br>scale 最大軸: 中央値 ${f(d.scale50)} / p90 ${f(d.scale90)} / p99 ${f(d.scale99)}<br>シーン半径比: p90 ${pct(d.rel90)} / p99 ${pct(d.rel99)}　・　異方性p90 ${Number.isFinite(d.ratio90)?d.ratio90.toFixed(1):'—'}倍<br>opacity: p10 ${pct(d.opacity10)} / 中央値 ${pct(d.opacity50)} / p90 ${pct(d.opacity90)}<br>${d.verdict}`;
}
'''
    if anchor not in s:
        raise SystemExit('representative view anchor not found')
    s = s.replace(anchor, insert + anchor, 1)

old = "async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats);trResultBounds=bounds;return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds};}"
new = "async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats),diagnostics=trGaussianDiagnostics(t,o,s.numSplats,bounds);trResultBounds=bounds;trLog(`Gaussian diagnostics: scale p50=${diagnostics.scale50.toFixed(4)} p90=${diagnostics.scale90.toFixed(4)} p99=${diagnostics.scale99.toFixed(4)} / radius ratios p90=${(diagnostics.rel90*100).toFixed(1)}% p99=${(diagnostics.rel99*100).toFixed(1)}% / opacity median=${(diagnostics.opacity50*100).toFixed(1)}%`);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds,diagnostics};}"
if old not in s:
    raise SystemExit('trExport anchor not found')
s = s.replace(old,new,1)

old2 = "res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB${trBoundsSummary(ex.bounds)?` / ${trBoundsSummary(ex.bounds)}`:''}`;"
new2 = old2 + "\n    trRenderGaussianDiagnostics(res,ex.diagnostics);"
if old2 not in s:
    raise SystemExit('result meta anchor not found')
s = s.replace(old2,new2,1)

old3 = "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,view:trResultView,segmentId:item.source.segment.id};"
new3 = "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,diagnostics:ex.diagnostics,view:trResultView,segmentId:item.source.segment.id};"
if old3 in s:
    s = s.replace(old3,new3,1)

p.write_text(s,encoding='utf-8')

for name in ['video.html','index.html']:
    q=Path(name)
    if q.exists():
        x=q.read_text(encoding='utf-8').replace('v0.3c2','v0.3c3')
        q.write_text(x,encoding='utf-8')

Path('BUILD_VERSION.txt').write_text('360GS v0.3c3\nGaussian scale / opacity diagnostics for reconstruction quality\nBuild date: 2026-08-16\n',encoding='utf-8')
