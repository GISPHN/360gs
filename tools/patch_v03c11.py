from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c11 is a single-variable quality experiment based on the c10 field result:
# train PSNR 19.71 / SSIM 0.563, held-out PSNR 18.86 / SSIM 0.484, gap 0.85 dB.
# The small train/held-out gap does not support a classic train-fit/novel-view
# collapse. Keep geometry, views, resolution, seeds, growth, and stopping fixed;
# only raise spherical-harmonic appearance capacity from degree 0 to degree 1.

p = Path('training.js')
s = p.read_text()

s = replace_once(
    s,
    "      if('sh-degree'in c)c['sh-degree']=0;\n",
    "      if('sh-degree'in c)c['sh-degree']=1;\n",
    'SH degree 0 to 1',
)
s = replace_once(
    s,
    ' / SH degree 0 / source-position hold-out every 6th group',
    ' / SH degree 1 / source-position hold-out every 6th group',
    'training log SH degree',
)

s = s.replace("label:'高品質・GPU内軽量growth＋train-fit診断'", "label:'高品質・GPU内軽量growth＋SH1比較'")
s = s.replace("label:'品質優先・GPU内軽量growth＋train-fit診断'", "label:'品質優先・GPU内軽量growth＋SH1比較'")
s = s.replace("label:'省メモリ・GPU内軽量growth＋train-fit診断'", "label:'省メモリ・GPU内軽量growth＋SH1比較'")

# Keep interpretation conservative: SH1 is the only model-side change in c11.
s = s.replace(
    '次段階ではGaussian密度・解像度・SH degreeと、カメラ姿勢・3D幾何を一度に変えず個別に比較します。',
    'c11ではSH degree 1だけを変更しています。train・未学習画像の双方が明確に改善しなければ、次はGaussian数を漫然と増やさず360°投影・カメラ姿勢・3D幾何を優先して比較します。'
)

# Runtime code is the same compiled c10 engine; the query key is bumped so the
# browser cannot mix c10 frontend/config with cached resources.
s = s.replace('v0.3c10', 'v0.3c11').replace('v=0.3c10', 'v=0.3c11')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q = Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c10', 'v0.3c11').replace('v=0.3c10', 'v=0.3c11'))

info = Path('vendor/brush-js/BUILD_INFO.txt')
if info.exists():
    info.write_text(
        'Brush JavaScript/WebAssembly runtime.\n'
        'Compiled runtime reused from the validated v0.3c10 compatibility build at ArthurBrussee/brush commit 3b80985709e2ec04fd6c8622a40e36473647a8e0.\n'
        '360GS v0.3c11 is a frontend/model-configuration experiment: SH degree 1 instead of 0.\n'
        'Views, source-position holdout, BA/SfM hybrid seeds, Gaussian growth schedule, resolution, optimizer horizon, and adaptive stopping are unchanged from v0.3c10.\n'
        'The pinned Brush loader expands init.ply splats to the configured SH degree before training.\n'
        'Brush is licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.\n'
    )

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c11\n'
    'Controlled SH degree 1 appearance-capacity comparison\n'
    'Only model change from v0.3c10: SH degree 0 -> 1\n'
    'Views, camera geometry, 512px training limit, 30k seed, GPU-only growth and adaptive stop unchanged\n'
    'Baseline for comparison: train 19.71 dB / 0.563; held-out 18.86 dB / 0.484; gap 0.85 dB\n'
    'Build date: 2026-08-16\n'
)
