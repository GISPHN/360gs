const trVideo = document.querySelector('#source-video');
const trPageProgress = document.querySelector('#progress-text');
const TR_BRUSH = './vendor/brush-js/brush_js.js';
const TR_FOV = 100;
const TR_YAWS = [0, 90, 180, 270];
const TR_NAMES = ['front', 'right', 'back', 'left'];
const TR_MAX_FRAMES = 12;
const TR_BATCH = 5;

let trRunId = 0;
let trRunning = false;
let trPaused = false;
let trCancelled = false;
let trResume = null;
let trTraining = null;
let trRuntime = null;
let trResultUrl = null;
let trViewerCleanup = null;

function trPanel() {
  let p = document.querySelector('#train-panel');
  if (p) return p;
  const ds = document.querySelector('#dataset-panel');
  if (!ds) return null;
  p = document.createElement('section');
  p.id = 'train-panel';
  p.className = 'train-panel';
  p.hidden = true;
  p.innerHTML = `
    <div class="train-heading"><div><p class="eyebrow">3DGS学習</p><h3>Brush / WebGPUでこの端末上に3DGSを生成</h3></div><span class="train-auto">自動実行</span></div>
    <p class="train-description">画像品質を通過した区間をブラウザの一時領域へ配置し、BrushのWebAssembly版を使ってこのPCのGPUで学習します。動画や画像はサーバーへ送信しません。</p>
    <div class="train-stats">
      <div><span>WebGPU</span><strong id="train-webgpu">確認中</strong></div>
      <div><span>学習画像</span><strong id="train-views">—</strong></div>
      <div><span>反復</span><strong id="train-iter">—</strong></div>
      <div><span>Gaussian数</span><strong id="train-splats">—</strong></div>
    </div>
    <div class="train-progress-wrap"><div class="train-progress"><div id="train-progress-bar"></div></div><div id="train-progress-label">学習開始を待っています</div></div>
    <div class="train-substats"><span>経過<strong id="train-elapsed">—</strong></span><span>PSNR<strong id="train-psnr">—</strong></span><span>SSIM<strong id="train-ssim">—</strong></span><span>計画<strong id="train-plan">自動</strong></span></div>
    <div class="train-actions"><button id="train-start" class="train-primary" type="button">3DGS学習を開始</button><button id="train-pause" class="train-secondary" type="button" disabled>一時停止</button><button id="train-cancel" class="train-secondary" type="button" disabled>中止</button></div>
    <div id="train-message" class="message-box" hidden></div><pre id="train-log" class="train-log" hidden></pre>
    <div id="train-result" class="train-result" hidden><div class="train-result-head"><div><p class="eyebrow">生成結果</p><h4>3D Gaussian Splatting</h4></div><span>生成完了</span></div><div id="train-result-meta" class="train-result-meta"></div><div class="train-result-actions"><button id="train-download" class="train-primary" type="button">3DGS PLYを保存</button><button id="train-show" class="train-secondary" type="button">この画面で3D表示</button></div><div id="train-viewer" class="train-viewer" hidden></div></div>
    <p class="train-note">学習回数・画像解像度・Gaussian上限は端末性能から自動設定します。WebGPUを利用できない端末では、従来どおり学習データZIPの保存まで利用できます。</p>`;
  ds.insertAdjacentElement('afterend', p);
  p.querySelector('#train-start').addEventListener('click', trStartLatest);
  p.querySelector('#train-pause').addEventListener('click', trTogglePause);
  p.querySelector('#train-cancel').addEventListener('click', trCancel);
  return p;
}

