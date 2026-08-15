from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3b9 keeps the pre-Spring-clean Brush runtime used by v0.3b8,
# but tunes refinement cadence for the small browser dataset and adds
# diagnostics after backward so long-running WebGPU work can be localized.

# ---- brush-train: detailed post-backward diagnostics ----
p = Path('_brush/crates/brush-train/src/train.rs')
s = p.read_text()
s = replace_once(
    s,
    'use std::f32::consts::FRAC_1_SQRT_2;\n',
    'use std::f32::consts::FRAC_1_SQRT_2;\nuse std::sync::atomic::{AtomicU32, Ordering};\n\nstatic TRAINING_DIAG_STAGE: AtomicU32 = AtomicU32::new(0);\n\npub fn training_diag_stage() -> u32 {\n    TRAINING_DIAG_STAGE.load(Ordering::Relaxed)\n}\n\npub fn set_training_diag_stage(stage: u32) {\n    TRAINING_DIAG_STAGE.store(stage, Ordering::Relaxed);\n}\n',
    'atomic diagnostic stage',
)
s = replace_once(
    s,
    '    pub async fn step(&mut self, batch: SceneBatch, splats: Splats) -> (Splats, TrainStepStats) {\n        let mut splats = splats;\n',
    '    pub async fn step(&mut self, batch: SceneBatch, splats: Splats) -> (Splats, TrainStepStats) {\n        set_training_diag_stage(100);\n        let mut splats = splats;\n',
    'step entry',
)
s = replace_once(
    s,
    '            let render_input = splats.clone();\n            let diff_out = render_splats(render_input, &camera, img_size, background)\n                .instrument(trace_span!("Forward"))\n                .await;\n',
    '            set_training_diag_stage(110);\n            let render_input = splats.clone();\n            let diff_out = render_splats(render_input, &camera, img_size, background)\n                .instrument(trace_span!("Forward"))\n                .await;\n            set_training_diag_stage(120);\n',
    'render begin/end',
)
s = replace_once(
    s,
    '            let loss_map = image_loss(pred_for_loss, gt_packed.clone(), cfg);\n',
    '            set_training_diag_stage(130);\n            let loss_map = image_loss(pred_for_loss, gt_packed.clone(), cfg);\n            set_training_diag_stage(140);\n',
    'loss map begin/end',
)
loss_block = '''            #[cfg_attr(target_family = "wasm", allow(unused_mut))]
            let mut loss = if do_alpha_match {
                let rgb = loss_map.clone().slice(s![.., .., 0..3]).mean();
                let alpha = loss_map.slice(s![.., .., 3..4]).mean();
                rgb + alpha * self.config.match_alpha_weight
            } else {
                loss_map.mean()
            };
'''
loss_block_diag = '''            set_training_diag_stage(141);
            #[cfg_attr(target_family = "wasm", allow(unused_mut))]
            let mut loss = if do_alpha_match {
                let rgb = loss_map.clone().slice(s![.., .., 0..3]).mean();
                let alpha = loss_map.slice(s![.., .., 3..4]).mean();
                rgb + alpha * self.config.match_alpha_weight
            } else {
                loss_map.mean()
            };
            set_training_diag_stage(142);
'''
s = replace_once(s, loss_block, loss_block_diag, 'loss reduction begin/end')
s = replace_once(
    s,
    '            let loss_inner = loss.clone().inner();\n            let mut grads = splats.bwd_validate(loss).await;\n\n            trace_span!("Housekeeping").in_scope(|| {\n',
    '            set_training_diag_stage(145);\n            let loss_inner = loss.clone().inner();\n            set_training_diag_stage(146);\n            set_training_diag_stage(150);\n            let mut grads = splats.bwd_validate(loss).await;\n            set_training_diag_stage(160);\n\n            set_training_diag_stage(161);\n            trace_span!("Housekeeping").in_scope(|| {\n',
    'backward and housekeeping begin',
)
s = replace_once(
    s,
    '            });\n\n            (grads, visible, diff_out.num_visible, loss_inner)\n        };\n\n        // OptimizerAdaptor strips autodiff before calling SimpleOptimizer::step,\n',
    '            });\n            set_training_diag_stage(162);\n\n            (grads, visible, diff_out.num_visible, loss_inner)\n        };\n\n        set_training_diag_stage(165);\n        // OptimizerAdaptor strips autodiff before calling SimpleOptimizer::step,\n',
    'housekeeping end and optimizer setup begin',
)
s = replace_once(
    s,
    '            *optimizer = create_optimizer_from_config().load_record(record);\n        }\n\n        splats = trace_span!("Optimizer step").in_scope(|| {\n            splats = trace_span!("Transforms step").in_scope(|| {\n                let grad_transforms =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.transforms.id]);\n                optimizer.step(1.0, splats, grad_transforms)\n            });\n            splats = trace_span!("SH Coeffs step").in_scope(|| {\n                let grad_coeff =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.sh_coeffs.id]);\n                optimizer.step(self.config.lr_coeffs_dc, splats, grad_coeff)\n            });\n            splats = trace_span!("Opacity step").in_scope(|| {\n                let grad_opac =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.raw_opacities.id]);\n                optimizer.step(self.config.lr_opac, splats, grad_opac)\n            });\n            splats\n        });\n\n        // Add random noise. Only do this in the growth phase, otherwise\n',
    '            *optimizer = create_optimizer_from_config().load_record(record);\n        }\n        set_training_diag_stage(166);\n\n        set_training_diag_stage(170);\n        splats = trace_span!("Optimizer step").in_scope(|| {\n            splats = trace_span!("Transforms step").in_scope(|| {\n                let grad_transforms =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.transforms.id]);\n                let out = optimizer.step(1.0, splats, grad_transforms);\n                set_training_diag_stage(171);\n                out\n            });\n            set_training_diag_stage(172);\n            splats = trace_span!("SH Coeffs step").in_scope(|| {\n                let grad_coeff =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.sh_coeffs.id]);\n                let out = optimizer.step(self.config.lr_coeffs_dc, splats, grad_coeff);\n                set_training_diag_stage(173);\n                out\n            });\n            set_training_diag_stage(174);\n            splats = trace_span!("Opacity step").in_scope(|| {\n                let grad_opac =\n                    GradientsParams::from_params(&mut grads, &splats, &[splats.raw_opacities.id]);\n                let out = optimizer.step(self.config.lr_opac, splats, grad_opac);\n                set_training_diag_stage(175);\n                out\n            });\n            splats\n        });\n        set_training_diag_stage(180);\n\n        set_training_diag_stage(190);\n        // Add random noise. Only do this in the growth phase, otherwise\n',
    'optimizer detail stages',
)
s = replace_once(
    s,
    '        splats.transforms = splats.transforms.map(|t| {\n            // Only allow noised gaussians to travel at most the entire extent of the current bounds.\n',
    '        splats.transforms = splats.transforms.map(|t| {\n            // Only allow noised gaussians to travel at most the entire extent of the current bounds.\n',
    'noise block anchor',
)
s = replace_once(
    s,
    '            Tensor::from_inner(out).require_grad()\n        });\n\n        let stats = TrainStepStats {\n',
    '            Tensor::from_inner(out).require_grad()\n        });\n        set_training_diag_stage(195);\n\n        let stats = TrainStepStats {\n',
    'noise end',
)
s = replace_once(
    s,
    '        (splats, stats)\n    }\n\n    pub async fn refine(&mut self, iter: u32, splats: Splats) -> (Splats, RefineStats) {\n',
    '        set_training_diag_stage(200);\n        (splats, stats)\n    }\n\n    pub async fn refine(&mut self, iter: u32, splats: Splats) -> (Splats, RefineStats) {\n',
    'step end',
)
p.write_text(s)

