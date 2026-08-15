from pathlib import Path

root = Path('.')
train = root / 'training.js'
s = train.read_text(encoding='utf-8')

s = s.replace("let trResultBounds = null;", "let trResultBounds = null;\nlet trResultView = null;")

anchor = "function trRobustBounds(t,n){const axes=[[],[],[]];for(let i=0;i<n;i++){const z=i*10,x=t[z],y=t[z+1],v=t[z+2];if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(v)){axes[0].push(x);axes[1].push(y);axes[2].push(v);}}if(axes[0].length<8)return null;for(const a of axes)a.sort((x,y)=>x-y);const pick=(a,q)=>a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*q)))];const lo=axes.map(a=>pick(a,.02)),hi=axes.map(a=>pick(a,.98)),center=lo.map((v,i)=>(v+hi[i])/2),half=lo.map((v,i)=>Math.max(1e-6,(hi[i]-v)/2));let radius=Math.hypot(half[0],half[1],half[2]);if(!Number.isFinite(radius)||radius<1e-5)radius=1;return{center,radius,lo,hi,count:axes[0].length};}"
insert = anchor + "\nfunction trRepresentativeView(item){const poses=item?.optimization?.poses||[];if(!poses.length)return null;const i=Math.max(0,Math.min(poses.length-1,Math.floor((poses.length-1)/2)));const p=poses[i],R=p?.cameraToWorld,C=p?.position;if(!Array.isArray(R)||R.length!==9||!Array.isArray(C)||C.length!==3)return null;let f=[R[2],R[5],R[8]];const n=Math.hypot(f[0],f[1],f[2])||1;f=f.map(v=>v/n);const tm=item?.source?.frames?.[i]?.time;return{position:C.slice(),forward:f,index:i,time:Number.isFinite(tm)?tm:null};}\nfunction trBoundsSummary(b){if(!b?.lo||!b?.hi)return'';const d=b.hi.map((v,i)=>Math.max(0,v-b.lo[i]));return`範囲 ${d.map(v=>v.toFixed(2)).join(' × ')}（任意スケール）`;}"
if anchor not in s:
    raise SystemExit('robust bounds anchor not found')
s = s.replace(anchor, insert, 1)

s = s.replace("async function trShow(blob,bounds=trResultBounds){", "async function trShow(blob,bounds=trResultBounds,view=trResultView){", 1)

old_toolbar = "  const fitButton=document.createElement('button');\n  fitButton.type='button';\n  fitButton.textContent='全体を表示';\n  const help=document.createElement('span');\n  help.textContent='ドラッグ: 回転 / ホイール: 拡大縮小';\n  toolbar.append(fitButton,help);"
new_toolbar = "  const captureButton=document.createElement('button');\n  captureButton.type='button';\n  captureButton.textContent='撮影位置から表示';\n  const fitButton=document.createElement('button');\n  fitButton.type='button';\n  fitButton.textContent='全体を表示';\n  const help=document.createElement('span');\n  help.textContent='ドラッグ: 回転 / ホイール: 拡大縮小';\n  toolbar.append(captureButton,fitButton,help);"
if old_toolbar not in s:
    raise SystemExit('viewer toolbar anchor not found')
s = s.replace(old_toolbar, new_toolbar, 1)