function trMsg(text, kind='warning') { const e=trPanel()?.querySelector('#train-message'); if(!e)return; e.hidden=false; e.className=`message-box ${kind}`; e.textContent=text; }
function trLog(text) { const e=trPanel()?.querySelector('#train-log'); if(!e)return; e.hidden=false; e.textContent += `${new Date().toLocaleTimeString()}  ${text}\n`; e.scrollTop=e.scrollHeight; }
function trProgress(pct,text){const p=trPanel();if(!p)return;p.querySelector('#train-progress-bar').style.width=`${Math.max(0,Math.min(100,pct))}%`;p.querySelector('#train-progress-label').textContent=text;if(trPageProgress)trPageProgress.textContent=text;}
function trButtons(active){const p=trPanel();if(!p)return;p.querySelector('#train-start').disabled=active;p.querySelector('#train-pause').disabled=!active;p.querySelector('#train-cancel').disabled=!active;}
function trSelect(n){if(n<=TR_MAX_FRAMES)return Array.from({length:n},(_,i)=>i);const a=[];for(let i=0;i<TR_MAX_FRAMES;i++)a.push(Math.round(i*(n-1)/(TR_MAX_FRAMES-1)));return [...new Set(a)];}
function trMul(a,b){const o=new Array(9).fill(0);for(let r=0;r<3;r++)for(let c=0;c<3;c++)o[r*3+c]=a[r*3]*b[c]+a[r*3+1]*b[c+3]+a[r*3+2]*b[c+6];return o;}
function trT(m){return[m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]];}
function trMv(m,v){return[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];}
function trYaw(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[c,0,s,0,1,0,-s,0,c];}
function trQuat(R){const t=R[0]+R[4]+R[8];let w,x,y,z;if(t>0){const s=Math.sqrt(t+1)*2;w=.25*s;x=(R[7]-R[5])/s;y=(R[2]-R[6])/s;z=(R[3]-R[1])/s;}else if(R[0]>R[4]&&R[0]>R[8]){const s=Math.sqrt(1+R[0]-R[4]-R[8])*2;w=(R[7]-R[5])/s;x=.25*s;y=(R[1]+R[3])/s;z=(R[2]+R[6])/s;}else if(R[4]>R[8]){const s=Math.sqrt(1+R[4]-R[0]-R[8])*2;w=(R[2]-R[6])/s;x=(R[1]+R[3])/s;y=.25*s;z=(R[5]+R[7])/s;}else{const s=Math.sqrt(1+R[8]-R[0]-R[4])*2;w=(R[3]-R[1])/s;x=(R[2]+R[6])/s;y=(R[5]+R[7])/s;z=.25*s;}const n=Math.hypot(w,x,y,z)||1;return[w/n,x/n,y/n,z/n];}

