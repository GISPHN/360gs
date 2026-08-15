from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)

p = Path('training.js')
s = p.read_text()
s = s.replace('v0.3c0', 'v0.3c1').replace('v=0.3c0', 'v=0.3c1')

s = replace_once(
    s,
    'let trResultUrl = null;\nlet trViewerCleanup = null;\n',
    'let trResultUrl = null;\nlet trViewerCleanup = null;\nlet trResultBounds = null;\n',
    'viewer bounds state',
)

old_export = "async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree};}"
new_export = "function trRobustBounds(t,n){const axes=[[],[],[]];for(let i=0;i<n;i++){const z=i*10,x=t[z],y=t[z+1],v=t[z+2];if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(v)){axes[0].push(x);axes[1].push(y);axes[2].push(v);}}if(axes[0].length<8)return null;for(const a of axes)a.sort((x,y)=>x-y);const pick=(a,q)=>a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*q)))];const lo=axes.map(a=>pick(a,.02)),hi=axes.map(a=>pick(a,.98)),center=lo.map((v,i)=>(v+hi[i])/2),half=lo.map((v,i)=>Math.max(1e-6,(hi[i]-v)/2));let radius=Math.hypot(half[0],half[1],half[2]);if(!Number.isFinite(radius)||radius<1e-5)radius=1;return{center,radius,lo,hi,count:axes[0].length};}\nasync function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);const bounds=trRobustBounds(t,s.numSplats);trResultBounds=bounds;return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree,bounds};}"
s = replace_once(s, old_export, new_export, 'robust export bounds')

