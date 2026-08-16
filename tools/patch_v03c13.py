from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"patch target not found: {label}")
    return text.replace(old, new, 1)


# v0.3c13 projection/camera experiment.
# c12 raised the high-tier Gaussian count from 34,992 to 46,128 but changed
# train PSNR only 19.86 -> 19.88 dB and held-out PSNR 18.90 -> 18.88 dB.
# Keep SH1, density, optimizer horizon and browser-safe growth fixed, and
# change the panorama decomposition from four 100-degree equatorial tangent
# views to a complete six-face 90-degree cubemap.

# ---- Brush: six faces belong to one original 360-degree source position ----
p = Path('_brush/crates/brush-dataset/src/formats/mod.rs')
s = p.read_text()
s = replace_once(
    s,
    '''            // 360GS writes four contiguous perspective views (front/right/back/left)\n            // for every original 360-degree source position. Keep all four views\n            // together so evaluation measures a genuinely unseen camera position.\n            let source_group = i / 4;''',
    '''            // 360GS c13 writes six contiguous cubemap faces\n            // (front/right/back/left/up/down) for every original 360-degree\n            // source position. Keep all six together so evaluation measures a\n            // genuinely unseen camera position rather than an unseen direction.\n            let source_group = i / 6;''',
    'six-face held-out source grouping',
)
p.write_text(s)

p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
s = replace_once(
    s,
    '''    // Evaluate complete four-direction groups instead of isolated images.\n    // This avoids direction-specific bias in the train-fit metric.\n    let mut indices = Vec::<usize>::new();\n    let groups = n / 4;\n    if groups > 0 {\n        let target_groups = groups.min(2);\n        for k in 0..target_groups {\n            let g = if target_groups <= 1 { groups / 2 } else { k * (groups - 1) / (target_groups - 1) };\n            for j in 0..4 {\n                let idx = g * 4 + j;\n                if idx < n {\n                    indices.push(idx);\n                }\n            }\n        }\n    } else {\n        indices.extend(0..n.min(4));\n    }\n''',
    '''    // Evaluate complete six-face cubemap groups instead of isolated images.\n    // This keeps the training metric balanced over the full sphere.\n    let mut indices = Vec::<usize>::new();\n    let groups = n / 6;\n    if groups > 0 {\n        let target_groups = groups.min(2);\n        for k in 0..target_groups {\n            let g = if target_groups <= 1 { groups / 2 } else { k * (groups - 1) / (target_groups - 1) };\n            for j in 0..6 {\n                let idx = g * 6 + j;\n                if idx < n {\n                    indices.push(idx);\n                }\n            }\n        }\n    } else {\n        indices.extend(0..n.min(6));\n    }\n''',
    'six-face train-fit groups',
)
p.write_text(s)

# ---- Frontend projection model ----
p = Path('training.js')
s = p.read_text()
s = replace_once(
    s,
    "const TR_FOV = 100;\nconst TR_YAWS = [0, 90, 180, 270];\nconst TR_NAMES = ['front', 'right', 'back', 'left'];",
    "const TR_FOV = 90;\nconst TR_FACES = [\n  {name:'front',yaw:0,pitch:0},\n  {name:'right',yaw:90,pitch:0},\n  {name:'back',yaw:180,pitch:0},\n  {name:'left',yaw:270,pitch:0},\n  {name:'up',yaw:0,pitch:-90},\n  {name:'down',yaw:0,pitch:90},\n];",
    'six cubemap face constants',
)
s = replace_once(
    s,
    "function trYaw(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[c,0,s,0,1,0,-s,0,c];}\n",
    "function trYaw(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[c,0,s,0,1,0,-s,0,c];}\nfunction trPitch(d){const a=d*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return[1,0,0,0,c,-s,0,s,c];}\nfunction trFaceRot(face){return trMul(trYaw(face.yaw),trPitch(face.pitch));}\n",
    'pitch and cubemap face rotation',
)

old_shader = "const fsHigh = `precision highp float; varying vec2 vUv; uniform sampler2D uPano; uniform float uYaw; uniform float uHalfFov; const float PI=3.141592653589793; void main(){vec3 local=normalize(vec3((vUv.x*2.0-1.0)*uHalfFov,(vUv.y*2.0-1.0)*uHalfFov,1.0));float c=cos(uYaw),s=sin(uYaw);vec3 d=vec3(local.x*c+local.z*s,local.y,-local.x*s+local.z*c);float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.0,1.0));float u=clamp(lon/(2.0*PI)+0.5,0.0,1.0);float v=clamp(lat/PI+0.5,0.0,1.0);gl_FragColor=texture2D(uPano,vec2(u,v));}`;"
new_shader = "const fsHigh = `precision highp float; varying vec2 vUv; uniform sampler2D uPano; uniform float uYaw; uniform float uPitch; uniform float uHalfFov; const float PI=3.141592653589793; void main(){vec3 local=normalize(vec3((vUv.x*2.0-1.0)*uHalfFov,(vUv.y*2.0-1.0)*uHalfFov,1.0));float cp=cos(uPitch),sp=sin(uPitch);vec3 pitched=vec3(local.x,local.y*cp-local.z*sp,local.y*sp+local.z*cp);float c=cos(uYaw),s=sin(uYaw);vec3 d=vec3(pitched.x*c+pitched.z*s,pitched.y,-pitched.x*s+pitched.z*c);float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.0,1.0));float u=clamp(lon/(2.0*PI)+0.5,0.0,1.0);float v=clamp(lat/PI+0.5,0.0,1.0);gl_FragColor=texture2D(uPano,vec2(u,v));}`;"
s = replace_once(s, old_shader, new_shader, 'cubemap renderer shader pitch support')
s = replace_once(s, "  const yawLoc = gl.getUniformLocation(program, 'uYaw');\n", "  const yawLoc = gl.getUniformLocation(program, 'uYaw');\n  const pitchLoc = gl.getUniformLocation(program, 'uPitch');\n", 'renderer pitch uniform')
s = replace_once(s, "    render(video, yawDeg) {", "    render(video, yawDeg, pitchDeg=0) {", 'renderer pitch argument')
s = replace_once(s, "      gl.uniform1f(yawLoc, yawDeg * Math.PI / 180);\n      gl.drawArrays(gl.TRIANGLES, 0, 6);", "      gl.uniform1f(yawLoc, yawDeg * Math.PI / 180);\n      gl.uniform1f(pitchLoc, pitchDeg * Math.PI / 180);\n      gl.drawArrays(gl.TRIANGLES, 0, 6);", 'renderer pitch upload')

