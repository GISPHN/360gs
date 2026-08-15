from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c0: keep normal Brush optimization in the browser, but replace the
# heavyweight refine/prune/densify pass with a fixed-budget stats reset on
# wasm. The native Brush path remains unchanged.

# ---- brush-train: lightweight browser refinement-state reset ----
p = Path('_brush/crates/brush-train/src/train.rs')
s = p.read_text()
anchor = '''    pub async fn refine(&mut self, iter: u32, splats: Splats) -> (Splats, RefineStats) {
'''
insert = '''    pub fn reset_refine_stats_browser(&mut self, splats: &Splats) {
        set_training_diag_stage(211);
        let device = splats.device();
        self.refine_record = Some(RefineRecord::new(splats.num_splats(), &device));
        set_training_diag_stage(219);
    }

    pub async fn refine(&mut self, iter: u32, splats: Splats) -> (Splats, RefineStats) {
'''
s = replace_once(s, anchor, insert, 'browser refine stats reset method')
p.write_text(s)

# ---- brush-process: use fixed-Gaussian refinement on wasm only ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
old = '''        {
            brush_train::train::set_training_diag_stage(210);
            let (new_splats, refine_stats) = trainer.refine(iter, splats).await;
            brush_train::train::set_training_diag_stage(220);
            splats = new_splats;
            refine_stats
        } else {
'''
new = '''        {
            brush_train::train::set_training_diag_stage(210);
            #[cfg(target_family = "wasm")]
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
        } else {
'''
s = replace_once(s, old, new, 'wasm fixed Gaussian refine path')
p.write_text(s)

# ---- 360GS front-end: version and truthful status labels ----
p = Path('training.js')
s = p.read_text().replace('v0.3b9', 'v0.3c0').replace('v=0.3b9', 'v=0.3c0')
s = replace_once(
    s,
    "    200:'GPU学習1ステップの内部処理が完了しました',\n    210:'Gaussianのrefinement・densificationを実行しています',\n    220:'Gaussianのrefinement・densificationが完了しました'\n",
    "    200:'GPU学習1ステップの内部処理が完了しました',\n    210:'ブラウザ向け固定Gaussian更新を実行しています',\n    211:'refinement統計をリセットしています',\n    219:'refinement統計のリセットが完了しました',\n    220:'固定Gaussian更新が完了しました'\n",
    'fixed Gaussian diagnostic labels',
)
s = replace_once(
    s,
    "      trLog(`Training config: ${plan.iters} iterations / max ${plan.max.toLocaleString()} splats / ${plan.res}px / SH degree 0 / refine every ${refineEvery} / random initialization`);\n",
    "      trLog(`Training config: ${plan.iters} iterations / fixed browser Gaussian budget / ${plan.res}px / SH degree 0 / stats reset every ${refineEvery} / random initialization`);\n",
    'fixed Gaussian config log',
)
p.write_text(s)

for name in ['video.html', 'index.html', 'README.md']:
    q = Path(name)
    if q.exists():
        t = q.read_text().replace('v0.3b9', 'v0.3c0').replace('v=0.3b9', 'v=0.3c0')
        q.write_text(t)
