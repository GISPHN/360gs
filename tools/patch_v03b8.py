from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3b8 deliberately targets the pre-Spring-clean Brush commit
# 3b80985709e2ec04fd6c8622a40e36473647a8e0.  Keep the diagnostic
# patch small so we can distinguish an upstream WebGPU regression from
# application-side behaviour.

# ---- brush-train: fine-grained first-step diagnostics ----
p = Path('_brush/crates/brush-train/src/train.rs')
s = p.read_text()
s = replace_once(
    s,
    'use std::f32::consts::FRAC_1_SQRT_2;\n',
    'use std::f32::consts::FRAC_1_SQRT_2;\nuse std::sync::atomic::{AtomicU32, Ordering};\n\nstatic TRAINING_DIAG_STAGE: AtomicU32 = AtomicU32::new(0);\n\npub fn training_diag_stage() -> u32 {\n    TRAINING_DIAG_STAGE.load(Ordering::Relaxed)\n}\n\nfn set_training_diag_stage(stage: u32) {\n    TRAINING_DIAG_STAGE.store(stage, Ordering::Relaxed);\n}\n',
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
    '            let loss_inner = loss.clone().inner();\n            let mut grads = splats.bwd_validate(loss).await;\n',
    '            set_training_diag_stage(145);\n            let loss_inner = loss.clone().inner();\n            set_training_diag_stage(146);\n            set_training_diag_stage(150);\n            let mut grads = splats.bwd_validate(loss).await;\n            set_training_diag_stage(160);\n',
    'loss detach and backward',
)
p.write_text(s)

# ---- brush-process: expose diagnostic stage ----
p = Path('_brush/crates/brush-process/src/lib.rs')
s = p.read_text()
s = replace_once(
    s,
    'pub async fn wait_for_device() -> &\'static WgpuDevice {\n    DEVICE.wait().await\n}\n',
    'pub async fn wait_for_device() -> &\'static WgpuDevice {\n    DEVICE.wait().await\n}\n\npub fn training_diag_stage() -> u32 {\n    brush_train::train::training_diag_stage()\n}\n',
    'brush-process diagnostic re-export',
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

# ---- 360GS front-end: use v0.3b8 runtime and expose finer stages ----
p = Path('training.js')
s = p.read_text().replace('v0.3b7', 'v0.3b8').replace('v=0.3b7', 'v=0.3b8')
s = replace_once(
    s,
    "    140:'画像損失の構築が完了しました',\n    150:'逆伝播を実行しています',\n",
    "    140:'画像損失マップの構築が完了しました',\n    141:'画像損失をスカラーへ集約しています',\n    142:'画像損失の集約が完了しました',\n    145:'損失テンソルを確定しています',\n    146:'損失テンソルの確定が完了しました',\n    150:'逆伝播を実行しています',\n",
    'fine diagnostic labels',
)
old_progress_probe = "let progressApi=false;try{const info=await fetch('./vendor/brush-js/BUILD_INFO.txt?v=0.3b8',{cache:'no-store'});progressApi=(await info.text()).includes('trainSteps(0)');}catch{}"
if old_progress_probe in s:
    s = s.replace(
        old_progress_probe,
        "const progressApi=typeof mod.trainingDiagStage==='function';",
        1,
    )
p.write_text(s)

for name in ['video.html', 'index.html', 'README.md']:
    q = Path(name)
    if q.exists():
        t = q.read_text().replace('v0.3b7', 'v0.3b8').replace('v=0.3b7', 'v=0.3b8')
        q.write_text(t)