old_cam = "  let yaw=.55,pitch=.12,distance=rad*2.55,drag=false,lx=0,ly=0;\n  const update=()=>{\n    const cp=Math.cos(pitch);\n    cam.setPosition(distance*Math.sin(yaw)*cp,distance*Math.sin(pitch),distance*Math.cos(yaw)*cp);\n    cam.lookAt(0,0,0);\n  };\n  const fit=()=>{\n    yaw=.55;\n    pitch=.12;\n    distance=Math.max(rad*2.55,rad+.0001);\n    update();\n  };\n  fitButton.addEventListener('click',fit);\n  cv.addEventListener('dblclick',fit);"
new_cam = "  let yaw=.55,pitch=.12,distance=rad*2.55,drag=false,lx=0,ly=0;\n  const update=()=>{\n    cam.camera.fov=55;\n    const cp=Math.cos(pitch);\n    cam.setPosition(distance*Math.sin(yaw)*cp,distance*Math.sin(pitch),distance*Math.cos(yaw)*cp);\n    cam.lookAt(0,0,0);\n  };\n  const fit=()=>{\n    yaw=.55;\n    pitch=.12;\n    distance=Math.max(rad*2.55,rad+.0001);\n    update();\n  };\n  const capture=()=>{\n    if(!view?.position||!view?.forward){fit();return;}\n    const pos=[view.position[0]-center[0],view.position[1]-center[1],view.position[2]-center[2]];\n    const f=view.forward;\n    cam.camera.fov=TR_FOV;\n    cam.setPosition(pos[0],pos[1],pos[2]);\n    cam.lookAt(pos[0]+f[0]*rad,pos[1]+f[1]*rad,pos[2]+f[2]*rad);\n    trLog(`Viewer training camera: frame ${view.index+1}${view.time!=null?` / ${view.time.toFixed(1)}s`:''}`);\n  };\n  captureButton.disabled=!view;\n  captureButton.addEventListener('click',capture);\n  fitButton.addEventListener('click',fit);\n  cv.addEventListener('dblclick',()=>view?capture():fit());"
if old_cam not in s:
    raise SystemExit('viewer camera anchor not found')
s = s.replace(old_cam, new_cam, 1)

s = s.replace("  fit();\n  trViewerCleanup=()=>{ro.disconnect();app.destroy();};", "  if(view)capture();else fit();\n  trViewerCleanup=()=>{ro.disconnect();app.destroy();};", 1)

old_result = "    const ex=await trExport(rt,t),res=p.querySelector('#train-result');\n    res.hidden=false;\n    res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB`;\n    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,`360gs_segment_${item.source.segment.id}.ply`);\n    res.querySelector('#train-show').onclick=()=>trShow(ex.blob,ex.bounds).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));"
new_result = "    const ex=await trExport(rt,t),res=p.querySelector('#train-result');\n    ex.view=trRepresentativeView(item);trResultView=ex.view;\n    res.hidden=false;\n    const range=trBoundsSummary(ex.bounds);\n    res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB${range?` / ${range}`:''}`;\n    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,`360gs_segment_${item.source.segment.id}.ply`);\n    res.querySelector('#train-show').onclick=()=>trShow(ex.blob,ex.bounds,ex.view).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));"
if old_result not in s:
    raise SystemExit('training result anchor not found')
s = s.replace(old_result, new_result, 1)
s = s.replace("window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,segmentId:item.source.segment.id};", "window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,bounds:ex.bounds,view:ex.view,segmentId:item.source.segment.id};", 1)

s = s.replace("trResultBounds=null;", "trResultBounds=null;trResultView=null;")
s = s.replace("Prototype v0.3c1", "Prototype v0.3c2")
s = s.replace("?v=0.3c1", "?v=0.3c2")
train.write_text(s, encoding='utf-8')

for name in ['video.html','index.html']:
    p=root/name
    t=p.read_text(encoding='utf-8')
    t=t.replace('Prototype v0.3c1','Prototype v0.3c2').replace('?v=0.3c1','?v=0.3c2')
    p.write_text(t,encoding='utf-8')

css=root/'training.css'
c=css.read_text(encoding='utf-8')
if '.train-viewer-toolbar button:disabled' not in c:
    c += "\n.train-viewer-toolbar{position:absolute;left:10px;top:10px;z-index:4;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.train-viewer-toolbar button{border:1px solid #64748b;border-radius:9px;padding:7px 10px;background:#111827;color:#fff;font-weight:700;cursor:pointer}.train-viewer-toolbar button:disabled{opacity:.45;cursor:not-allowed}.train-viewer-toolbar span{padding:5px 8px;border-radius:7px;background:rgba(15,23,42,.78);color:#e2e8f0;font-size:11px}\n"
css.write_text(c,encoding='utf-8')

(root/'BUILD_VERSION.txt').write_text('360GS v0.3c2\nTraining-camera viewer plus robust full-scene framing\nBuild date: 2026-08-16\n',encoding='utf-8')
