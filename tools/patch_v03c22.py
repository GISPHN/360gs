from pathlib import Path
import re


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


def sub_once(text, pattern, repl, label, flags=0):
    out, n = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
    if n != 1:
        raise RuntimeError(f"regex patch target not found: {label}")
    return out


# v0.3c22: isolate Gaussian shape degeneracy after c21 direct ERP fixed
# held-out view generalization. Keep camera model, spherical geometry, pose
# refinement, ERP seam weighting, SH1, seed budget and training resolution fixed.
# Add only a conservative effective-rank regularizer against rank-1 / needle
# Gaussians, following Hyung et al. (NeurIPS 2024). The original paper uses
# q_i=s_i^2/sum(s^2), erank=exp(-sum q_i log q_i), and penalizes
# max(-log(erank-1+eps), 0). We omit its optional smallest-axis thinning term
# because 360GS already has a Mip-Splatting scale floor and c22 is intended to
# isolate needle suppression without introducing a second flattening pressure.


# ---------------------------------------------------------------------------
# Brush: effective-rank scale regularization
# ---------------------------------------------------------------------------
p = Path('_brush/crates/brush-train/src/train.rs')
s = p.read_text()

s = replace_once(
    s,
    'const MIN_SCALE_FACTOR: f32 = 0.1;\n',
    '''const MIN_SCALE_FACTOR: f32 = 0.1;

/// c22: effective-rank regularization against rank-1 / needle-like Gaussians.
/// Hyung et al. (NeurIPS 2024) show that max/min anisotropy alone cannot
/// distinguish a useful disk from a degenerate needle. Effective rank uses all
/// three covariance eigenvalues (squared scales) and is ~1 for needles, ~2 for
/// disks and 3 for isotropic splats.
///
/// Start after coarse geometry has formed, then ramp gently. The paper's
/// published training starts this regularizer after the coarse phase; 360GS has
/// a much shorter browser budget, so use the equivalent fractional schedule.
const ERANK_REG_START_FRAC: f32 = 0.25;
const ERANK_REG_RAMP_FRAC: f32 = 0.25;
const ERANK_REG_MAX_WEIGHT: f32 = 0.02;
const ERANK_EPS: f32 = 1.0e-5;
''',
    'effective-rank constants',
)

# patch_v03b9 inserts diagnostic stage 145 immediately before the backward
# loss snapshot. Insert c22 before that stable post-c21 anchor so the full
# historical browser patch chain remains reproducible.
anchor = '            set_training_diag_stage(145);\n'
insert = '''            // c22 effective-rank regularization. Covariance eigenvalues are
            // proportional to s^2; rotation does not change them, so no SVD is
            // needed. This directly implements the differentiable entropy-rank
            // statistic from Hyung et al. while remaining WebGPU friendly.
            let start_step = (self.config.total_train_iters as f32 * ERANK_REG_START_FRAC) as u32;
            let ramp_steps = (self.config.total_train_iters as f32 * ERANK_REG_RAMP_FRAC)
                .max(1.0) as u32;
            if self.step_count > start_step {
                let ramp = ((self.step_count - start_step) as f32 / ramp_steps as f32)
                    .clamp(0.0, 1.0);
                let weight = ERANK_REG_MAX_WEIGHT * ramp;
                if weight > 0.0 {
                    let log_scales = splats.log_scales();
                    let variances = log_scales.mul_scalar(2.0).exp();
                    let variance_sum = variances.clone().sum_dim(1).clamp_min(1.0e-20);
                    let q = variances / variance_sum;
                    let q_safe = q.clone().clamp_min(1.0e-12);
                    let entropy = -(q * q_safe.log()).sum_dim(1);
                    let erank = entropy.exp();
                    let needle_penalty = (-(erank - 1.0 + ERANK_EPS)
                        .clamp_min(ERANK_EPS)
                        .log())
                        .clamp_min(0.0)
                        .mean();
                    loss = loss + needle_penalty.mul_scalar(weight);
                }
            }

            set_training_diag_stage(145);
'''
s = replace_once(s, anchor, insert, 'effective-rank loss injection')
p.write_text(s)


