from pathlib import Path

p = Path('_brush/apps/brush-js/src/lib.rs')
s = p.read_text()
needle = '                    out.push(BrushMessage { inner: msg });\n'
assert needle in s, 'brush-js progress patch target not found'
s = s.replace(needle, needle + '                    if steps == 0 { return Ok(out); }\n', 1)
p.write_text(s)

p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()

def emit(stage: str, indent: str = '    ') -> str:
    return (
        f'{indent}emitter\n'
        f'{indent}    .emit(ProcessMessage::Warning {{ error: anyhow::anyhow!("360GS_STAGE: {stage}") }})\n'
        f'{indent}    .await;\n'
    )

needle = '    // Start with memory cleared out.\n'
assert needle in s, 'post-loading target not found'
s = s.replace(needle, emit('post_loading_enter') + '\n' + needle, 1)

needle = '    let bounds = get_splat_bounds(init_splats.clone(), BOUND_PERCENTILE).await;\n'
assert needle in s, 'bounds target not found'
s = s.replace(needle, emit('bounds_begin') + needle + emit('bounds_done'), 1)

needle = '    let mut view_cams: Vec<(glam::Vec3, f32)> = Vec::with_capacity(dataset.train.views.len());\n'
assert needle in s, 'view cams target not found'
s = s.replace(needle, emit('view_cams_begin') + needle, 1)

needle = '    let mut trainer = SplatTrainer::new(&train_stream_config.train_config, &device, bounds);\n'
assert needle in s, 'trainer target not found'
s = s.replace(needle, emit('view_cams_done') + needle + emit('trainer_ready'), 1)

needle = (
    '        let batch = dataloader\n'
    '            .next_batch()\n'
    '            .instrument(trace_span!("Wait for next data batch"))\n'
    '            .await;\n'
)
assert needle in s, 'batch target not found'
s = s.replace(
    needle,
    '        if iter == process_config.start_iter {\n'
    + emit('first_batch_begin', '            ')
    + '        }\n'
    + needle
    + '        if iter == process_config.start_iter {\n'
    + emit('first_batch_ready', '            ')
    + '        }\n',
    1,
)

needle = '        let diff_splats = brush_render::bwd::burn_glue::lift_splats_to_autodiff(splats);\n'
assert needle in s, 'autodiff target not found'
s = s.replace(
    needle,
    '        if iter == process_config.start_iter {\n'
    + emit('autodiff_begin', '            ')
    + '        }\n'
    + needle
    + '        if iter == process_config.start_iter {\n'
    + emit('autodiff_ready', '            ')
    + '        }\n',
    1,
)

needle = '        let (new_diff_splats, stats) = trainer.step(batch, diff_splats).await;\n'
assert needle in s, 'trainer step target not found'
s = s.replace(
    needle,
    '        if iter == process_config.start_iter {\n'
    + emit('trainer_step_begin', '            ')
    + '        }\n'
    + needle
    + '        if iter == process_config.start_iter {\n'
    + emit('trainer_step_done', '            ')
    + '        }\n',
    1,
)

p.write_text(s)
