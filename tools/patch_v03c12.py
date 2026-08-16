from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c12 follows the c11 field result:
# train PSNR 19.86 / SSIM 0.566, held-out PSNR 18.90 / SSIM 0.485,
# gap 0.96 dB. Relative to c10, SH degree 1 changed train PSNR by only
# +0.15 dB and held-out PSNR by only +0.04 dB, with essentially unchanged
# SSIM. Appearance capacity alone therefore does not explain the blur.
#
# c12 is another controlled comparison. Keep SH1, views, camera geometry,
# image resolution, seed count, growth timing, growth stop, iteration horizon,
# and adaptive stop unchanged. Change only growth-select-fraction, tripling it
# on each device tier. On the high tier used in the field test this changes
# 0.08 -> 0.24, so two existing growth events should move a 30k seed toward
# roughly 46k splats while remaining below the existing 60k safety cap.

p = Path('training.js')
s = p.read_text()

s = replace_once(
    s,
    "growthFraction:.08,evalEvery:800",
    "growthFraction:.24,evalEvery:800",
    'high-tier growth fraction 0.08 to 0.24',
)
s = replace_once(
    s,
    "growthFraction:.07,evalEvery:800",
    "growthFraction:.21,evalEvery:800",
    'standard-tier growth fraction 0.07 to 0.21',
)
s = replace_once(
    s,
    "growthFraction:.05,evalEvery:600",
    "growthFraction:.15,evalEvery:600",
    'low-tier growth fraction 0.05 to 0.15',
)

s = s.replace("label:'高品質・GPU内軽量growth＋SH1比較'", "label:'高品質・Gaussian密度比較'")
s = s.replace("label:'品質優先・GPU内軽量growth＋SH1比較'", "label:'品質優先・Gaussian密度比較'")
s = s.replace("label:'省メモリ・GPU内軽量growth＋SH1比較'", "label:'省メモリ・Gaussian密度比較'")

# Keep the interpretation tied to the controlled comparison. If substantially
# more Gaussians do not improve train and holdout together, the next change
# should target the omnidirectional projection/camera model rather than SH2 or
# additional iterations.
s = s.replace(
    'c11ではSH degree 1だけを変更しています。train・未学習画像の双方が明確に改善しなければ、次はGaussian数を漫然と増やさず360°投影・カメラ姿勢・3D幾何を優先して比較します。',
    'c11でSH1の効果がほぼ無かったため、c12ではgrowth選択率だけを3倍にしてGaussian密度を比較しています。train・未学習画像の双方が明確に改善しなければ、次は360°投影・カメラ姿勢・3D幾何を優先して比較します。'
)

# The compiled c10 Brush engine is retained. The query key is bumped so the
# browser cannot combine the c12 frontend/config with stale cached resources.
s = s.replace('v0.3c11', 'v0.3c12').replace('v=0.3c11', 'v=0.3c12')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q = Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c11', 'v0.3c12').replace('v=0.3c11', 'v=0.3c12'))

info = Path('vendor/brush-js/BUILD_INFO.txt')
if info.exists():
    info.write_text(
        'Brush JavaScript/WebAssembly runtime.\n'
        'Compiled runtime reused from the validated v0.3c10 compatibility build at ArthurBrussee/brush commit 3b80985709e2ec04fd6c8622a40e36473647a8e0.\n'
        '360GS v0.3c12 is a frontend/training-configuration experiment testing Gaussian density after the negligible SH1 result.\n'
        'Only growth-select-fraction changes from v0.3c11: 0.08/0.07/0.05 -> 0.24/0.21/0.15 by device tier.\n'
        'SH degree 1, views, source-position holdout, BA/SfM hybrid seeds, growth timing, resolution, optimizer horizon, and adaptive stopping remain unchanged.\n'
        'The existing 36k/50k/60k device safety caps remain active.\n'
        'Brush is licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.\n'
    )

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c12\n'
    'Controlled Gaussian-density comparison after negligible SH1 gain\n'
    'Only training change from v0.3c11: growth-select-fraction x3 (0.24 / 0.21 / 0.15 by device tier)\n'
    'SH degree 1, camera geometry, views, 512px training limit, 30k high-tier seed, growth timing and adaptive stop unchanged\n'
    'c11 baseline: train 19.86 dB / 0.566; held-out 18.90 dB / 0.485; gap 0.96 dB; 34,992 Gaussians\n'
    'High-tier expected density after two existing growth events: approximately 46k, capped at 60k\n'
    'Build date: 2026-08-16\n'
)