async function trSeek(time){if(!trVideo||!Number.isFinite(trVideo.duration))throw new Error('動画を参照できません。');const v=Math.max(0,Math.min(trVideo.duration-.001,time));if(Math.abs(trVideo.currentTime-v)<.008&&trVideo.readyState>=2)return;await new Promise((res,rej)=>{const tm=setTimeout(()=>{off();rej(new Error('学習用フレーム取得がタイムアウトしました。'));},12000);const ok=()=>{off();res();},ng=()=>{off();rej(new Error('動画フレームを取得できません。'));},off=()=>{clearTimeout(tm);trVideo.removeEventListener('seeked',ok);trVideo.removeEventListener('error',ng);};trVideo.addEventListener('seeked',ok,{once:true});trVideo.addEventListener('error',ng,{once:true});trVideo.currentTime=v;});}
function trRenderer(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext('webgl', { alpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('このブラウザでは学習画像の透視変換に必要なWebGLを利用できません。');

  const vs = `attribute vec2 aPos; varying vec2 vUv; void main(){vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0);}`;
  const fsHigh = `precision highp float; varying vec2 vUv; uniform sampler2D uPano; uniform float uYaw; uniform float uHalfFov; const float PI=3.141592653589793; void main(){vec3 local=normalize(vec3((vUv.x*2.0-1.0)*uHalfFov,(vUv.y*2.0-1.0)*uHalfFov,1.0));float c=cos(uYaw),s=sin(uYaw);vec3 d=vec3(local.x*c+local.z*s,local.y,-local.x*s+local.z*c);float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.0,1.0));float u=clamp(lon/(2.0*PI)+0.5,0.0,1.0);float v=clamp(lat/PI+0.5,0.0,1.0);gl_FragColor=texture2D(uPano,vec2(u,v));}`;
  const fsMedium = fsHigh.replace('precision highp float;', 'precision mediump float;');

  const compile = (type, src, label) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader) || '詳細不明';
      gl.deleteShader(shader);
      throw new Error(`${label}シェーダーを作成できません: ${info}`);
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, vs, '頂点');
  let fragment;
  try {
    fragment = compile(gl.FRAGMENT_SHADER, fsHigh, '透視変換');
  } catch (highError) {
    trLog(`highp shader fallback: ${highError.message}`);
    fragment = compile(gl.FRAGMENT_SHADER, fsMedium, '透視変換');
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || '詳細不明';
    throw new Error(`透視変換を初期化できません: ${info}`);
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform1i(gl.getUniformLocation(program, 'uPano'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'uHalfFov'), Math.tan(TR_FOV * Math.PI / 360));
  const yawLoc = gl.getUniformLocation(program, 'uYaw');
  gl.viewport(0, 0, size, size);

  return {
    canvas,
    render(video, yawDeg) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) throw new Error(`動画テクスチャをWebGLへ転送できませんでした (${uploadError})。`);
      gl.uniform1f(yawLoc, yawDeg * Math.PI / 180);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.finish();
      const renderError = gl.getError();
      if (renderError !== gl.NO_ERROR) throw new Error(`透視画像を描画できませんでした (${renderError})。`);
    },
  };
}
function trJpeg(c){return new Promise((r,j)=>c.toBlob(b=>b?r(b):j(new Error('学習画像を書き出せません。')),'image/jpeg',.9));}
function trInitPly(tracks){const a=(tracks||[]).filter(t=>t.position?.every(Number.isFinite)).slice(0,5000);const h=`ply\nformat ascii 1.0\nelement vertex ${a.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;return new Blob([h,a.map(t=>`${t.position[0]} ${t.position[1]} ${t.position[2]} 160 160 160`).join('\n'),'\n'],{type:'application/octet-stream'});}
async function trDir(p,n){return p.getDirectoryHandle(n,{create:true});}
async function trWrite(root,path,data){const q=path.split('/');let d=root;for(let i=0;i<q.length-1;i++)d=await trDir(d,q[i]);const f=await d.getFileHandle(q.at(-1),{create:true}),w=await f.createWritable();await w.write(data);await w.close();}
async function trBuildDataset(item,id){if(!navigator.storage?.getDirectory)throw new Error('ブラウザ内の一時学習領域を利用できません。Chrome / Edgeを使用してください。');const root=await navigator.storage.getDirectory(),base=await trDir(root,'360gs-brush'),dn=`segment-${item.source.segment.id}`;try{await base.removeEntry(dn,{recursive:true});}catch{}const dir=await trDir(base,dn),sel=trSelect(Math.min(item.optimization.poses.length,item.source.frames.length));const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,rr=trRenderer(size),focal=(size/2)/Math.tan(TR_FOV*Math.PI/360);await trWrite(dir,'sparse/0/cameras.txt',`# CAMERA_ID MODEL WIDTH HEIGHT PARAMS\n1 PINHOLE ${size} ${size} ${focal} ${focal} ${size/2} ${size/2}\n`);await trWrite(dir,'sparse/0/points3D.txt','# Empty points; Brush random initialization is used for browser training.\n');const lines=['# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME'];let iid=1,made=0;for(let o=0;o<sel.length;o++){if(id!==trRunId)throw new Error('処理が更新されました。');const fi=sel[o],pose=item.optimization.poses[fi],tm=item.source.frames[fi].time;await trSeek(tm);for(let k=0;k<4;k++){rr.render(trVideo,TR_YAWS[k]);const blob=await trJpeg(rr.canvas),name=`f${String(o).padStart(3,'0')}_${TR_NAMES[k]}.jpg`;await trWrite(dir,`images/${name}`,blob);const R=trT(trMul(pose.cameraToWorld,trYaw(TR_YAWS[k]))),pv=trMv(R,pose.position),q=trQuat(R);lines.push(`${iid} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${-pv[0]} ${-pv[1]} ${-pv[2]} 1 ${name}`,'');iid++;made++;trProgress(2+8*made/(sel.length*4),`Brush用データを準備しています ${made}/${sel.length*4}`);await new Promise(r=>setTimeout(r,0));}}await trWrite(dir,'sparse/0/images.txt',lines.join('\n')+'\n');return{dir,views:sel.length*4,size};}

function trPlan(size){const m=navigator.deviceMemory||4,c=navigator.hardwareConcurrency||4;if(m>=12&&c>=8)return{iters:2000,max:150000,res:Math.min(size,512),label:'互換優先'};if(m>=8&&c>=6)return{iters:1600,max:120000,res:Math.min(size,512),label:'互換優先'};return{iters:1200,max:80000,res:Math.min(size,384),label:'省メモリ'};}
async function trRuntimeReady(){if(trRuntime)return trRuntime;if(!navigator.gpu)throw new Error('WebGPUが利用できません。Chrome / Edgeの最新版とWebGPU対応GPUが必要です。');let mod;try{mod=await import(`${TR_BRUSH}?v=0.3c0`);}catch(e){throw new Error('Brush学習エンジンを読み込めません。WASMの準備完了後にページを再読み込みしてください。');}await mod.default(new URL('./vendor/brush-js/brush_js_bg.wasm?v=0.3c0', window.location.href));const ad=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!ad)throw new Error('WebGPUアダプターを取得できません。');const ai=ad.info||{};trLog(`WebGPU adapter: ${ai.vendor||'unknown'} / ${ai.architecture||ai.device||ai.description||'unknown'}`);const ft=[...ad.features].filter(x=>x!=='mappable-primary-buffers'),lm={};for(const k in ad.limits){const v=ad.limits[k];if(typeof v==='number')lm[k]=v;}let dev;try{dev=await ad.requestDevice({requiredFeatures:ft,requiredLimits:lm});}catch{dev=await ad.requestDevice();}const app=new mod.BrushApp();trProgress(1.5,'BrushのGPU共有初期化を完了しています');await app.initExisting(ad,dev,dev.queue);const lostPromise=dev.lost.then(info=>{throw new Error(`WebGPUデバイスが失われました: ${info?.message||info?.reason||'unknown'}`);});const progressApi=typeof mod.trainingDiagStage==='function';trRuntime={mod,device:dev,app,progressApi,lostPromise};return trRuntime;}
function trKind(mod,msg){for(const[k,v]of Object.entries(mod.BrushMessageKind||{}))if(v===msg.kind&&Number.isNaN(Number(k)))return k;return String(msg.kind);}
function trApply(rt,msg,plan){
  const p=trPanel(),k=trKind(rt.mod,msg);
  if(k==='NewProcess'){
    trProgress(11,'Brushの処理を開始しました');
    trLog('Brush process started');
  }
  if(k==='StartLoading'){
    const name=msg.name||'データセット';
    trProgress(12,`Brush: ${name} を読み込んでいます`);
    trLog(`Loading ${name}`);
  }
  if(k==='DatasetLoaded'){
    const n=msg.trainViews??0;
    p.querySelector('#train-views').textContent=`${n}枚`;
    trProgress(15,`Brushが学習画像 ${n}枚を認識しました`);
    trLog(`Dataset loaded: ${n} train views / ${msg.evalViews??0} eval views`);
  }
  if(k==='SplatsUpdated'){
    if(msg.numSplats!=null)p.querySelector('#train-splats').textContent=Number(msg.numSplats).toLocaleString();
    trProgress(17,'初期Gaussianを準備しています');
    if(msg.numSplats!=null)trLog(`Initial splats: ${Number(msg.numSplats).toLocaleString()}`);
  }
  if(k==='DoneLoading'){
    trProgress(19,'データセットと初期Gaussianの準備が完了しました');
    trLog('Brush loading done');
  }
  if(k==='RefineStep'&&msg.numSplats!=null)p.querySelector('#train-splats').textContent=Number(msg.numSplats).toLocaleString();
  if(k==='TrainStep'){
    const i=msg.iter??0;
    p.querySelector('#train-iter').textContent=`${i.toLocaleString()} / ${plan.iters.toLocaleString()}`;
    if(msg.elapsedMs!=null)p.querySelector('#train-elapsed').textContent=`${(msg.elapsedMs/1000).toFixed(1)}秒`;
    trProgress(20+77*i/plan.iters,`3DGSを学習しています ${Math.min(100,Math.round(i/plan.iters*100))}%`);
  }
  if(k==='EvalResult'){
    if(msg.psnr!=null)p.querySelector('#train-psnr').textContent=Number(msg.psnr).toFixed(2);
    if(msg.ssim!=null)p.querySelector('#train-ssim').textContent=Number(msg.ssim).toFixed(3);
  }
  if(k==='DoneTraining')trLog('Brush training done');
  if(k==='Warning'&&msg.text){
    const tx=String(msg.text);
    if(tx.startsWith('360GS_STAGE:')){
      const stage=tx.slice('360GS_STAGE:'.length).trim();
      const labels={
        post_loading_enter:'Brush学習環境の後処理を開始しました',
        bounds_begin:'Gaussian境界を計算しています',
        bounds_done:'Gaussian境界の計算が完了しました',
        view_cams_begin:'学習カメラ情報を準備しています',
        view_cams_done:'学習カメラ情報を準備できました',
        trainer_ready:'学習器の準備が完了しました',
        first_batch_begin:'最初の学習画像をGPU用に取得しています',
        first_batch_ready:'最初の学習画像を取得できました',
        autodiff_begin:'Gaussianを自動微分用に準備しています',
        autodiff_ready:'Gaussianの自動微分準備が完了しました',
        trainer_step_begin:'レンダリング・損失計算・逆伝播を実行しています',
        trainer_step_done:'最初のGPU学習計算が完了しました'
      };
      trProgress(20,labels[stage]||`Brush内部処理: ${stage}`);
      trLog(`Brush stage: ${stage}`);
    }else trLog(`Brush warning: ${tx}`);
  }
}