# ---- brush-process: expose diagnostic stage ----
p = Path('_brush/crates/brush-process/src/lib.rs')
s = p.read_text()
s = replace_once(
    s,
    "pub async fn wait_for_device() -> &'static WgpuDevice {\n    DEVICE.wait().await\n}\n",
    "pub async fn wait_for_device() -> &'static WgpuDevice {\n    DEVICE.wait().await\n}\n\npub fn training_diag_stage() -> u32 {\n    brush_train::train::training_diag_stage()\n}\n",
    'brush-process diagnostic re-export',
)
p.write_text(s)

# ---- brush-process training stream: mark refine/densification ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
s = replace_once(
    s,
    '        {\n            let (new_splats, refine_stats) = trainer.refine(iter, splats).await;\n            splats = new_splats;\n            refine_stats\n',
    '        {\n            brush_train::train::set_training_diag_stage(210);\n            let (new_splats, refine_stats) = trainer.refine(iter, splats).await;\n            brush_train::train::set_training_diag_stage(220);\n            splats = new_splats;\n            refine_stats\n',
    'refine begin/end stages',
)
p.write_text(s)

# ---- brush-js: synchronous diagnostic polling + staged trainSteps(0) ----
p = Path('_brush/apps/brush-js/src/lib.rs')
s = p.read_text()
s = replace_once(
    s,
    'use web_sys::js_sys;\n\n#[wasm_bindgen]\n#[derive(Clone, Copy, Debug)]\n',
    'use web_sys::js_sys;\n\n#[wasm_bindgen(js_name = trainingDiagStage)]\npub fn training_diag_stage() -> u32 {\n    brush_process::training_diag_stage()\n}\n\n#[wasm_bindgen]\n#[derive(Clone, Copy, Debug)]\n',
    'brush-js diagnostic export',
)
needle = '                    out.push(BrushMessage { inner: msg });\n'
s = replace_once(
    s,
    needle,
    needle + '                    if steps == 0 { return Ok(out); }\n',
    'trainSteps(0) staged progress',
)
p.write_text(s)