s = replace_once(
    s,
    "    const pose=cams[Math.floor(rng()*cams.length)],yaw=TR_YAWS[Math.floor(rng()*TR_YAWS.length)];\n    const dx=(rng()*2-1)*half,dy=(rng()*2-1)*half,local=[dx,dy,1];\n    const R=trMul(pose.cameraToWorld,trYaw(yaw)),v=trMv(R,local),n=Math.hypot(v[0],v[1],v[2])||1;",
    "    const pose=cams[Math.floor(rng()*cams.length)],face=TR_FACES[Math.floor(rng()*TR_FACES.length)];\n    const dx=(rng()*2-1)*half,dy=(rng()*2-1)*half,local=[dx,dy,1];\n    const R=trMul(pose.cameraToWorld,trFaceRot(face)),v=trMv(R,local),n=Math.hypot(v[0],v[1],v[2])||1;",
    'seed full-sphere cubemap sampling',
)

old_loop = '''    for(let k=0;k<4;k++){\n      rr.render(trVideo,TR_YAWS[k]);\n      const blob=await trJpeg(rr.canvas),name=`f${String(o).padStart(3,'0')}_${TR_NAMES[k]}.jpg`;\n      await trWrite(dir,`images/${name}`,blob);\n      const Rcw=trReflectYMat(trMul(pose.cameraToWorld,trYaw(TR_YAWS[k]))),C=trReflectY3(pose.position),R=trT(Rcw),pv=trMv(R,C),q=trQuat(R);\n      lines.push(`${iid} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${-pv[0]} ${-pv[1]} ${-pv[2]} 1 ${name}`,'');\n      iid++;made++;trProgress(2+8*made/(sel.length*4),`Brush用データを準備しています ${made}/${sel.length*4}`);\n      await new Promise(r=>setTimeout(r,0));\n    }'''
new_loop = '''    for(let k=0;k<TR_FACES.length;k++){\n      const face=TR_FACES[k];\n      rr.render(trVideo,face.yaw,face.pitch);\n      const blob=await trJpeg(rr.canvas),name=`f${String(o).padStart(3,'0')}_${face.name}.jpg`;\n      await trWrite(dir,`images/${name}`,blob);\n      const Rcw=trReflectYMat(trMul(pose.cameraToWorld,trFaceRot(face))),C=trReflectY3(pose.position),R=trT(Rcw),pv=trMv(R,C),q=trQuat(R);\n      lines.push(`${iid} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${-pv[0]} ${-pv[1]} ${-pv[2]} 1 ${name}`,'');\n      iid++;made++;trProgress(2+8*made/(sel.length*TR_FACES.length),`Brush用6面cubemapを準備しています ${made}/${sel.length*TR_FACES.length}`);\n      await new Promise(r=>setTimeout(r,0));\n    }'''
s = replace_once(s, old_loop, new_loop, 'six-face dataset generation')
s = replace_once(s, "  return{dir,views:sel.length*4,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,seedScale:seed.sceneScale};", "  return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,seedScale:seed.sceneScale};", 'six-face dataset view count')

s = s.replace("label:'高品質・Gaussian密度比較'", "label:'高品質・6面cubemap投影比較'")
s = s.replace("label:'品質優先・Gaussian密度比較'", "label:'品質優先・6面cubemap投影比較'")
s = s.replace("label:'省メモリ・Gaussian密度比較'", "label:'省メモリ・6面cubemap投影比較'")
s = s.replace(" / SH degree 1 / source-position hold-out every 6th group", " / SH degree 1 / 6-face 90deg cubemap / source-position hold-out every 6th group")

s = s.replace('v0.3c12', 'v0.3c13').replace('v=0.3c12', 'v=0.3c13')
p.write_text(s)

for name in ['index.html', 'video.html', 'README.md']:
    q = Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c12', 'v0.3c13').replace('v=0.3c12', 'v=0.3c13'))

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c13\n'
    'Six-face 90-degree cubemap projection/camera comparison\n'
    'Primary change from v0.3c12: 4 equatorial 100-degree tangent views -> 6 complete 90-degree cubemap faces\n'
    'SH degree 1, c12 Gaussian density schedule, 512px limit, optimization horizon and adaptive stop unchanged\n'
    'Brush source-position holdout and train-fit diagnostics updated from 4-face to 6-face groups\n'
    'c12 baseline: 46,128 Gaussians; train 19.88 dB / 0.569; held-out 18.88 dB / 0.484; gap 1.00 dB\n'
    'Build date: 2026-08-16\n'
)
