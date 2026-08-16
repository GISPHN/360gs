from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)

p = Path('training.js')
s = p.read_text()

old = """function trRobustBounds(t,n){const axes=[[],[],[]];for(let i=0;i<n;i++){const z=i*10,x=t[z],y=t[z+1],v=t[z+2];if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(v)){axes[0].push(x);axes[1].push(y);axes[2].push(v);}}if(axes[0].length<8)return null;for(const a of axes)a.sort((x,y)=>x-y);const pick=(a,q)=>a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*q)))];const lo=axes.map(a=>pick(a,.02)),hi=axes.map(a=>pick(a,.98)),center=lo.map((v,i)=>(v+hi[i])/2),half=lo.map((v,i)=>Math.max(1e-6,(hi[i]-v)/2));let radius=Math.hypot(half[0],half[1],half[2]);if(!Number.isFinite(radius)||radius<1e-5)radius=1;return{center,radius,lo,hi,count:axes[0].length};}
"""
new = old + """function trViewerBounds(t,o,n,fallback){
  // c15: viewer framing must follow visible splat mass rather than every seed.
  // Browser-safe growth intentionally retains low-opacity BA/SfM/frustum seeds;
  // using all of their positions can make the fit radius far larger than the
  // actually visible reconstruction. Keep the diagnostic bounds unchanged and
  // derive a second, opacity-aware box only for viewer framing.
  const pts=[],alphas=[];
  for(let i=0;i<n;i++){
    const z=i*10,x=t[z],y=t[z+1],v=t[z+2],a=trSigmoid(o[i]);
    if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(v)&&Number.isFinite(a)){
      pts.push([x,y,v,a]);alphas.push(a);
    }
  }
  if(pts.length<32)return fallback||null;
  const alphaFloor=Math.max(.08,trQuantile(alphas,.40));
  let kept=pts.filter(p=>p[3]>=alphaFloor);
  if(kept.length<Math.max(32,pts.length*.20))kept=pts.filter(p=>p[3]>=Math.max(.05,trQuantile(alphas,.20)));
  if(kept.length<32)return fallback||null;
  const axes=[0,1,2].map(k=>kept.map(p=>p[k]).sort((a,b)=>a-b));
  const pick=(a,q)=>a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*q)))];
  const lo=axes.map(a=>pick(a,.04)),hi=axes.map(a=>pick(a,.96));
  const center=lo.map((v,i)=>(v+hi[i])/2),half=lo.map((v,i)=>Math.max(1e-6,(hi[i]-v)/2));
  let radius=Math.hypot(half[0],half[1],half[2]);
  if(!Number.isFinite(radius)||radius<1e-5)return fallback||null;
  return{center,radius,lo,hi,count:kept.length,alphaFloor};
}
"""
s = replace_once(s, old, new, 'viewer bounds helper')

old = """async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats),diagnostics=trGaussianDiagnostics(t,o,s.numSplats,bounds);trResultBounds=bounds;trLog(`Gaussian diagnostics: scale p50=${diagnostics.scale50.toFixed(4)} p90=${diagnostics.scale90.toFixed(4)} p99=${diagnostics.scale99.toFixed(4)} / radius ratios p90=${(diagnostics.rel90*100).toFixed(1)}% p99=${(diagnostics.rel99*100).toFixed(1)}% / opacity median=${(diagnostics.opacity50*100).toFixed(1)}%`);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds,diagnostics};}
"""
new = """async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats),viewBounds=trViewerBounds(t,o,s.numSplats,bounds),diagnostics=trGaussianDiagnostics(t,o,s.numSplats,bounds);trResultBounds=viewBounds||bounds;trLog(`Gaussian diagnostics: scale p50=${diagnostics.scale50.toFixed(4)} p90=${diagnostics.scale90.toFixed(4)} p99=${diagnostics.scale99.toFixed(4)} / radius ratios p90=${(diagnostics.rel90*100).toFixed(1)}% p99=${(diagnostics.rel99*100).toFixed(1)}% / opacity median=${(diagnostics.opacity50*100).toFixed(1)}%`);if(viewBounds)trLog(`Viewer visible bounds: ${viewBounds.count.toLocaleString()} splats / opacity floor ${(viewBounds.alphaFloor*100).toFixed(1)}% / radius ${viewBounds.radius.toFixed(3)}`);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds,viewBounds,diagnostics};}
"""
s = replace_once(s, old, new, 'viewer bounds export')