start = s.index('async function trShow(blob){')
end = s.index('\n\nasync function trRun(item){', start)
new_show = r'''async function trShow(blob,bounds=trResultBounds){
  const wrap=trPanel().querySelector('#train-viewer');
  wrap.hidden=false;
  wrap.replaceChildren();
  trViewerCleanup?.();
  if(trResultUrl)URL.revokeObjectURL(trResultUrl);
  trResultUrl=URL.createObjectURL(blob);

  const pc=await import('https://cdn.jsdelivr.net/npm/playcanvas@2.21.4/build/playcanvas.mjs');
  const cv=document.createElement('canvas');
  cv.className='train-viewer-canvas';
  const toolbar=document.createElement('div');
  toolbar.className='train-viewer-toolbar';
  const fitButton=document.createElement('button');
  fitButton.type='button';
  fitButton.textContent='全体を表示';
  const help=document.createElement('span');
  help.textContent='ドラッグ: 回転 / ホイール: 拡大縮小';
  toolbar.append(fitButton,help);
  wrap.append(cv,toolbar);

  const app=new pc.Application(cv,{graphicsDeviceOptions:{antialias:false,alpha:false}});
  app.start();
  const cam=new pc.Entity('Camera');
  cam.addComponent('camera',{clearColor:new pc.Color(.07,.08,.10),fov:55,nearClip:.0001,farClip:100000});
  app.root.addChild(cam);

  const as=new pc.Asset('360GS','gsplat',{url:trResultUrl,filename:'360gs_result.ply',size:blob.size});
  app.assets.add(as);
  await new Promise((r,j)=>{as.once('load',r);as.once('error',j);app.assets.load(as);});
  const sp=new pc.Entity('3DGS');
  sp.addComponent('gsplat',{asset:as});
  app.root.addChild(sp);

  let center=[0,0,0],rad=1;
  if(bounds?.center?.length===3&&Number.isFinite(bounds.radius)&&bounds.radius>0){
    center=bounds.center;
    rad=Math.max(bounds.radius,1e-4);
    trLog(`Viewer robust bounds: center ${center.map(v=>v.toFixed(3)).join(', ')} / radius ${rad.toFixed(3)}`);
  }else{
    const bb=as.resource?.aabb;
    if(bb){
      center=[bb.center.x,bb.center.y,bb.center.z];
      rad=Math.max(1e-4,Math.hypot(bb.halfExtents.x,bb.halfExtents.y,bb.halfExtents.z));
      trLog(`Viewer asset bounds fallback: radius ${rad.toFixed(3)}`);
    }
  }
  sp.setPosition(-center[0],-center[1],-center[2]);
  cam.camera.nearClip=Math.max(rad*0.0005,0.00001);
  cam.camera.farClip=Math.max(rad*60,100);

  let yaw=.55,pitch=.12,distance=rad*2.55,drag=false,lx=0,ly=0;
  const update=()=>{
    const cp=Math.cos(pitch);
    cam.setPosition(distance*Math.sin(yaw)*cp,distance*Math.sin(pitch),distance*Math.cos(yaw)*cp);
    cam.lookAt(0,0,0);
  };
  const fit=()=>{
    yaw=.55;
    pitch=.12;
    distance=Math.max(rad*2.55,rad+.0001);
    update();
  };
  fitButton.addEventListener('click',fit);
  cv.addEventListener('dblclick',fit);
  cv.addEventListener('pointerdown',e=>{drag=true;lx=e.clientX;ly=e.clientY;cv.setPointerCapture(e.pointerId);});
  cv.addEventListener('pointermove',e=>{if(!drag)return;yaw-=(e.clientX-lx)*.006;pitch=Math.max(-1.45,Math.min(1.45,pitch-(e.clientY-ly)*.006));lx=e.clientX;ly=e.clientY;update();});
  const endDrag=e=>{drag=false;try{cv.releasePointerCapture(e.pointerId);}catch{}};
  cv.addEventListener('pointerup',endDrag);
  cv.addEventListener('pointercancel',endDrag);
  cv.addEventListener('wheel',e=>{e.preventDefault();distance=Math.max(rad*.08,Math.min(rad*40,distance*Math.exp(e.deltaY*.001)));update();},{passive:false});

  const ro=new ResizeObserver(()=>app.resizeCanvas(Math.max(1,wrap.clientWidth),Math.max(1,wrap.clientHeight)));
  ro.observe(wrap);
  app.resizeCanvas(Math.max(1,wrap.clientWidth),Math.max(1,wrap.clientHeight));
  fit();
  trViewerCleanup=()=>{ro.disconnect();app.destroy();};
}'''
s = s[:start] + new_show + s[end:]

s = replace_once(
    s,
    "res.querySelector('#train-show').onclick=()=>trShow(ex.blob).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));",
    "res.querySelector('#train-show').onclick=()=>trShow(ex.blob,ex.bounds).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));",
    'viewer bounds call',
)
s = replace_once(
    s,
    "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,segmentId:item.source.segment.id};",
    "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,segmentId:item.source.segment.id};",
    'result bounds state',
)
p.write_text(s)

p=Path('training.css')
css=p.read_text()
if '.train-viewer-toolbar' not in css:
    css += "\n.train-viewer-toolbar{position:absolute;z-index:4;top:10px;left:10px;right:10px;display:flex;align-items:center;gap:10px;pointer-events:none}.train-viewer-toolbar button{pointer-events:auto;border:1px solid rgba(255,255,255,.3);border-radius:9px;padding:8px 11px;background:rgba(15,23,42,.88);color:#fff;font-weight:700;cursor:pointer}.train-viewer-toolbar span{padding:6px 9px;border-radius:8px;background:rgba(15,23,42,.72);color:#e2e8f0;font-size:12px}.train-viewer-toolbar button:hover{background:rgba(30,41,59,.96)}\n"
css=css.replace('v0.3c0','v0.3c1')
p.write_text(css)

for name in ['video.html','index.html','README.md']:
    q=Path(name)
    if q.exists():
        t=q.read_text().replace('v0.3c0','v0.3c1').replace('v=0.3c0','v=0.3c1')
        q.write_text(t)