# Avoid wasm-opt --converge in GitHub Actions. The Rust/WASM output is already
# optimized by the release compiler and wasm-opt took >2h on the hosted runner.
p = Path('_brush/apps/brush-js/Cargo.toml')
s = p.read_text()
opt_block = '''[package.metadata.wasm-pack.profile.release]
wasm-opt = [
    "-Oz",
    "--converge",
    "--enable-bulk-memory",
    "--enable-nontrapping-float-to-int",
]
'''
s = replace_once(
    s,
    opt_block,
    '[package.metadata.wasm-pack.profile.release]\nwasm-opt = false\n',
    'disable wasm-opt',
)
p.write_text(s)

# ---- 360GS front-end: browser-scale refinement and detailed labels ----
p = Path('training.js')
s = p.read_text().replace('v0.3b8', 'v0.3b9').replace('v=0.3b8', 'v=0.3b9')
s = replace_once(
    s,
    "    160:'逆伝播が完了しました',\n    170:'OptimizerでGaussianを更新しています',\n    180:'Optimizer更新が完了しました',\n    190:'Gaussianの探索ノイズを更新しています',\n    200:'最初の学習ステップ内部処理が完了しました'\n",
    "    160:'逆伝播が完了しました',\n    161:'refinement用の統計を蓄積しています',\n    162:'refinement用統計の蓄積が完了しました',\n    165:'Optimizerの状態を準備しています',\n    166:'Optimizerの準備が完了しました',\n    170:'位置・回転・スケールを更新しています',\n    171:'位置・回転・スケールの更新が完了しました',\n    172:'色（SH係数）を更新しています',\n    173:'色（SH係数）の更新が完了しました',\n    174:'不透明度を更新しています',\n    175:'不透明度の更新が完了しました',\n    180:'Optimizer更新が完了しました',\n    190:'Gaussianの探索ノイズを更新しています',\n    195:'Gaussian探索ノイズの更新が完了しました',\n    200:'GPU学習1ステップの内部処理が完了しました',\n    210:'Gaussianのrefinement・densificationを実行しています',\n    220:'Gaussianのrefinement・densificationが完了しました'\n",
    'post-backward diagnostic labels',
)
s = replace_once(
    s,
    "      if('max-resolution'in c)c['max-resolution']=plan.res;\n      if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));if('sh-degree'in c)c['sh-degree']=0;\n      trLog(`Training config: ${plan.iters} iterations / max ${plan.max.toLocaleString()} splats / ${plan.res}px / SH degree 0 / random initialization`);\n",
    "      if('max-resolution'in c)c['max-resolution']=plan.res;\n      const refineEvery=Math.max(32,Math.min(64,Math.max(1,Math.round(ds.views/10))*10));\n      if('refine-every'in c)c['refine-every']=refineEvery;\n      if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));if('sh-degree'in c)c['sh-degree']=0;\n      trLog(`Training config: ${plan.iters} iterations / max ${plan.max.toLocaleString()} splats / ${plan.res}px / SH degree 0 / refine every ${refineEvery} / random initialization`);\n",
    'browser refinement cadence',
)
p.write_text(s)

for name in ['video.html', 'index.html', 'README.md']:
    q = Path(name)
    if q.exists():
        t = q.read_text().replace('v0.3b8', 'v0.3b9').replace('v=0.3b8', 'v=0.3b9')
        q.write_text(t)
