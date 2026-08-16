from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


p = Path('training.js')
s = p.read_text()

# Pin to the latest verified PlayCanvas engine release available at implementation time.
s = replace_once(
    s,
    "https://cdn.jsdelivr.net/npm/playcanvas@2.21.4/build/playcanvas.mjs",
    "https://cdn.jsdelivr.net/npm/playcanvas@2.21.2/build/playcanvas.mjs",
    'PlayCanvas viewer version',
)

old = r'''  let yaw=.55,pitch=.12,distance=rad*2.55,drag=false,lx=0,ly=0;
  const update=()=>{
    cam.camera.fov=55;
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
  const capture=()=>{
    if(!view?.position||!view?.forward){fit();return;}
    const pos=[view.position[0]-center[0],view.position[1]-center[1],view.position[2]-center[2]];
    const f=view.forward;
    cam.camera.fov=TR_FOV;
    cam.setPosition(pos[0],pos[1],pos[2]);
    cam.lookAt(pos[0]+f[0]*rad,pos[1]+f[1]*rad,pos[2]+f[2]*rad);
    trLog(`Viewer training camera: frame ${view.index+1}${view.time!=null?` / ${view.time.toFixed(1)}s`:''}`);
  };
  captureButton.disabled=!view;
  captureButton.addEventListener('click',capture);
  fitButton.addEventListener('click',fit);
  cv.addEventListener('dblclick',()=>view?capture():fit());
  cv.addEventListener('pointerdown',e=>{drag=true;lx=e.clientX;ly=e.clientY;cv.setPointerCapture(e.pointerId);});
  cv.addEventListener('pointermove',e=>{if(!drag)return;yaw-=(e.clientX-lx)*.006;pitch=Math.max(-1.45,Math.min(1.45,pitch-(e.clientY-ly)*.006));lx=e.clientX;ly=e.clientY;update();});
  const endDrag=e=>{drag=false;try{cv.releasePointerCapture(e.pointerId);}catch{}};
  cv.addEventListener('pointerup',endDrag);
  cv.addEventListener('pointercancel',endDrag);
  cv.addEventListener('wheel',e=>{e.preventDefault();distance=Math.max(rad*.08,Math.min(rad*40,distance*Math.exp(e.deltaY*.001)));update();},{passive:false});
'''