old = """  let mode='orbit',yaw=.55,pitch=.12,distance=Math.max(rad*2.55,rad+.0001),lookPos=[0,0,0],lookFov=TR_FOV;
"""
new = """  let mode='orbit',yaw=.55,pitch=.12,distance=Math.max(rad*2.35,rad+.0001),lookPos=[0,0,0],lookFov=TR_FOV;
"""
s = replace_once(s, old, new, 'initial fit distance')

old = """  const recover=reason=>{
    trLog(`Viewer camera recovery: ${reason}`);
    mode='orbit';yaw=.55;pitch=.12;distance=Math.max(rad*2.55,rad+.0001);lookFov=TR_FOV;
  };
"""
new = """  const recover=reason=>{
    trLog(`Viewer camera recovery: ${reason}`);
    mode='orbit';yaw=.55;pitch=.12;distance=Math.max(rad*2.35,rad+.0001);lookFov=TR_FOV;
  };
"""
s = replace_once(s, old, new, 'recovery distance')

old = """  const fit=()=>{
    mode='orbit';yaw=.55;pitch=.12;distance=Math.max(rad*2.55,rad+.0001);
    update();
    trLog('Viewer mode: scene orbit');
  };
"""
new = """  const fit=()=>{
    mode='orbit';
    // Start the overview from a direction already observed by the training
    // camera. With SH1 an arbitrary opposite-side world direction can be very
    // dark because appearance is view-dependent. Prefer the representative
    // captured camera side; when it lies near the visible-bounds centre, fall
    // back to the opposite of its forward vector.
    let d=null;
    if(view?.position&&finite3(view.position)){
      const rp=[view.position[0]-center[0],view.position[1]-center[1],view.position[2]-center[2]];
      const rn=Math.hypot(rp[0],rp[1],rp[2]);
      if(Number.isFinite(rn)&&rn>Math.max(rad*.04,1e-6))d=rp.map(v=>v/rn);
    }
    if(!d&&view?.forward&&finite3(view.forward)){
      const fn=Math.hypot(...view.forward);
      if(Number.isFinite(fn)&&fn>1e-8)d=view.forward.map(v=>-v/fn);
    }
    if(d){yaw=Math.atan2(d[0],d[2]);pitch=Math.asin(clamp(d[1],-1,1));}
    else{yaw=.55;pitch=.12;}
    const halfFov=55*Math.PI/360;
    const sphereFit=rad/Math.max(.05,Math.sin(halfFov));
    distance=Math.max(rad*1.25,sphereFit*1.06);
    update();
    trLog(`Viewer mode: visible-scene orbit / radius ${rad.toFixed(3)} / distance ${distance.toFixed(3)}`);
  };
"""
s = replace_once(s, old, new, 'visible scene fit')

s = s.replace("trShow(ex.blob,ex.bounds,ex.view)", "trShow(ex.blob,ex.viewBounds||ex.bounds,ex.view)")
s = s.replace("bounds:ex.bounds,diagnostics:ex.diagnostics", "bounds:ex.bounds,viewBounds:ex.viewBounds,diagnostics:ex.diagnostics")

# c15 is a frontend viewer-only release. The Brush binary is unchanged, but
# use the release query key consistently so browser caches are invalidated.
s = s.replace('v0.3c14','v0.3c15').replace('v=0.3c14','v=0.3c15')
p.write_text(s)

for name in ['index.html','video.html','README.md']:
    q=Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c14','v0.3c15').replace('v=0.3c14','v=0.3c15'))

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c15\n'
    'Visible-mass overview framing hotfix\n'
    'Training/reconstruction model unchanged from v0.3c13/c14 six-face 90-degree cubemap\n'
    '全体を表示 uses opacity-aware visible Gaussian bounds instead of all retained seed positions\n'
    'Overview starts from a representative observed camera side to avoid arbitrary SH1 reverse-side framing\n'
    '撮影位置から表示 behavior from v0.3c14 is unchanged\n'
    'c13 quality baseline: 46,128 Gaussians; train 19.75 dB / 0.568; held-out 19.10 dB / 0.532; gap 0.65 dB\n'
    'Build date: 2026-08-16\n'
)