# ---------------------------------------------------------------------------
# 360GS frontend: richer shape diagnostics + c22 version markers
# ---------------------------------------------------------------------------
p = Path('training.js')
s = p.read_text()

new_diag = r'''function trGaussianDiagnostics(t,o,n,bounds){
  const maxScale=[],geoScale=[],axisRatio=[],needleRatio=[],erank=[],opacity=[];
  for(let i=0;i<n;i++){
    const z=i*10,logs=[t[z+7],t[z+8],t[z+9]];
    if(logs.every(Number.isFinite)){
      const sc=logs.map(v=>Math.exp(Math.max(-30,Math.min(30,v))));
      const sorted=[...sc].sort((a,b)=>b-a),mx=sorted[0],mid=Math.max(1e-12,sorted[1]),mn=Math.max(1e-12,sorted[2]);
      maxScale.push(mx);geoScale.push(Math.exp((logs[0]+logs[1]+logs[2])/3));axisRatio.push(mx/mn);needleRatio.push(mx/mid);
      const vv=sc.map(v=>v*v),sum=vv[0]+vv[1]+vv[2];
      if(Number.isFinite(sum)&&sum>0){const q=vv.map(v=>Math.max(1e-15,v/sum)),h=-q.reduce((a,v)=>a+v*Math.log(v),0);erank.push(Math.exp(h));}
    }
    const ov=o[i];if(Number.isFinite(ov))opacity.push(trSigmoid(ov));
  }
  const radius=Math.max(1e-9,bounds?.radius||1);
  const d={
    scale50:trQuantile(maxScale,.5),scale90:trQuantile(maxScale,.9),scale99:trQuantile(maxScale,.99),
    geo50:trQuantile(geoScale,.5),ratio90:trQuantile(axisRatio,.9),needle90:trQuantile(needleRatio,.9),
    erank10:trQuantile(erank,.1),erank50:trQuantile(erank,.5),erank90:trQuantile(erank,.9),
    opacity10:trQuantile(opacity,.1),opacity50:trQuantile(opacity,.5),opacity90:trQuantile(opacity,.9),radius
  };
  d.rel90=d.scale90/radius;d.rel99=d.scale99/radius;
  if(d.erank10<1.20||d.needle90>8)d.verdict=`needle-like Gaussianが残っています（effective-rank p10 ${Number.isFinite(d.erank10)?d.erank10.toFixed(2):'—'} / 最大軸÷中間軸 p90 ${Number.isFinite(d.needle90)?d.needle90.toFixed(1):'—'}倍）。c22の形状正則化が十分かを評価します。`;
  else if(d.rel90>.12||d.rel99>.35)d.verdict='needle形状は抑えられていますが、大きなGaussianが多く、残るぼけはscale上限・densification不足を優先して評価します。';
  else d.verdict='極端なneedle形状とGaussian膨張は目立ちません。残る誤差は幾何密度・stitching distortion・appearance表現を切り分けます。';
  return d;
}
function trRenderGaussianDiagnostics(res,d){
  if(!res||!d)return;
  let e=res.querySelector('#train-result-diagnostics');
  if(!e){e=document.createElement('div');e.id='train-result-diagnostics';e.className='train-result-meta';res.querySelector('#train-result-meta')?.insertAdjacentElement('afterend',e);}
  const f=v=>Number.isFinite(v)?v.toFixed(4):'—',pct=v=>Number.isFinite(v)?`${(v*100).toFixed(1)}%`:'—',g=v=>Number.isFinite(v)?v.toFixed(2):'—';
  e.innerHTML=`<strong>Gaussian品質診断</strong><br>scale 最大軸: 中央値 ${f(d.scale50)} / p90 ${f(d.scale90)} / p99 ${f(d.scale99)}<br>シーン半径比: p90 ${pct(d.rel90)} / p99 ${pct(d.rel99)}<br>形状: effective-rank p10 ${g(d.erank10)} / 中央値 ${g(d.erank50)} / p90 ${g(d.erank90)}　・　最大÷中間軸 p90 ${Number.isFinite(d.needle90)?d.needle90.toFixed(1):'—'}倍　・　最大÷最小軸 p90 ${Number.isFinite(d.ratio90)?d.ratio90.toFixed(1):'—'}倍<br>opacity: p10 ${pct(d.opacity10)} / 中央値 ${pct(d.opacity50)} / p90 ${pct(d.opacity90)}<br>${d.verdict}`;
}
'''