function trDiagStageLabel(stage){
  const labels={
    100:'Brush trainer.step に入りました',
    110:'Gaussianを画像へレンダリングしています',
    120:'Gaussianレンダリングが完了しました',
    130:'画像損失を構築しています',
    140:'画像損失マップの構築が完了しました',
    141:'画像損失をスカラーへ集約しています',
    142:'画像損失の集約が完了しました',
    145:'損失テンソルを確定しています',
    146:'損失テンソルの確定が完了しました',
    150:'逆伝播を実行しています',
    160:'逆伝播が完了しました',
    161:'refinement用の統計を蓄積しています',
    162:'refinement用統計の蓄積が完了しました',
    165:'Optimizerの状態を準備しています',
    166:'Optimizerの準備が完了しました',
    170:'位置・回転・スケールを更新しています',
    171:'位置・回転・スケールの更新が完了しました',
    172:'色（SH係数）を更新しています',
    173:'色（SH係数）の更新が完了しました',
    174:'不透明度を更新しています',
    175:'不透明度の更新が完了しました',
    180:'Optimizer更新が完了しました',
    190:'Gaussianの探索ノイズを更新しています',
    195:'Gaussian探索ノイズの更新が完了しました',
    200:'GPU学習1ステップの内部処理が完了しました',
    210:'ブラウザ向け固定Gaussian更新を実行しています',
    211:'refinement統計をリセットしています',
    219:'refinement統計のリセットが完了しました',
    220:'固定Gaussian更新が完了しました'
  };
  return labels[stage]||'';
}

