from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c10: preserve the c9 model and isolate the remaining blur before
# changing Gaussian capacity, resolution, SH degree, or camera geometry.
#
# The c9 field test completed normally at ~4800 iterations, but the frontend
# showed no training-view PSNR/SSIM. c6 only runs train-fit evaluation when the
# configured maximum iteration is reached; c8/c9 adaptive stopping can finish
# earlier. c10 evaluates a small training-view sample at late held-out eval
# boundaries and requires a matching train-fit result before adaptive stop.
# This changes diagnostics only, not optimization or Gaussian growth behavior.


# ---- Brush: obtain a late train-view metric before adaptive browser stop ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
old = '''        if current_lod == 0 && iter == training_steps {
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
'''
new = '''        // c10 diagnostic: adaptive stopping can end before `training_steps`,
        // so the old final-only train-fit check was skipped. Once the run has
        // reached the final third of its configured horizon, evaluate the same
        // splats on a small sample of actual training views at each normal eval
        // boundary. For the 360GS plans this yields the first train-fit metric
        // exactly at the minimum early-stop boundary (4800/4800/3600).
        let late_train_fit = iter >= training_steps.saturating_mul(2) / 3
            && iter % process_config.eval_every.max(1) == 0;
        if current_lod == 0 && (late_train_fit || iter == training_steps) {
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
'''
s = replace_once(s, old, new, 'late train-fit evaluation before adaptive stop')
p.write_text(s)


# ---- Frontend: do not early-stop until the matching training metric arrives ----
p = Path('training.js')
s = p.read_text()
old = '''  const psnrGain=c.psnr-a.psnr,ssimGain=c.ssim-a.ssim;
  const monotonicEnough=c.psnr<=b.psnr+plan.plateauDb&&b.psnr<=a.psnr+plan.plateauDb;
'''
new = '''  // c10 requires a training-view diagnostic from the same evaluation
  // boundary before adaptive stop. This guarantees that the result panel can
  // distinguish underfitting from held-out generalization/geometry failure.
  if(!trLastTrainEval||!Number.isFinite(trLastTrainEval.psnr)||!Number.isFinite(trLastTrainEval.ssim)||!Number.isFinite(trLastTrainEval.iter)||trLastTrainEval.iter<c.iter)return null;
  const psnrGain=c.psnr-a.psnr,ssimGain=c.ssim-a.ssim;
  const monotonicEnough=c.psnr<=b.psnr+plan.plateauDb&&b.psnr<=a.psnr+plan.plateauDb;
'''
s = replace_once(s, old, new, 'gate adaptive stop on matching train-fit metric')

s = s.replace(
    "if(trainEval.psnr<15||trainEval.ssim<.50)return '学習に使った画像自体への適合が低いため、現時点ではカメラ姿勢よりも固定10,000 Gaussian・SH degree 0・densificationなしによる表現力不足または最適化不足を優先して改善します。';",
    "if(trainEval.psnr<15||trainEval.ssim<.50)return '学習に使った画像自体への適合が低いため、カメラ一般化よりもGaussian密度・学習解像度・SH degree・最適化収束など表現力側を優先して改善します。';"
)
s = s.replace(
    "return '学習画像への適合と未学習画像への一般化の両方が中間的です。容量改善とカメラ姿勢改善を一度に変えず、次段階で個別に比較します。';",
    "return '学習画像への適合と未学習画像への一般化の両方が中間的です。次段階ではGaussian密度・解像度・SH degreeと、カメラ姿勢・3D幾何を一度に変えず個別に比較します。';"
)

# Visible marker clarifying that c10 is a diagnostic-only model comparison.
s = s.replace("label:'高品質・GPU内軽量growth'", "label:'高品質・GPU内軽量growth＋train-fit診断'")
s = s.replace("label:'品質優先・GPU内軽量growth'", "label:'品質優先・GPU内軽量growth＋train-fit診断'")
s = s.replace("label:'省メモリ・GPU内軽量growth'", "label:'省メモリ・GPU内軽量growth＋train-fit診断'")

# Runtime/frontend cache keys.
s = s.replace('v0.3c9', 'v0.3c10').replace('v=0.3c9', 'v=0.3c10')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q = Path(name)
    if not q.exists():
        continue
    t = q.read_text().replace('v0.3c9', 'v0.3c10').replace('v=0.3c9', 'v=0.3c10')
    q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c10\n'
    'Late training-view fit diagnostic before adaptive stop\n'
    'Model behavior unchanged from v0.3c9: SH degree 0 and GPU-only bounded growth\n'
    'Train-fit evaluation begins in the final third at normal evaluation boundaries\n'
    'Adaptive stop waits for matching training-view PSNR/SSIM\n'
    'Build date: 2026-08-16\n'
)
