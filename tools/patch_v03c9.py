from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c9: browser-safe growth after the first c8 field test showed that the
# full Brush refine() path still stalls on WebAssembly/WebGPU at ~30k splats.
#
# The c8 field log reached the first refine boundary, entered diagnostic stage
# 210, then exceeded the 4 minute safety timeout before returning. Upstream
# refine() performs several GPU->CPU readbacks (screen statistics, pruning,
# argwhere, growth weights, and bounds recomputation). c9 removes those host
# readbacks from the browser refinement path while preserving bounded Gaussian
# growth and the existing optimizer state.
#
# Browser c9 behavior:
# - no full prune pass during training;
# - no GPU->CPU statistics/readback during growth;
# - split a small deterministic subset of the first 35% of splats, matching
#   360GS hybrid initialization where the first 35% are BA/SfM track-anchored;
# - keep growth capped by max_splats and growth_select_fraction;
# - stop adding Gaussians at growth_stop_iter even though later refine ticks
#   still reset accumulated refinement state;
# - preserve c8 long-horizon training, grouped holdout, and adaptive stopping;
# - keep SH degree 0 so the quality comparison remains interpretable.


# ---- brush-train: add GPU-only browser growth path ----
p = Path('_brush/crates/brush-train/src/train.rs')
s = p.read_text()
anchor = '''    pub async fn refine(&mut self, iter: u32, splats: Splats) -> (Splats, RefineStats) {
'''
method = '''    #[cfg(target_family = "wasm")]
    pub fn refine_browser_growth_only(
        &mut self,
        iter: u32,
        mut splats: Splats,
    ) -> (Splats, RefineStats) {
        // c9 intentionally avoids every GPU -> CPU readback in refine().
        // The 360GS init.ply writer stores BA/SfM track-anchored splats first,
        // occupying 35% of the initial budget. Split a small deterministic
        // subset of that trusted pool and append children on the GPU.
        set_training_diag_stage(212);

        let current = splats.num_splats();
        let headroom = self.config.max_splats.saturating_sub(current);
        let requested = ((current as f32) * self.config.growth_select_fraction)
            .round()
            .max(0.0) as u32;
        let grow_count = if iter < self.config.growth_stop_iter {
            requested.min(headroom)
        } else {
            0
        };

        let refiner = self
            .refine_record
            .take()
            .expect("Can only refine if refine stats are initialized");
        let record = self
            .optim
            .take()
            .expect("Can only refine after optimizer is initialized")
            .to_record();

        if grow_count == 0 || current == 0 {
            self.optim = Some(create_optimizer_from_config().load_record(record));
            return (
                splats,
                RefineStats {
                    num_added: 0,
                    num_split_oversized: 0,
                    num_split_high_grad: 0,
                    num_pruned: 0,
                    num_pruned_non_finite: 0,
                    total_splats: current,
                },
            );
        }

        // Initial 360GS seeds are ordered as 35% track-anchored samples,
        // followed by camera-ray samples. New children are appended, so using
        // the first 35% continues to target the original geometry-backed pool.
        let trusted_pool = ((current as f32) * 0.35).round().max(1.0) as u32;
        let trusted_pool = trusted_pool.min(current);
        let take = grow_count.min(trusted_pool);

        // Evenly distribute selected indices through the trusted pool. Shift
        // the phase at each refine boundary so repeated growth does not split
        // exactly the same parents. No device readback is required.
        let phase = ((iter as u64 * 2654435761u64) % trusted_pool as u64) as u32;
        let mut split_inds = HashSet::with_capacity(take as usize);
        for k in 0..take {
            let base = (((k as u64 * trusted_pool as u64) / take as u64) as u32)
                .wrapping_add(phase)
                % trusted_pool;
            split_inds.insert(base as i32);
        }

        set_training_diag_stage(214);
        let device = splats.device();
        let screen_sizes = refiner.max_screen_size.clone();
        splats = self.refine_splats(&device, record, splats, split_inds, screen_sizes, iter);
        set_training_diag_stage(216);

        let total = splats.num_splats();
        (
            splats,
            RefineStats {
                num_added: total.saturating_sub(current),
                num_split_oversized: 0,
                num_split_high_grad: total.saturating_sub(current),
                num_pruned: 0,
                num_pruned_non_finite: 0,
                total_splats: total,
            },
        )
    }

'''
s = replace_once(s, anchor, method + anchor, 'GPU-only browser growth method')
p.write_text(s)