async function trWaitStage(promise, timeoutMs, label, training, rt){
  let timer,heartbeat,lastDiagStage=-1;
  const started=performance.now();
  const p=trPanel();
  const tick=()=>{
    const sec=Math.max(0,Math.floor((performance.now()-started)/1000));
    const maxSec=Math.round(timeoutMs/1000);
    p?.querySelector('#train-elapsed') && (p.querySelector('#train-elapsed').textContent=`${sec}秒`);
    const base=label.includes('GPU')?20:12;
    let detail='';
    if(label.includes('GPU')&&typeof rt?.mod?.trainingDiagStage==='function'){
      const stage=Number(rt.mod.trainingDiagStage());
      const stageLabel=trDiagStageLabel(stage);
      if(stage!==lastDiagStage){
        lastDiagStage=stage;
        if(stageLabel)trLog(`GPU internal stage ${stage}: ${stageLabel}`);
      }
      if(stageLabel)detail=` / ${stageLabel}`;
    }
    trProgress(base,`${label}を実行中（${sec}秒 / 最大${maxSec}秒）${detail}`);
  };
  tick();
  heartbeat=setInterval(tick,1000);
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      try{training?.free();}catch{}
      if(trTraining===training)trTraining=null;
      reject(new Error(`${label}が${Math.round(timeoutMs/60000)}分以上応答しませんでした。処理を安全に停止しました。`));
    },timeoutMs);
  });
  const races=[promise,timeout];
  if(rt?.lostPromise)races.push(rt.lostPromise);
  try{return await Promise.race(races);}
  finally{clearTimeout(timer);clearInterval(heartbeat);}
}

function trTogglePause(){if(!trRunning)return;trPaused=!trPaused;const b=trPanel().querySelector('#train-pause');b.textContent=trPaused?'再開':'一時停止';if(!trPaused&&trResume){trResume();trResume=null;}trMsg(trPaused?'学習を一時停止しました。':'学習を再開しました。',trPaused?'warning':'success');}
function trCancel(){if(!trRunning)return;trCancelled=true;trPaused=false;if(trResume){trResume();trResume=null;}try{trTraining?.free();}catch{}trTraining=null;trButtons(false);trMsg('3DGS学習を中止しました。','warning');}

