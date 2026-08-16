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


# v0.3c8: controlled quality experiment.
# - Keep the c7 BA/SfM-informed source-position evaluation design.
# - Restore full Brush refine/densify on wasm, but only at sparse intervals set by the frontend.
# - Cap growth aggressively so browser memory remains bounded.
# - Increase the optimization horizon and stop early only after repeated held-out plateaus.
# - Keep SH degree 0 so the c7 -> c8 comparison isolates optimization/densification.
#
# Brush 1.0.0 (2026-08-15) was reviewed before this patch. It contains major backend/API
# changes (Burn/CubeCL/wgpu/autodiff) that would confound this experiment and invalidate
# the existing diagnostic patch chain. The runtime therefore remains pinned to the known
# compatible 3b809857 source for c8; the 1.0.0 migration is intentionally a separate test.


# ---- Brush: re-enable sparse full refinement on wasm ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
old = '''            #[cfg(target_family = "wasm")]
            {
                // Browser-safe fixed-budget mode: full Brush refinement performs
                // several GPU -> CPU readbacks (screen stats, argwhere, pruning,
                // multinomial growth, bounds recomputation). Those operations can
                // stall WebGPU for minutes. Keep the learned Gaussian parameters
                // and optimizer state, only reset accumulated refinement stats.
                trainer.reset_refine_stats_browser(&splats);
                brush_train::train::set_training_diag_stage(220);
                RefineStats {
                    num_added: 0,
                    num_split_oversized: 0,
                    num_split_high_grad: 0,
                    num_pruned: 0,
                    num_pruned_non_finite: 0,
                    total_splats: splats.num_splats(),
                }
            }
            #[cfg(not(target_family = "wasm"))]
            {
                let (new_splats, refine_stats) = trainer.refine(iter, splats).await;
                brush_train::train::set_training_diag_stage(220);
                splats = new_splats;
                refine_stats
            }
'''
new = '''            #[cfg(target_family = "wasm")]
            {
                // v0.3c8 bounded browser densification. Full Brush refinement is
                // restored, but the frontend schedules it only every ~1600 steps,
                // limits growth to 5-8%, and caps total splats by device class.
                // This keeps the expensive GPU -> CPU refinement readbacks rare
                // instead of performing them every few dozen iterations.
                let (new_splats, refine_stats) = trainer.refine(iter, splats).await;
                brush_train::train::set_training_diag_stage(220);
                splats = new_splats;
                refine_stats
            }
            #[cfg(not(target_family = "wasm"))]
            {
                let (new_splats, refine_stats) = trainer.refine(iter, splats).await;
                brush_train::train::set_training_diag_stage(220);
                splats = new_splats;
                refine_stats
            }
'''
s = replace_once(s, old, new, 'restore bounded wasm densification')
p.write_text(s)


# ---- 360GS frontend: adaptive training plan ----
p = Path('training.js')
s = p.read_text()

old_plan = '''function trPlan(size){
  const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4,seed=trSeedBudget();
  if(m>=12&&c>=8)return{iters:3200,max:Math.max(60000,seed),res:Math.min(size,512),seed,label:'品質優先'};
  if(m>=8&&c>=6)return{iters:2800,max:Math.max(50000,seed),res:Math.min(size,512),seed,label:'品質優先'};
  return{iters:2200,max:Math.max(32000,seed),res:Math.min(size,384),seed,label:'省メモリ品質'};
}
'''
new_plan = '''function trPlan(size){
  const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4,seed=trSeedBudget();
  if(m>=12&&c>=8)return{iters:7200,minIters:4800,max:Math.max(60000,seed),res:Math.min(size,512),seed,label:'高品質・限定densification',refineEvery:1600,growthStop:3600,growthFraction:.08,evalEvery:800,plateauDb:.15,plateauSsim:.008};
  if(m>=8&&c>=6)return{iters:6400,minIters:4800,max:Math.max(50000,seed),res:Math.min(size,512),seed,label:'品質優先・限定densification',refineEvery:1600,growthStop:3600,growthFraction:.07,evalEvery:800,plateauDb:.15,plateauSsim:.008};
  return{iters:4800,minIters:3600,max:Math.max(36000,seed),res:Math.min(size,384),seed,label:'省メモリ・限定densification',refineEvery:1600,growthStop:2000,growthFraction:.05,evalEvery:600,plateauDb:.12,plateauSsim:.006};
}
function trShouldEarlyStop(plan){
  const h=trEvalHistory.filter(x=>Number.isFinite(x?.psnr)&&Number.isFinite(x?.ssim)&&Number.isFinite(x?.iter));
  if(h.length<3)return null;
  const a=h[h.length-3],b=h[h.length-2],c=h[h.length-1];
  if(c.iter<plan.minIters)return null;
  if(c.iter<=plan.growthStop)return null;
  const psnrGain=c.psnr-a.psnr,ssimGain=c.ssim-a.ssim;
  const monotonicEnough=c.psnr<=b.psnr+plan.plateauDb&&b.psnr<=a.psnr+plan.plateauDb;
  if(psnrGain<plan.plateauDb&&ssimGain<plan.plateauSsim&&monotonicEnough){
    return `未学習画像の改善が直近2評価で停滞しました（PSNR ${psnrGain.toFixed(2)} dB / SSIM ${ssimGain.toFixed(3)}）。過学習と無駄なGPU計算を避けるため ${c.iter.toLocaleString()} 回で自動終了します。`;
  }
  return null;
}
'''
s = replace_once(s, old_plan, new_plan, 'adaptive c8 plan')

# Ensure both the JS glue and wasm binary get an unambiguous c8 cache key.
s = s.replace("`${TR_BRUSH}?v=0.3c4`", "`${TR_BRUSH}?v=0.3c8`")
s = s.replace("brush_js_bg.wasm?v=0.3c7", "brush_js_bg.wasm?v=0.3c8")

