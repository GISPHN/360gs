from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c6: compare final fit on training views against held-out views.
# This separates model-capacity/optimization failure from camera/geometry generalization failure.

# ---- Brush: final evaluation on a small sample of actual training views ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
s = replace_once(
    s,
    '    let mut eval_scene = dataset.eval;\n\n    let mut train_duration = Duration::from_secs(0);\n',
    '    let mut eval_scene = dataset.eval;\n    let train_fit_scene = dataset.train.clone();\n\n    let mut train_duration = Duration::from_secs(0);\n',
    'clone training scene for fit evaluation',
)

anchor = '''        // Export checkpoints
'''
insert = '''        // 360GS browser diagnostic: at the final base-training iteration,
        // evaluate a few images that were actually used for training. Comparing
        // this with the held-out evaluation distinguishes underfitting from
        // camera/geometry generalization errors.
        if current_lod == 0 && iter == training_steps {
            let train_eval = run_360gs_train_fit_eval(
                &device,
                emitter,
                splats.clone(),
                iter,
                &train_fit_scene,
            )
            .await
            .with_context(|| format!("Failed 360GS train-fit evaluation at iteration {iter}"));
            if let Err(error) = train_eval {
                emitter.emit(ProcessMessage::Warning { error }).await;
            }
        }

        // Export checkpoints
'''
s = replace_once(s, anchor, insert, 'final training-view evaluation call')

anchor = '''// TODO: Want to support this on WASM somehow. Maybe have user pick a file once,
'''
helper = r'''async fn run_360gs_train_fit_eval(
    device: &burn::tensor::Device,
    emitter: &Emitter,
    splats: Splats,
    iter: u32,
    train_scene: &Scene,
) -> Result<(), anyhow::Error> {
    let n = train_scene.views.len();
    if n == 0 {
        return Ok(());
    }

    // Four evenly-spaced train views are enough for a diagnostic while keeping
    // browser GPU readback/render overhead bounded.
    let target = n.min(4);
    let mut indices = Vec::<usize>::new();
    for k in 0..target {
        let idx = if target <= 1 { 0 } else { k * (n - 1) / (target - 1) };
        if indices.last().copied() != Some(idx) {
            indices.push(idx);
        }
    }

    let mut psnr = 0.0f32;
    let mut ssim = 0.0f32;
    let mut count = 0usize;
    for idx in indices {
        brush_async::yield_now().await;
        let view = &train_scene.views[idx];
        let eval_img = view.image.load().await?;
        let sample = eval_stats(
            splats.clone(),
            &view.camera,
            eval_img,
            view.image.alpha_mode(),
            device,
        )
        .await
        .context("Failed 360GS train-fit eval sample")?;
        psnr += sample.psnr.into_scalar_async::<f32>().await?;
        ssim += sample.ssim.into_scalar_async::<f32>().await?;
        count += 1;
    }

    if count > 0 {
        psnr /= count as f32;
        ssim /= count as f32;
        emitter
            .emit(ProcessMessage::Warning {
                error: anyhow::anyhow!(
                    "360GS_TRAIN_EVAL:{iter}:{psnr:.6}:{ssim:.6}:{count}"
                ),
            })
            .await;
    }
    Ok(())
}

// TODO: Want to support this on WASM somehow. Maybe have user pick a file once,
'''
s = replace_once(s, anchor, helper, 'training fit evaluation helper')
p.write_text(s)