async function trRead(dev,src){const b=dev.createBuffer({size:src.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=dev.createCommandEncoder();e.copyBufferToBuffer(src,0,b,0,src.size);dev.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const a=b.getMappedRange().slice(0);b.unmap();b.destroy();return new Float32Array(a);}
function trPly(n,deg,t,sh,op){const nc=(deg+1)**2,nrest=3*(nc-1),props=['property float x','property float y','property float z','property float nx','property float ny','property float nz','property float f_dc_0','property float f_dc_1','property float f_dc_2'];for(let i=0;i<nrest;i++)props.push(`property float f_rest_${i}`);props.push('property float opacity','property float scale_0','property float scale_1','property float scale_2','property float rot_0','property float rot_1','property float rot_2','property float rot_3');const hb=new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment Generated by 360GS with Brush\ncomment SH degree: ${deg}\nelement vertex ${n}\n${props.join('\n')}\nend_header\n`),floats=3+3+3+nrest+1+3+4,out=new ArrayBuffer(hb.length+n*floats*4);new Uint8Array(out,0,hb.length).set(hb);const d=new DataView(out);let o=hb.length;const w=v=>{d.setFloat32(o,Number.isFinite(v)?v:0,true);o+=4;};for(let i=0;i<n;i++){const z=i*10,s=i*nc*3;w(t[z]);w(t[z+1]);w(t[z+2]);w(0);w(0);w(0);w(sh[s]);w(sh[s+1]);w(sh[s+2]);for(let ch=0;ch<3;ch++)for(let c=1;c<nc;c++)w(sh[s+c*3+ch]);w(op[i]);w(t[z+7]);w(t[z+8]);w(t[z+9]);const qn=Math.hypot(t[z+3],t[z+4],t[z+5],t[z+6])||1;w(t[z+3]/qn);w(t[z+4]/qn);w(t[z+5]/qn);w(t[z+6]/qn);}return new Blob([out],{type:'application/octet-stream'});}
async function trExport(rt,training){const s=training.currentSplats();if(!s||!s.numSplats)throw new Error('学習結果のGaussianを取得できません。');const b=s.buffers();if(!b)throw new Error('GPU上のGaussianを取得できません。');trProgress(98,'3DGSをPLYへ変換しています');const[t,h,o]=await Promise.all([trRead(rt.device,b.transforms),trRead(rt.device,b.shCoeffs),trRead(rt.device,b.rawOpacities)]);return{blob:trPly(s.numSplats,s.shDegree,t,h,o),count:s.numSplats,degree:s.shDegree};}
function trDownload(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),30000);}

async function trShow(blob){const wrap=trPanel().querySelector('#train-viewer');wrap.hidden=false;wrap.replaceChildren();trViewerCleanup?.();if(trResultUrl)URL.revokeObjectURL(trResultUrl);trResultUrl=URL.createObjectURL(blob);const pc=await import('https://cdn.jsdelivr.net/npm/playcanvas@2.21.4/build/playcanvas.mjs'),cv=document.createElement('canvas');cv.className='train-viewer-canvas';wrap.append(cv);const app=new pc.Application(cv,{graphicsDeviceOptions:{antialias:false,alpha:false}});app.start();const cam=new pc.Entity('Camera');cam.addComponent('camera',{clearColor:new pc.Color(.055,.067,.086),fov:55,nearClip:.001,farClip:10000});app.root.addChild(cam);const as=new pc.Asset('360GS','gsplat',{url:trResultUrl,filename:'360gs_result.ply',size:blob.size});app.assets.add(as);await new Promise((r,j)=>{as.once('load',r);as.once('error',j);app.assets.load(as);});const sp=new pc.Entity('3DGS');sp.addComponent('gsplat',{asset:as});app.root.addChild(sp);let rad=1.5;const bb=as.resource?.aabb;if(bb){sp.setPosition(-bb.center.x,-bb.center.y,-bb.center.z);rad=Math.max(.1,Math.hypot(bb.halfExtents.x,bb.halfExtents.y,bb.halfExtents.z));}let y=0,pi=.08,di=rad*2.4,drag=false,lx=0,ly=0;const up=()=>{const cp=Math.cos(pi);cam.setPosition(di*Math.sin(y)*cp,di*Math.sin(pi),di*Math.cos(y)*cp);cam.lookAt(0,0,0);};cv.addEventListener('pointerdown',e=>{drag=true;lx=e.clientX;ly=e.clientY;cv.setPointerCapture(e.pointerId);});cv.addEventListener('pointermove',e=>{if(!drag)return;y-=(e.clientX-lx)*.006;pi=Math.max(-1.45,Math.min(1.45,pi-(e.clientY-ly)*.006));lx=e.clientX;ly=e.clientY;up();});cv.addEventListener('pointerup',()=>drag=false);cv.addEventListener('wheel',e=>{e.preventDefault();di=Math.max(rad*.05,Math.min(rad*30,di*Math.exp(e.deltaY*.0012)));up();},{passive:false});const ro=new ResizeObserver(()=>app.resizeCanvas(Math.max(1,wrap.clientWidth),Math.max(1,wrap.clientHeight)));ro.observe(wrap);up();app.resizeCanvas(wrap.clientWidth,wrap.clientHeight);trViewerCleanup=()=>{ro.disconnect();app.destroy();};}

async function trRun(item){
  if(trRunning)return;
  const id=++trRunId;
  trRunning=true;trCancelled=false;trPaused=false;
  const p=trPanel();
  p.hidden=false;
  p.querySelector('#train-result').hidden=true;
  p.querySelector('#train-log').textContent='';
  p.querySelector('#train-log').hidden=true;
  p.querySelector('#train-message').hidden=true;
  p.querySelector('#train-webgpu').textContent=navigator.gpu?'利用可':'利用不可';
  p.querySelector('#train-splats').textContent='—';
  p.querySelector('#train-elapsed').textContent='—';
  p.querySelector('#train-psnr').textContent='—';
  p.querySelector('#train-ssim').textContent='—';
  trButtons(true);
  try{
    trProgress(1,'Brush学習エンジンを初期化しています');
    const rt=await trRuntimeReady();
    if(id!==trRunId)return;
    trLog('Brush WebGPU runtime ready');

    trProgress(2,'Brush用の学習画像を準備しています');
    const ds=await trBuildDataset(item,id),plan=trPlan(ds.size);
    trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px`);
    p.querySelector('#train-views').textContent=`${ds.views}枚`;
    p.querySelector('#train-plan').textContent=`${plan.label} ${plan.iters.toLocaleString()}回`;
    p.querySelector('#train-iter').textContent=`0 / ${plan.iters.toLocaleString()}`;

    trProgress(10,'Brushへデータセットを渡しています');
    const t=rt.app.startTrainingFromDirectory(ds.dir,async init=>{
      trLog('Brush training configuration received');
      const c={...init};
      if('total-train-iters'in c)c['total-train-iters']=plan.iters;
      if('max-splats'in c)c['max-splats']=plan.max;
      if('max-resolution'in c)c['max-resolution']=plan.res;
      const refineEvery=Math.max(32,Math.min(64,Math.max(1,Math.round(ds.views/10))*10));
      if('refine-every'in c)c['refine-every']=refineEvery;
      if('eval-every'in c)c['eval-every']=Math.max(500,Math.floor(plan.iters/4));if('sh-degree'in c)c['sh-degree']=0;
      trLog(`Training config: ${plan.iters} iterations / fixed browser Gaussian budget / ${plan.res}px / SH degree 0 / stats reset every ${refineEvery} / random initialization`);
      return c;
    });
    trTraining=t;
    trLog('Brush training process created');

    let loaded=false,loadEvents=0;
    if(rt.progressApi){
      trLog('Brush staged loading progress API available');
      while(!loaded&&!trCancelled){
        const msgs=await trWaitStage(t.trainSteps(0),120000,'Brushのデータ読み込み',t,rt);
        if(!msgs.length)throw new Error('Brushのデータ読み込みストリームが学習開始前に終了しました。');
        for(const m of msgs){
          const kind=trKind(rt.mod,m);
          trApply(rt,m,plan);
          if(kind==='DoneLoading')loaded=true;
        }
        loadEvents+=msgs.length;
        if(loadEvents>100)throw new Error('Brushの初期化イベントが通常より多く、学習開始まで到達できませんでした。');
        await new Promise(r=>setTimeout(r,0));
      }
      if(trCancelled)return;
      if(!loaded)throw new Error('Brushのデータセット初期化を完了できませんでした。');
    }else{
      trLog('Brush staged progress runtime is not active yet; using compatible startup mode');
      trProgress(12,'Brushデータセットを読み込み、最初のGPU計算を準備しています');
    }

    trProgress(20,'最初のGPU学習ステップを準備しています');
    trLog('Starting first GPU training step');
    let done=false,firstStep=true;
    while(!done&&!trCancelled){
      while(trPaused)await new Promise(r=>trResume=r);
      if(trCancelled)break;
      const batch=firstStep?1:TR_BATCH;
      const waitMs=firstStep?300000:180000;
      const label=firstStep?'最初のGPU学習ステップ':'GPU学習ステップ';
      let msgs=[];
      if(firstStep&&rt.progressApi){
        let sawStep=false;
        while(!sawStep&&!done&&!trCancelled){
          const one=await trWaitStage(t.trainSteps(0),waitMs,label,t,rt);
          if(!one.length)break;
          msgs.push(...one);
          for(const m of one){
            const kk=trKind(rt.mod,m);
            trApply(rt,m,plan);
            if(kk==='TrainStep')sawStep=true;
            if(kk==='DoneTraining')done=true;
          }
          await new Promise(r=>setTimeout(r,0));
        }
        if(!sawStep&&!done&&!trCancelled)throw new Error('Brush内部診断は完了しましたが、最初のTrainStepまで到達できませんでした。');
      }else{
        msgs=await trWaitStage(t.trainSteps(batch),waitMs,label,t,rt);
        for(const m of msgs){
          trApply(rt,m,plan);
          if(trKind(rt.mod,m)==='DoneTraining')done=true;
        }
      }
      if(!msgs.length)break;
      if(firstStep){
        firstStep=false;
        trLog('First GPU training step completed');
      }
      await new Promise(r=>setTimeout(r,0));
    }
    if(trCancelled)return;
    if(firstStep)throw new Error('GPU学習の最初のステップを完了できませんでした。');

    const ex=await trExport(rt,t),res=p.querySelector('#train-result');
    res.hidden=false;
    res.querySelector('#train-result-meta').textContent=`${ex.count.toLocaleString()} Gaussians / SH degree ${ex.degree} / ${(ex.blob.size/1024/1024).toFixed(1)} MB`;
    res.querySelector('#train-download').onclick=()=>trDownload(ex.blob,`360gs_segment_${item.source.segment.id}.ply`);
    res.querySelector('#train-show').onclick=()=>trShow(ex.blob).catch(e=>trMsg(`3D表示: ${e?.message||e}`,'warning'));
    trProgress(100,'3DGS生成が完了しました');
    trMsg('3DGS学習が完了しました。PLYとして保存するか、この画面で3D表示できます。','success');
    window.__360gsTrainingResult={ready:true,blob:ex.blob,count:ex.count,segmentId:item.source.segment.id};
    window.dispatchEvent(new CustomEvent('360gs:training-ready',{detail:{ready:true,count:ex.count,segmentId:item.source.segment.id}}));
  }catch(e){
    trProgress(0,'3DGS学習を継続できませんでした');
    trMsg(e?.message||String(e),'warning');
    trLog(String(e?.stack||e));
  }finally{
    trRunning=false;trTraining=null;trButtons(false);
  }
}
function trLatest(){return window.__360gsBundleResult?.good?.[0]||null;}
function trStartLatest(){const x=trLatest();if(!x){trMsg('全体最適化が良好な区間がまだありません。','warning');return;}trRun(x);}
function trDatasetReady(ev){const p=trPanel();if(!p)return;p.hidden=false;p.querySelector('#train-webgpu').textContent=navigator.gpu?'利用可':'利用不可';if(!ev.detail?.ready){trMsg('学習画像の品質確認を通過した区間がないため、3DGS学習は開始しません。','warning');return;}if(!navigator.gpu){trMsg('学習データは準備できましたが、この端末ではWebGPUを利用できません。ZIP保存は利用できます。','warning');return;}trMsg('画像品質を確認できました。3DGS学習を自動開始します。','success');setTimeout(()=>{if(!trRunning)trStartLatest();},900);}
window.addEventListener('360gs:dataset-ready',trDatasetReady);
trVideo?.addEventListener('loadedmetadata',()=>{trRunId++;trCancelled=true;try{trTraining?.free();}catch{}trTraining=null;trRunning=false;const p=document.querySelector('#train-panel');if(p)p.hidden=true;window.__360gsTrainingResult=null;});
if(window.__360gsDatasetResult?.ready)setTimeout(()=>trDatasetReady({detail:window.__360gsDatasetResult}),500);
document.querySelectorAll('.version').forEach(n=>n.textContent='Prototype v0.3c0');
const trHero=document.querySelector('.video-hero .eyebrow');if(trHero)trHero.textContent='Step 10 / Brush WebGPU 3DGS学習';