new = r'''  // c14 viewer state model:
  // - orbit mode is used by "全体を表示" and rotates around the scene centre.
  // - look mode is used by "撮影位置から表示" and rotates in place at the
  //   captured camera position.  Previously capture() changed only the actual
  //   PlayCanvas camera while yaw/pitch/distance retained stale orbit values;
  //   the first pointer movement therefore jumped to an unrelated camera pose.
  cv.style.touchAction='none';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const finite3=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  let mode='orbit',yaw=.55,pitch=.12,distance=Math.max(rad*2.55,rad+.0001),lookPos=[0,0,0],lookFov=TR_FOV;
  let drag=false,activePointer=null,lx=0,ly=0;

  const setClips=()=>{
    // Keep the near plane conservative for cameras that may start inside an
    // indoor scene while retaining a generous far plane for scene-wide orbit.
    cam.camera.nearClip=Math.max(rad*0.00002,0.00001);
    cam.camera.farClip=Math.max(rad*100,distance+rad*20,100);
  };
  const direction=()=>{
    const cp=Math.cos(pitch);
    return[Math.sin(yaw)*cp,Math.sin(pitch),Math.cos(yaw)*cp];
  };
  const recover=reason=>{
    trLog(`Viewer camera recovery: ${reason}`);
    mode='orbit';yaw=.55;pitch=.12;distance=Math.max(rad*2.55,rad+.0001);lookFov=TR_FOV;
  };
  const update=()=>{
    if(!Number.isFinite(yaw)||!Number.isFinite(pitch)||!Number.isFinite(distance)||!finite3(lookPos))recover('invalid camera state');
    pitch=clamp(pitch,-1.45,1.45);
    if(mode==='look'){
      const d=direction();
      cam.camera.fov=clamp(lookFov,20,110);
      cam.setPosition(lookPos[0],lookPos[1],lookPos[2]);
      cam.lookAt(lookPos[0]+d[0]*Math.max(rad,1),lookPos[1]+d[1]*Math.max(rad,1),lookPos[2]+d[2]*Math.max(rad,1));
    }else{
      distance=clamp(distance,Math.max(rad*.08,.0001),Math.max(rad*40,1));
      cam.camera.fov=55;
      const cp=Math.cos(pitch);
      cam.setPosition(distance*Math.sin(yaw)*cp,distance*Math.sin(pitch),distance*Math.cos(yaw)*cp);
      cam.lookAt(0,0,0);
    }
    setClips();
  };
  const fit=()=>{
    mode='orbit';yaw=.55;pitch=.12;distance=Math.max(rad*2.55,rad+.0001);
    update();
    trLog('Viewer mode: scene orbit');
  };
  const capture=()=>{
    if(!view?.position||!view?.forward){fit();return;}
    const pos=[view.position[0]-center[0],view.position[1]-center[1],view.position[2]-center[2]];
    const f=[view.forward[0],view.forward[1],view.forward[2]];
    const fn=Math.hypot(f[0],f[1],f[2]);
    if(!finite3(pos)||!finite3(f)||!Number.isFinite(fn)||fn<1e-8){fit();return;}
    f[0]/=fn;f[1]/=fn;f[2]/=fn;
    mode='look';lookPos=pos;lookFov=TR_FOV;
    yaw=Math.atan2(f[0],f[2]);
    pitch=Math.asin(clamp(f[1],-1,1));
    update();
    trLog(`Viewer training camera: frame ${view.index+1}${view.time!=null?` / ${view.time.toFixed(1)}s`:''}`);
  };
  captureButton.disabled=!view;
  captureButton.addEventListener('click',capture);
  fitButton.addEventListener('click',fit);

  cv.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    e.preventDefault();
    drag=true;activePointer=e.pointerId;lx=e.clientX;ly=e.clientY;
    try{cv.setPointerCapture(e.pointerId);}catch{}
  });
  cv.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==activePointer)return;
    const dx=e.clientX-lx,dy=e.clientY-ly;
    lx=e.clientX;ly=e.clientY;
    if(Math.abs(dx)+Math.abs(dy)<0.01)return;
    yaw-=dx*.006;
    pitch=clamp(pitch-dy*.006,-1.45,1.45);
    update();
  });
  const endDrag=e=>{
    if(activePointer!==null&&e.pointerId!==activePointer)return;
    drag=false;activePointer=null;
    try{cv.releasePointerCapture(e.pointerId);}catch{}
  };
  cv.addEventListener('pointerup',endDrag);
  cv.addEventListener('pointercancel',endDrag);
  cv.addEventListener('lostpointercapture',()=>{drag=false;activePointer=null;});
  cv.addEventListener('wheel',e=>{
    e.preventDefault();
    if(mode==='look'){
      // At a captured camera position, wheel changes lens zoom instead of
      // moving the camera through nearby geometry and accidentally clipping it.
      lookFov=clamp(lookFov*Math.exp(e.deltaY*.001),20,110);
    }else{
      distance=clamp(distance*Math.exp(e.deltaY*.001),Math.max(rad*.08,.0001),Math.max(rad*40,1));
    }
    update();
  },{passive:false});
'''

s = replace_once(s, old, new, 'viewer camera controls')

s = replace_once(
    s,
    "help.textContent='ドラッグ: 回転 / ホイール: 拡大縮小';",
    "help.textContent='ドラッグ: 回転 / ホイール: 拡大縮小（クリックだけでは視点は変わりません）';",
    'viewer help text',
)

# Update interpretation text without changing the training model.
s = s.replace(
    "return '学習画像への適合と未学習画像への一般化の両方が中間的です。c11でSH1の効果がほぼ無かったため、c12ではgrowth選択率だけを3倍にしてGaussian密度を比較しています。train・未学習画像の双方が明確に改善しなければ、次は360°投影・カメラ姿勢・3D幾何を優先して比較します。';",
    "return '学習画像への適合と未学習画像への一般化の両方が中間的です。c13では6面90°cubemapへ変更して360°投影範囲を改善しています。改善が限定的なら、次は直接ERP/球面カメラモデルとカメラ姿勢・3D幾何を優先して比較します。';"
)

s = s.replace('v0.3c13', 'v0.3c14').replace('v=0.3c13', 'v=0.3c14')
p.write_text(s)

for name in ['index.html','video.html','README.md']:
    q=Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c13','v0.3c14').replace('v=0.3c13','v=0.3c14'))

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c14\n'
    'Viewer camera-state stability hotfix\n'
    'Training/reconstruction model unchanged from v0.3c13 six-face 90-degree cubemap\n'
    'Viewer separates scene-orbit and captured-camera look modes and synchronizes yaw/pitch state\n'
    'Single click no longer changes camera; captured-camera wheel uses FOV zoom; conservative clip planes added\n'
    'PlayCanvas viewer pinned to verified v2.21.2\n'
    'c13 baseline: 46,128 Gaussians; train 19.75 dB / 0.568; held-out 19.10 dB / 0.532; gap 0.65 dB\n'
    'Build date: 2026-08-16\n'
)
