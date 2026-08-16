from pathlib import Path

p = Path('training.js')
s = p.read_text(encoding='utf-8')

# BA/SfM uses +X right, +Y up, +Z forward. COLMAP/Brush pinhole uses
# +X right, +Y down, +Z forward. Convert both world and camera coordinates
# with F = diag(1,-1,1), preserving a proper rotation: R' = F R F.
if 'function trReflectY3(' not in s:
    anchor = "function trQuat(R){"
    insert = "function trReflectY3(v){return[v[0],-v[1],v[2]];}\nfunction trReflectYMat(m){return[m[0],-m[1],m[2],-m[3],m[4],-m[5],m[6],-m[7],m[8]];}\n"
    if anchor not in s:
        raise SystemExit('quaternion anchor not found')
    s = s.replace(anchor, insert + anchor, 1)

old_pose = "const R=trT(trMul(pose.cameraToWorld,trYaw(TR_YAWS[k]))),pv=trMv(R,pose.position),q=trQuat(R);"
new_pose = "const Rcw=trReflectYMat(trMul(pose.cameraToWorld,trYaw(TR_YAWS[k]))),C=trReflectY3(pose.position),R=trT(Rcw),pv=trMv(R,C),q=trQuat(R);"
if old_pose in s:
    s = s.replace(old_pose, new_pose, 1)
elif new_pose not in s:
    raise SystemExit('camera pose export anchor not found')

old_view = "let f=[R[2],R[5],R[8]];const n=Math.hypot(f[0],f[1],f[2])||1;f=f.map(v=>v/n);const tm=item?.source?.frames?.[i]?.time;return{position:C.slice(),forward:f,index:i,time:Number.isFinite(tm)?tm:null};"
new_view = "let f=[R[2],-R[5],R[8]];const n=Math.hypot(f[0],f[1],f[2])||1;f=f.map(v=>v/n);const tm=item?.source?.frames?.[i]?.time;return{position:trReflectY3(C),forward:f,index:i,time:Number.isFinite(tm)?tm:null};"
if old_view in s:
    s = s.replace(old_view, new_view, 1)
elif new_view not in s:
    raise SystemExit('representative view anchor not found')

old_log = "trLog(`Training dataset prepared: ${ds.views} views / ${ds.size}px`);"
new_log = old_log + "\n    trLog('Camera convention corrected: BA/SfM +Y up -> COLMAP/Brush +Y down (F R F, F C)');"
if old_log in s and 'Camera convention corrected:' not in s:
    s = s.replace(old_log, new_log, 1)

# Visible version labels and cache-busting query parameters are separate forms.
s = s.replace('v0.3c2', 'v0.3c4').replace('v0.3c3', 'v0.3c4')
s = s.replace('v=0.3c2', 'v=0.3c4').replace('v=0.3c3', 'v=0.3c4')
s = s.replace('Prototype v0.3c2', 'Prototype v0.3c4').replace('Prototype v0.3c3', 'Prototype v0.3c4')
p.write_text(s, encoding='utf-8')

for name in ['video.html', 'index.html']:
    q = Path(name)
    if q.exists():
        x = q.read_text(encoding='utf-8')
        x = x.replace('v0.3c2', 'v0.3c4').replace('v0.3c3', 'v0.3c4')
        x = x.replace('v=0.3c2', 'v=0.3c4').replace('v=0.3c3', 'v=0.3c4')
        x = x.replace('Prototype v0.3c2', 'Prototype v0.3c4').replace('Prototype v0.3c3', 'Prototype v0.3c4')
        q.write_text(x, encoding='utf-8')

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c4\nBA/SfM to COLMAP/Brush camera-coordinate convention correction\nBuild date: 2026-08-16\n',
    encoding='utf-8',
)
