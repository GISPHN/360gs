from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)

# ---- brush-train: expose an atomic stage that JS can poll while trainSteps() is pending ----
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
    'loss begin/end',
)
s = replace_once(
    s,
    '            let loss_inner = loss.clone().inner();\n            let mut grads = splats.bwd_validate(loss).await;\n',
    '            let loss_inner = loss.clone().inner();\n            set_training_diag_stage(150);\n            let mut grads = splats.bwd_validate(loss).await;\n            set_training_diag_stage(160);\n',
    'backward begin/end',
)
s = replace_once(
    s,
    '        splats = trace_span!("Optimizer step").in_scope(|| {\n',
    '        set_training_diag_stage(170);\n        splats = trace_span!("Optimizer step").in_scope(|| {\n',
    'optimizer begin',
)
s = replace_once(
    s,
    '        // Add random noise. Only do this in the growth phase, otherwise\n',
    '        set_training_diag_stage(180);\n\n        // Add random noise. Only do this in the growth phase, otherwise\n',
    'optimizer done',
)
s = replace_once(
    s,
    '        let inv_opac: Tensor<1> = 1.0 - splats.valid().opacities();\n',
    '        set_training_diag_stage(190);\n        let inv_opac: Tensor<1> = 1.0 - splats.valid().opacities();\n',
    'noise begin',
)
s = replace_once(
    s,
    '        let stats = TrainStepStats {\n',
    '        set_training_diag_stage(200);\n        let stats = TrainStepStats {\n',
    'step done',
)
p.write_text(s)

# ---- brush-process: re-export the stage without coupling JS directly to brush-train ----
p = Path('_brush/crates/brush-process/src/lib.rs')
s = p.read_text()
s = replace_once(
    s,
    'pub async fn wait_for_device() -> &\'static WgpuDevice {\n    DEVICE.wait().await\n}\n',
    'pub async fn wait_for_device() -> &\'static WgpuDevice {\n    DEVICE.wait().await\n}\n\npub fn training_diag_stage() -> u32 {\n    brush_train::training_diag_stage()\n}\n',
    'brush-process diagnostic re-export',
)
p.write_text(s)

# ---- brush-js: export a synchronous polling API ----
p = Path('_brush/apps/brush-js/src/lib.rs')
s = p.read_text()
s = replace_once(
    s,
    'use web_sys::js_sys;\n\n#[wasm_bindgen]\n#[derive(Clone, Copy, Debug)]\n',
    'use web_sys::js_sys;\n\n#[wasm_bindgen(js_name = trainingDiagStage)]\npub fn training_diag_stage() -> u32 {\n    brush_process::training_diag_stage()\n}\n\n#[wasm_bindgen]\n#[derive(Clone, Copy, Debug)]\n',
    'brush-js diagnostic export',
)
# Keep the staged progress patch from v0.3b6.
needle = '                    out.push(BrushMessage { inner: msg });\n'
if 'if steps == 0 { return Ok(out); }' not in s:
    s = replace_once(s, needle, needle + '                    if steps == 0 { return Ok(out); }\n', 'trainSteps(0) progress')
p.write_text(s)

# ---- 360GS front-end: poll the stage once per second while the GPU promise is pending ----
p = Path('training.js')
s = p.read_text()
s = s.replace('?v=0.3b6', '?v=0.3b7').replace('Prototype v0.3b6', 'Prototype v0.3b7')

anchor = "async function trWaitStage(promise, timeoutMs, label, training, rt){\n"
diag_fn = """function trDiagStageLabel(stage){
  const labels={
    100:'Brush trainer.step に入りました',
    110:'Gaussianを画像へレンダリングしています',
    120:'Gaussianレンダリングが完了しました',
    130:'画像損失を構築しています',
    140:'画像損失の構築が完了しました',
    150:'逆伝播を実行しています',
    160:'逆伝播が完了しました',
    170:'OptimizerでGaussianを更新しています',
    180:'Optimizer更新が完了しました',
    190:'Gaussianの探索ノイズを更新しています',
    200:'最初の学習ステップ内部処理が完了しました'
  };
  return labels[stage]||'';
}

"""
if 'function trDiagStageLabel(stage)' not in s:
    s = replace_once(s, anchor, diag_fn + anchor, 'JS diagnostic label function')

s = replace_once(s, '  let timer,heartbeat;\n', '  let timer,heartbeat,lastDiagStage=-1;\n', 'diagnostic timer state')
old_tick = """    const base=label.includes('GPU')?20:12;
    trProgress(base,`${label}を実行中（${sec}秒 / 最大${maxSec}秒）`);
"""
new_tick = """    const base=label.includes('GPU')?20:12;
    let detail='';
    if(label.includes('GPU')&&typeof rt?.mod?.trainingDiagStage==='function'){
      const stage=Number(rt.mod.trainingDiagStage());
      const stageLabel=trDiagStageLabel(stage);
      if(stage!==lastDiagStage){
        lastDiagStage=stage;
        if(stageLabel)trLog(`GPU internal stage ${stage}: ${stageLabel}`);
      }
      if(stageLabel)detail=` / ${stageLabel}`;
    }
    trProgress(base,`${label}を実行中（${sec}秒 / 最大${maxSec}秒）${detail}`);
"""
s = replace_once(s, old_tick, new_tick, 'heartbeat diagnostic polling')

# Log adapter identity when exposed by the browser.
old_adapter = "const ad=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!ad)throw new Error('WebGPUアダプターを取得できません。');"
new_adapter = "const ad=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!ad)throw new Error('WebGPUアダプターを取得できません。');const ai=ad.info||{};trLog(`WebGPU adapter: ${ai.vendor||'unknown'} / ${ai.architecture||ai.device||ai.description||'unknown'}`);"
s = replace_once(s, old_adapter, new_adapter, 'adapter info log')
p.write_text(s)

for name in ['video.html', 'index.html', 'README.md']:
    q = Path(name)
    if q.exists():
        t = q.read_text().replace('v0.3b6', 'v0.3b7').replace('v=0.3b6', 'v=0.3b7')
        q.write_text(t)