# ---- 360GS frontend ----
p = Path('training.js')
s = p.read_text()
s = replace_once(
    s,
    'let trLastEval = null;\nlet trEvalHistory = [];\n',
    'let trLastEval = null;\nlet trEvalHistory = [];\nlet trLastTrainEval = null;\n',
    'training eval state',
)
s = replace_once(
    s,
    "    if(tx.startsWith('360GS_STAGE:')){\n",
    "    if(tx.startsWith('360GS_TRAIN_EVAL:')){\n      const parts=tx.split(':');\n      const iter=Number(parts[1]),psnr=Number(parts[2]),ssim=Number(parts[3]),count=Number(parts[4]);\n      trLastTrainEval={iter,psnr,ssim,count};\n      trLog(`Training-view fit @ ${Number.isFinite(iter)?iter:'—'}: PSNR ${Number.isFinite(psnr)?psnr.toFixed(2):'—'} dB / SSIM ${Number.isFinite(ssim)?ssim.toFixed(3):'—'} / ${Number.isFinite(count)?count:'—'} views`);\n    }else if(tx.startsWith('360GS_STAGE:')){\n",
    'parse training evaluation warning',
)
s = replace_once(
    s,
    "function trHoldoutInterpretation(e){\n  if(!e||!Number.isFinite(e.psnr)||!Number.isFinite(e.ssim))return '検証画像の評価値を取得できませんでした。';\n  if(e.psnr>=22&&e.ssim>=.70)return '未学習画像も比較的よく再現できています。カメラ姿勢・幾何の大きな不整合より、Gaussian数・SH degree・densificationなど表現力側を次に検討します。';\n  if(e.psnr<15||e.ssim<.45)return '未学習画像の再現性が低い状態です。Gaussian数だけを増やす前に、カメラ姿勢・対応点・3D幾何の不整合を優先して確認します。';\n  return '未学習画像の再現性は中間的です。カメラ姿勢・幾何とGaussian表現力の両方が制約になっている可能性があるため、次段階では再投影誤差と容量増加の比較試験を行います。';\n}\nfunction trRenderHoldoutEvaluation(res,e,history){\n  if(!res)return;\n  let box=res.querySelector('#train-result-eval');\n  if(!box){box=document.createElement('div');box.id='train-result-eval';box.className='train-result-meta';const d=res.querySelector('#train-result-diagnostics');(d||res.querySelector('#train-result-meta'))?.insertAdjacentElement('afterend',box);}\n  const n=Array.isArray(history)?history.length:0;\n  const psnr=e&&Number.isFinite(e.psnr)?`${e.psnr.toFixed(2)} dB`:'—';\n  const ssim=e&&Number.isFinite(e.ssim)?e.ssim.toFixed(3):'—';\n  box.innerHTML=`<strong>未学習画像での再投影評価</strong><br>PSNR ${psnr} / SSIM ${ssim}${n?` / 評価 ${n}回`:''}<br><span>約1/8の画像を3DGS学習には使用せず、Brushが同じ推定カメラから再レンダリングして評価しています。</span><br>${trHoldoutInterpretation(e)}`;\n}\n",
    "function trFitInterpretation(trainEval,holdout){\n  const tv=trainEval&&Number.isFinite(trainEval.psnr)&&Number.isFinite(trainEval.ssim),hv=holdout&&Number.isFinite(holdout.psnr)&&Number.isFinite(holdout.ssim);\n  if(!tv||!hv)return '学習画像と未学習画像の両方の評価値が揃っていません。';\n  const gap=trainEval.psnr-holdout.psnr;\n  if(trainEval.psnr<15||trainEval.ssim<.50)return '学習に使った画像自体への適合が低いため、現時点ではカメラ姿勢よりも固定10,000 Gaussian・SH degree 0・densificationなしによる表現力不足または最適化不足を優先して改善します。';\n  if(trainEval.psnr>=20&&trainEval.ssim>=.65&&(holdout.psnr<15||holdout.ssim<.45||gap>5))return '学習画像には適合できていますが未学習画像で大きく低下しています。カメラ姿勢・対応点・3D幾何の不整合を優先して改善します。';\n  if(trainEval.psnr>=20&&holdout.psnr>=18&&trainEval.ssim>=.65&&holdout.ssim>=.60)return '学習画像・未学習画像とも一定の再現性があります。次はGaussian数、SH degree、軽量densificationを段階的に増やします。';\n  return '学習画像への適合と未学習画像への一般化の両方が中間的です。容量改善とカメラ姿勢改善を一度に変えず、次段階で個別に比較します。';\n}\nfunction trRenderFitEvaluation(res,trainEval,holdout,history){\n  if(!res)return;\n  let box=res.querySelector('#train-result-eval');\n  if(!box){box=document.createElement('div');box.id='train-result-eval';box.className='train-result-meta';const d=res.querySelector('#train-result-diagnostics');(d||res.querySelector('#train-result-meta'))?.insertAdjacentElement('afterend',box);}\n  const n=Array.isArray(history)?history.length:0;\n  const tp=trainEval&&Number.isFinite(trainEval.psnr)?`${trainEval.psnr.toFixed(2)} dB`:'—',ts=trainEval&&Number.isFinite(trainEval.ssim)?trainEval.ssim.toFixed(3):'—';\n  const hp=holdout&&Number.isFinite(holdout.psnr)?`${holdout.psnr.toFixed(2)} dB`:'—',hs=holdout&&Number.isFinite(holdout.ssim)?holdout.ssim.toFixed(3):'—';\n  const gap=trainEval&&holdout&&Number.isFinite(trainEval.psnr)&&Number.isFinite(holdout.psnr)?`${(trainEval.psnr-holdout.psnr).toFixed(2)} dB`:'—';\n  box.innerHTML=`<strong>学習画像と未学習画像の再投影比較</strong><br>学習画像: PSNR ${tp} / SSIM ${ts}${trainEval?.count?` / ${trainEval.count}視点`:''}<br>未学習画像: PSNR ${hp} / SSIM ${hs}${n?` / 評価 ${n}回`:''}<br>PSNR差: ${gap}<br><span>学習画像への適合度と、約1/8を除外した未学習画像への一般化を比較しています。</span><br>${trFitInterpretation(trainEval,holdout)}`;\n}\n",
    'replace heldout-only interpretation with fit comparison',
)
s = replace_once(
    s,
    '  trLastEval=null;trEvalHistory=[];\n',
    '  trLastEval=null;trEvalHistory=[];trLastTrainEval=null;\n',
    'reset train eval',
)
s = replace_once(
    s,
    '    trRenderHoldoutEvaluation(res,trLastEval,trEvalHistory);\n',
    '    trRenderFitEvaluation(res,trLastTrainEval,trLastEval,trEvalHistory);\n',
    'render fit comparison',
)
s = replace_once(
    s,
    '    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,diagnostics:ex.diagnostics,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id};\n',
    '    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,diagnostics:ex.diagnostics,trainEval:trLastTrainEval,eval:trLastEval,evalHistory:[...trEvalHistory],view:ex.view,segmentId:item.source.segment.id};\n',
    'persist train eval',
)
s = s.replace("brush_js.js?v=0.3c4", "brush_js.js?v=0.3c6").replace("brush_js_bg.wasm?v=0.3c4", "brush_js_bg.wasm?v=0.3c6")
s = s.replace("Prototype v0.3c5", "Prototype v0.3c6")
p.write_text(s)

# Build marker
Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c6\nTrain-view versus held-out reprojection evaluation\nBuild date: 2026-08-16\n'
)