old_refine = "  if(k==='RefineStep'&&msg.numSplats!=null)p.querySelector('#train-splats').textContent=Number(msg.numSplats).toLocaleString();\n"
new_refine = "  if(k==='RefineStep'&&msg.numSplats!=null){const n=Number(msg.numSplats);p.querySelector('#train-splats').textContent=n.toLocaleString();trLog(`Bounded densification/refinement complete: ${n.toLocaleString()} Gaussians`);}\n"
s = replace_once(s, old_refine, new_refine, 'refine event log')

# Diagnostic labels now describe the real operation instead of the c7 stats reset.
s = s.replace("210:'ブラウザ向け固定Gaussian更新を実行しています'", "210:'限定Gaussian densification・pruningを実行しています'")
s = s.replace("220:'固定Gaussian更新が完了しました'", "220:'限定Gaussian densification・pruningが完了しました'")

old_cfg = '''      const refineEvery=Math.max(32,Math.min(64,Math.max(1,Math.round(ds.views/10))*10));
      if('refine-every'in c)c['refine-every']=refineEvery;
      if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));if('sh-degree'in c)c['sh-degree']=0;
      trLog(`Training config: ${plan.iters} iterations / ${ds.seedCount.toLocaleString()} BA/SfM-informed seed Gaussians / ${plan.res}px / SH degree 0 / source-position hold-out every 6th group / eval every ${Math.max(500,Math.floor(plan.iters/4))} steps / browser refine stats reset every ${refineEvery}`);
'''
new_cfg = '''      if('refine-every'in c)c['refine-every']=plan.refineEvery;
      if('growth-stop-iter'in c)c['growth-stop-iter']=plan.growthStop;
      if('growth-select-fraction'in c)c['growth-select-fraction']=plan.growthFraction;
      if('split-at-screen-size'in c)c['split-at-screen-size']=.5;
      if('eval-every'in c)c['eval-every']=plan.evalEvery;
      if('sh-degree'in c)c['sh-degree']=0;
      trLog(`Training config: ${plan.iters} max iterations / early-stop after ${plan.minIters} / ${ds.seedCount.toLocaleString()} BA/SfM-informed seed Gaussians / max ${plan.max.toLocaleString()} Gaussians / ${plan.res}px / SH degree 0 / source-position hold-out every 6th group / eval every ${plan.evalEvery} / bounded refine every ${plan.refineEvery} until ${plan.growthStop} / growth fraction ${(plan.growthFraction*100).toFixed(0)}%`);
'''
s = replace_once(s, old_cfg, new_cfg, 'c8 bounded densification config')

# Refinement can legitimately take longer than ordinary optimizer batches, but still abort safely.
s = s.replace("const waitMs=firstStep?300000:180000;", "const waitMs=firstStep?300000:240000;")

old_loop = '''      if(!msgs.length)break;
      if(firstStep){
        firstStep=false;
        trLog('First GPU training step completed');
      }
      await new Promise(r=>setTimeout(r,0));
'''
new_loop = '''      if(!msgs.length)break;
      if(firstStep){
        firstStep=false;
        trLog('First GPU training step completed');
      }
      const earlyStop=trShouldEarlyStop(plan);
      if(earlyStop){
        done=true;
        trLog(`Adaptive stop: ${earlyStop}`);
        trProgress(96,'評価値の停滞を確認したため学習を自動終了しました');
        break;
      }
      await new Promise(r=>setTimeout(r,0));
'''
s = replace_once(s, old_loop, new_loop, 'adaptive early stop loop')

# Update result interpretation to match the c8 experiment.
s = s.replace(
    '固定seed Gaussian・SH degree 0・densificationなしによる表現力または最適化不足を引き続き評価します。',
    'BA/SfM seed・限定densificationを使用しても学習画像への適合が低いため、次は入力視点密度、カメラ幾何、解像度、SH degreeを個別に評価します。'
)
s = s.replace(
    'Gaussian scaleの極端な膨張は目立ちません。BA/SfM情報で増量した固定seed Gaussian・densificationなし・SH degree 0でなお表現力または最適化が不足している可能性を確認します。',
    'Gaussian scaleの極端な膨張は目立ちません。BA/SfM seedと限定densification後のため、残るぼけは視点密度・幾何・解像度・SH degree・最適化収束を切り分けます。'
)

# Truthful plan display: the number is now a maximum because adaptive stopping is active.
s = s.replace("p.querySelector('#train-plan').textContent=`${plan.label} ${plan.iters.toLocaleString()}回`;", "p.querySelector('#train-plan').textContent=`${plan.label} 最大${plan.iters.toLocaleString()}回`;")

# Version all runtime-visible files and all local cache keys.
s = s.replace('v0.3c7', 'v0.3c8').replace('v=0.3c7', 'v=0.3c8').replace('v=0.3c4', 'v=0.3c8')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q=Path(name)
    if not q.exists():
        continue
    t=q.read_text()
    for oldv in ['v0.3c5','v0.3c6','v0.3c7']:
        t=t.replace(oldv,'v0.3c8')
    for oldq in ['v=0.3c4','v=0.3c5','v=0.3c6','v=0.3c7']:
        t=t.replace(oldq,'v=0.3c8')
    q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c8\n'
    'Browser-bounded densification + adaptive convergence stopping\n'
    'Brush runtime: compatibility pin 3b80985709e2ec04fd6c8622a40e36473647a8e0\n'
    'Upstream Brush 1.0.0 reviewed 2026-08-16; migration intentionally isolated from this quality experiment\n'
    'Build date: 2026-08-16\n'
)