# ---- brush-process: use GPU-only growth on wasm instead of full refine ----
p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
old = '''            #[cfg(target_family = "wasm")]
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
'''
new = '''            #[cfg(target_family = "wasm")]
            {
                // v0.3c9 browser-safe growth. Do not call the full Brush
                // refine() path here: its GPU -> CPU readbacks stalled the c8
                // field test at the first 30k-splat refine boundary. Instead,
                // split a bounded geometry-backed subset entirely on the GPU.
                let (new_splats, refine_stats) = trainer.refine_browser_growth_only(iter, splats);
                brush_train::train::set_training_diag_stage(220);
                splats = new_splats;
                refine_stats
            }
'''
s = replace_once(s, old, new, 'replace wasm full refine with GPU-only growth')
p.write_text(s)


# ---- frontend: truthful labels, no screen-size force split, c9 cache keys ----
p = Path('training.js')
s = p.read_text()

s = s.replace("label:'高品質・限定densification'", "label:'高品質・GPU内軽量growth'")
s = s.replace("label:'品質優先・限定densification'", "label:'品質優先・GPU内軽量growth'")
s = s.replace("label:'省メモリ・限定densification'", "label:'省メモリ・GPU内軽量growth'")

s = replace_once(
    s,
    "      if('split-at-screen-size'in c)c['split-at-screen-size']=.5;\n",
    "      if('split-at-screen-size'in c)c['split-at-screen-size']=0;\n",
    'disable screen-size split for wasm-safe growth',
)

s = s.replace(
    'bounded refine every ${plan.refineEvery} until ${plan.growthStop} / growth fraction ${(plan.growthFraction*100).toFixed(0)}%',
    'GPU-only growth every ${plan.refineEvery} until ${plan.growthStop} / growth fraction ${(plan.growthFraction*100).toFixed(0)}% / browser pruning disabled during training'
)

s = s.replace(
    "if(k==='RefineStep'&&msg.numSplats!=null){const n=Number(msg.numSplats);p.querySelector('#train-splats').textContent=n.toLocaleString();trLog(`Bounded densification/refinement complete: ${n.toLocaleString()} Gaussians`);}",
    "if(k==='RefineStep'&&msg.numSplats!=null){const n=Number(msg.numSplats);p.querySelector('#train-splats').textContent=n.toLocaleString();trLog(`GPU-only bounded growth complete: ${n.toLocaleString()} Gaussians`);}"
)

s = s.replace("210:'限定Gaussian densification・pruningを実行しています'", "210:'GPU内軽量Gaussian growthを開始しています'")
s = s.replace("220:'限定Gaussian densification・pruningが完了しました'", "220:'GPU内軽量Gaussian growthが完了しました'")
s = replace_once(
    s,
    "    211:'refinement統計をリセットしています',\n    219:'refinement統計のリセットが完了しました',\n",
    "    211:'refinement統計をリセットしています',\n    212:'追加Gaussianの対象をCPU readbackなしで選択しています',\n    214:'GaussianとOptimizer状態をGPU上で分割しています',\n    216:'GPU内Gaussian分割が完了しました',\n    219:'refinement統計のリセットが完了しました',\n",
    'c9 growth diagnostic labels',
)

s = s.replace(
    'BA/SfM seed・限定densificationを使用しても学習画像への適合が低いため',
    'BA/SfM seed・GPU内軽量growthを使用しても学習画像への適合が低いため'
)
s = s.replace(
    'BA/SfM seedと限定densification後のため',
    'BA/SfM seedとGPU内軽量growth後のため'
)

# Runtime and frontend cache keys.
s = s.replace('v0.3c8', 'v0.3c9').replace('v=0.3c8', 'v=0.3c9')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q = Path(name)
    if not q.exists():
        continue
    t = q.read_text().replace('v0.3c8', 'v0.3c9').replace('v=0.3c8', 'v=0.3c9')
    q.write_text(t)

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c9\n'
    'GPU-only bounded Gaussian growth without browser refine readbacks\n'
    'Fixes c8 field stall at the first ~1600-iteration densification boundary\n'
    'Brush runtime: compatibility pin 3b80985709e2ec04fd6c8622a40e36473647a8e0\n'
    'Browser growth: no training-time pruning, no argwhere/readback, no bounds recomputation\n'
    'Build date: 2026-08-16\n'
)