s = sub_once(
    s,
    r'function trGaussianDiagnostics\(t,o,n,bounds\)\{.*?\n\}\nfunction trRenderGeometryDiagnostics',
    new_diag + 'function trRenderGeometryDiagnostics',
    'effective-rank frontend diagnostics',
    re.S,
)

# Keep the c21 experiment controlled; only the shape regularizer and diagnostics
# change. Version cache-busting is deliberately global for the frontend module.
s = s.replace('0.3c21', '0.3c22')
s = s.replace('高品質・direct ERP＋post-pose再調整', '高品質・direct ERP＋erank形状正則化＋post-pose再調整')
s = s.replace('品質優先・direct ERP＋post-pose再調整', '品質優先・direct ERP＋erank形状正則化＋post-pose再調整')
s = s.replace('省メモリ・direct ERP＋post-pose再調整', '省メモリ・direct ERP＋erank形状正則化＋post-pose再調整')
s = s.replace('c21ではc20の球面幾何とpose再調整を維持し、direct ERPを廃止してdirect ERP rasterizationへ移行しています。残る誤差はERP camera model、stitching distortion、Gaussian geometryを個別に評価します。',
              'c22ではc21のdirect ERP・球面幾何・pose再調整を固定し、effective-rank正則化だけを追加してneedle-like Gaussianを抑制しています。残る誤差はGaussian size、densification、stitching distortionを個別に評価します。')
p.write_text(s)

for name in ['index.html','video.html']:
    p=Path(name); x=p.read_text().replace('0.3c21','0.3c22'); p.write_text(x)

p=Path('README.md')
x=p.read_text().replace('v0.3c21','v0.3c22').replace('0.3c21','0.3c22')
if 'c22 effective-rank' not in x:
    x += '''\n\n### c22 effective-rank Gaussian shape regularization\n\nv0.3c22 keeps the c21 direct equirectangular camera, spherical geometry, post-triangulation pose refinement, SH1, seed budget and browser training resolution fixed. It adds a conservative effective-rank regularizer based on Hyung et al. (NeurIPS 2024) to suppress rank-1 / needle-like Gaussians while preserving disk-like surface splats. The regularizer starts after 25% of training and ramps to weight 0.02 over the next 25%. The optional smallest-axis thinning term from the paper is intentionally omitted because 360GS already applies a Mip-Splatting 3D scale floor.\n'''
p.write_text(x)

Path('BUILD_VERSION.txt').write_text('''360GS v0.3c22\nEffective-rank Gaussian shape regularization after c21 direct ERP\nc21 direct equirectangular camera, complementary seam weighting, spherical geometry and post-triangulation pose refinement are retained unchanged\nNeurIPS 2024 effective rank is computed from normalized squared Gaussian scales: q_i=s_i^2/sum(s^2), erank=exp(-sum(q_i log q_i))\nNeedle penalty follows max(-log(erank-1+eps),0); disk-like erank~2 splats are not penalized by max/min anisotropy alone\nBrowser schedule starts at 25% of training and ramps to conservative weight 0.02 over the next 25%\nThe paper's optional smallest-axis thinning term is omitted so c22 isolates needle suppression and does not fight the existing Mip-Splatting scale floor\nFrontend diagnostics now report effective-rank p10/median/p90 plus max-axis/middle-axis p90, separating needles from legitimate flat disks\nAll c21 Gaussian count, SH degree, ERP resolution, seed budget, depth guards and browser-safe GPU-only growth remain controlled\nc21 baseline: 14,747 Gaussians; train 21.49 dB / 0.640; held-out 20.80 dB / 0.619; gap 0.68 dB; max/min anisotropy p90 243.4x\nBuild date: 2026-08-17\n''')
