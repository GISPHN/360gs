from pathlib import Path

p=Path('training.js')
s=p.read_text()
old="trLog(`Training config: ${plan.iters} max iterations / early-stop after ${plan.minIters} / ${ds.seedCount.toLocaleString()} BA/SfM-informed seed Gaussians / max ${plan.max.toLocaleString()} Gaussians / ${plan.res}px / SH degree 1 / 6-face 90deg cubemap / source-position hold-out every 6th group / eval every ${plan.evalEvery} / GPU-only growth every ${plan.refineEvery} until ${plan.growthStop} / growth fraction ${(plan.growthFraction*100).toFixed(0)}% / browser pruning disabled during training`);"
new="trLog(`Training config: ${plan.iters} max iterations / early-stop after ${plan.minIters} / ${ds.seedCount.toLocaleString()} geometry-anchored seed Gaussians (${ds.sourceTracks} BA tracks + ${ds.stereoPoints} 2-view triangulated points / random-depth ${ds.randomDepthSeeds}) / max ${plan.max.toLocaleString()} Gaussians / ${plan.res}px / SH degree 1 / 6-face 90deg cubemap / source-position hold-out every 6th group / eval every ${plan.evalEvery} / GPU-only growth every ${plan.refineEvery} until ${plan.growthStop} / growth fraction ${(plan.growthFraction*100).toFixed(0)}% / browser pruning disabled during training`);"
if old not in s: raise RuntimeError('training configuration text not found')
s=s.replace(old,new,1)
old="res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB / 初期seed ${ds.seedCount.toLocaleString()}${range?` / ${range}`:''}`;"
new="res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB / 幾何seed ${ds.seedCount.toLocaleString()}（BA ${ds.sourceTracks}点 + 2視点 ${ds.stereoPoints}点 / ランダム深度 ${ds.randomDepthSeeds}）${range?` / ${range}`:''}`;"
if old not in s: raise RuntimeError('result meta text not found')
s=s.replace(old,new,1)
s=s.replace("return '学習画像への適合と未学習画像への一般化の両方が中間的です。c13では6面90°cubemapへ変更して360°投影範囲を改善しています。改善が限定的なら、次は直接ERP/球面カメラモデルとカメラ姿勢・3D幾何を優先して比較します。';","return '学習画像への適合と未学習画像への一般化の両方が中間的です。c18ではランダム深度seedを廃止し、BA点とERP 2視点三角測量点だけに初期Gaussianを拘束しています。改善が限定的なら、次は直接ERP rasterizationとカメラ自己較正を優先して比較します。';")
s=s.replace("return '学習に使った画像自体への適合が低いため、現時点ではカメラ姿勢だけを主因とせず、BA/SfM seed・GPU内軽量growthを使用しても学習画像への適合が低いため、次は入力視点密度、カメラ幾何、解像度、SH degreeを個別に評価します。';","return '学習に使った画像自体への適合が低いため、幾何整合seedを使用しても不足が残っています。次は直接ERP rasterization、カメラ自己較正、入力視点密度を個別に評価します。';")
old="window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id};"
new="window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id,geometrySeed:{total:ds.seedCount,baTracks:ds.sourceTracks,twoViewPoints:ds.stereoPoints,randomDepthSeeds:ds.randomDepthSeeds,spacing:ds.seedSpacing,preflight:ds.geometryPreflight}};"
if old not in s: raise RuntimeError('training result object not found')
s=s.replace(old,new,1)
p.write_text(s)
