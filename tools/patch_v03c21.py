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


# v0.3c21: direct equirectangular Gaussian projection experiment.
#
# c20 demonstrated that a very small spherical pose refinement improved held-out
# PSNR by ~2 dB while Gaussian anisotropy remained ~43x.  Keep c20 geometry,
# pose refinement, surface-aware seeds, SH1 and browser-safe growth fixed and
# replace only the six perspective cubemap training views with a differentiable
# equirectangular camera model inside Brush.
#
# Brush's tile rasterizer is rectangular rather than periodic.  To prevent a
# seam-clipped Gaussian from receiving a false gradient at longitude +/-pi,
# every source position is represented by two *direct ERP* views: the native
# panorama and an exactly 180-degree horizontal roll with an equally rotated
# camera.  Both use a spherical-area alpha mask (cos latitude) with a tapered
# seam band.  Thus every longitude is supervised away from a seam in at least
# one view, without returning to cubemap rectification.


# ---------------------------------------------------------------------------
# Brush: direct equirectangular camera model
# ---------------------------------------------------------------------------
cam = Path('_brush/crates/brush-render/src/kernels/camera_model')
(cam / 'equirectangular.rs').write_text(r'''use crate::kernels::camera_model::pinhole::PinholeParams;
use crate::kernels::types::ProjectUniforms;
use brush_cube::{Mat2x3, Sym2, Sym3, Vec2, Vec3A};
use burn_cubecl::cubecl;
use burn_cubecl::cubecl::prelude::*;

/// Direct equirectangular projection for Brush camera coordinates
/// (+X right, +Y down, +Z forward).
///
/// longitude = atan2(x, z)
/// latitude  = atan2(y, sqrt(x^2 + z^2))
/// u = fx * longitude + cx,  fx = W / (2*pi)
/// v = fy * latitude  + cy,  fy = H / pi
#[cube]
pub fn project_equirectangular(point: Vec3A, p: PinholeParams) -> (f32, f32) {
    let x = point.x();
    let y = point.y();
    let z = point.z();
    let r = f32::sqrt((x * x + z * z).max(1.0e-18f32));
    let lon = x.atan2(z);
    let lat = y.atan2(r);
    (p.fx * lon + p.cx, p.fy * lat + p.cy)
}

#[cube]
pub fn calculate_project_jacobian_equirectangular(
    point: Vec3A,
    p: PinholeParams,
) -> Mat2x3 {
    let x = point.x();
    let y = point.y();
    let z = point.z();
    let s_raw = x * x + y * y + z * z;
    let s = s_raw.max(1.0e-18f32);
    // The forward visibility pass removes the tiny polar cap where ERP's
    // longitude derivative is singular.  Keep a numerical floor as a second
    // line of defence for covariance evaluation.
    let r2 = (x * x + z * z).max(s * 1.0e-6f32);
    let r = f32::sqrt(r2);
    let inv_r2 = 1.0f32 / r2;
    let inv_s = 1.0f32 / s;
    let inv_rs = 1.0f32 / (r * s);

    let du_dx = p.fx * z * inv_r2;
    let du_dz = -p.fx * x * inv_r2;
    let dv_dx = -p.fy * x * y * inv_rs;
    let dv_dy = p.fy * r * inv_s;
    let dv_dz = -p.fy * z * y * inv_rs;

    Mat2x3 {
        c0: Vec2::new(du_dx, dv_dx),
        c1: Vec2::new(0.0f32, dv_dy),
        c2: Vec2::new(du_dz, dv_dz),
    }
}

/// Analytic VJP for both the projected mean and the projection-Jacobian path
/// used by EWA covariance.  This is the direct ERP analogue of Brush's KB4
/// implementation and keeps gradients on-GPU/WebGPU.
#[cube]
pub fn calculate_projection_vjp_equirectangular(
    j: Mat2x3,
    mean_c: Vec3A,
    cov_c: Sym3,
    u: ProjectUniforms,
    v_cov2d: Sym2,
    v_mean2d: Vec2,
) -> Vec3A {
    let PinholeParams { fx, fy, .. } = u.pinhole_params;
    let x = mean_c.x();
    let y = mean_c.y();
    let z = mean_c.z();
    let s_raw = x * x + y * y + z * z;
    let s = s_raw.max(1.0e-18f32);
    let r2 = (x * x + z * z).max(s * 1.0e-6f32);
    let r = f32::sqrt(r2);
    let inv_r = 1.0f32 / r;
    let inv_r2 = 1.0f32 / r2;
    let inv_r2_sq = inv_r2 * inv_r2;
    let inv_r3 = inv_r * inv_r2;
    let inv_s = 1.0f32 / s;
    let inv_s2 = inv_s * inv_s;

    // Path 1: projected-mean gradient J^T v_mean2d.
    let mut vx = v_mean2d.dot(j.c0);
    let mut vy = v_mean2d.dot(j.c1);
    let mut vz = v_mean2d.dot(j.c2);

    // v_J = 2 * v_cov2d * J * cov_c.
    let tmp = v_cov2d.mul_mat2x3(j);
    let vju0 = 2.0f32 * tmp.row0().dot(cov_c.row0());
    let vju1 = 2.0f32 * tmp.row0().dot(cov_c.row1());
    let vju2 = 2.0f32 * tmp.row0().dot(cov_c.row2());
    let vjv0 = 2.0f32 * tmp.row1().dot(cov_c.row0());
    let vjv1 = 2.0f32 * tmp.row1().dot(cov_c.row1());
    let vjv2 = 2.0f32 * tmp.row1().dot(cov_c.row2());

    // Hessian of u = fx * atan2(x,z).
    let huxx = -2.0f32 * fx * x * z * inv_r2_sq;
    let huxz = fx * (x * x - z * z) * inv_r2_sq;
    let huzz = 2.0f32 * fx * x * z * inv_r2_sq;

    // Hessian of v = fy * atan2(y, sqrt(x^2+z^2)).
    let common = 3.0f32 * r2 + y * y;
    let hvxx = fy * y
        * (2.0f32 * x * x * r2 + x * x * s - r2 * s)
        * inv_r3 * inv_s2;
    let hvxy = fy * x * (y * y - r2) * inv_r * inv_s2;
    let hvxz = fy * x * y * z * common * inv_r3 * inv_s2;
    let hvyy = -2.0f32 * fy * y * r * inv_s2;
    let hvyz = fy * z * (y * y - r2) * inv_r * inv_s2;
    let hvzz = fy * y
        * (2.0f32 * z * z * r2 + z * z * s - r2 * s)
        * inv_r3 * inv_s2;

    // Contract v_J with dJ/d{x,y,z}.
    vx += vju0 * huxx + vju2 * huxz
        + vjv0 * hvxx + vjv1 * hvxy + vjv2 * hvxz;
    vy += vjv0 * hvxy + vjv1 * hvyy + vjv2 * hvyz;
    vz += vju0 * huxz + vju2 * huzz
        + vjv0 * hvxz + vjv1 * hvyz + vjv2 * hvzz;

    Vec3A::new(vx, vy, vz)
}
''')

p = cam / 'mod.rs'
s = p.read_text()
s = replace_once(s, 'pub mod kannala_brandt_4;\n', 'pub mod equirectangular;\npub mod kannala_brandt_4;\n', 'camera module declaration')
s = replace_once(
    s,
    'use crate::kernels::camera_model::CameraModel::{\n    KannalaBrandt4, Pinhole, RadialTangential8, ThinPrismFisheye,\n};',
    'use crate::kernels::camera_model::CameraModel::{\n    Equirectangular, KannalaBrandt4, Pinhole, RadialTangential8, ThinPrismFisheye,\n};',
    'camera enum imports',
)
s = replace_once(
    s,
    'use crate::kernels::camera_model::kannala_brandt_4::{',
    'use crate::kernels::camera_model::equirectangular::{\n    calculate_project_jacobian_equirectangular, calculate_projection_vjp_equirectangular,\n    project_equirectangular,\n};\nuse crate::kernels::camera_model::kannala_brandt_4::{',
    'ERP kernel imports',
)
s = replace_once(s, '    Pinhole,\n    KannalaBrandt4(KannalaBrandt4Params),', '    Pinhole,\n    Equirectangular,\n    KannalaBrandt4(KannalaBrandt4Params),', 'ERP enum variant')
s = replace_once(s, '        Pinhole => project_pinhole(point, pinhole_params),\n', '        Pinhole => project_pinhole(point, pinhole_params),\n        Equirectangular => project_equirectangular(point, pinhole_params),\n', 'ERP forward projection dispatch')
s = replace_once(s, '        Pinhole => calculate_project_jacobian_pinhole(point, jacobian_clamp_limits, pinhole_params),\n', '        Pinhole => calculate_project_jacobian_pinhole(point, jacobian_clamp_limits, pinhole_params),\n        Equirectangular => calculate_project_jacobian_equirectangular(point, pinhole_params),\n', 'ERP jacobian dispatch')
s = replace_once(
    s,
    '        Pinhole => calculate_projection_vjp_pinhole(\n            projection_jacobian,\n            mean_c,\n            cov_c,\n            u,\n            v_cov2d,\n            v_mean2d,\n        ),\n',
    '        Pinhole => calculate_projection_vjp_pinhole(\n            projection_jacobian,\n            mean_c,\n            cov_c,\n            u,\n            v_cov2d,\n            v_mean2d,\n        ),\n        Equirectangular => calculate_projection_vjp_equirectangular(\n            projection_jacobian, mean_c, cov_c, u, v_cov2d, v_mean2d,\n        ),\n',
    'ERP VJP dispatch',
)
p.write_text(s)

p = Path('_brush/crates/brush-render/src/camera.rs')
s = p.read_text()
s = replace_once(
    s,
    'use crate::kernels::camera_model::CameraModel::{\n    KannalaBrandt4, Pinhole, RadialTangential8, ThinPrismFisheye,\n};',
    'use crate::kernels::camera_model::CameraModel::{\n    Equirectangular, KannalaBrandt4, Pinhole, RadialTangential8, ThinPrismFisheye,\n};',
    'camera host enum imports',
)
s = replace_once(
    s,
    '    let projected = match model {\n        Pinhole => half_fov.tan(),',
    '    let projected = match model {\n        Equirectangular => return pixels as f64 / fov.max(1.0e-12),\n        Pinhole => half_fov.tan(),',
    'ERP fov to focal',
)
s = replace_once(
    s,
    '    let half_fov = match model {\n        Pinhole => r_norm.atan(),',
    '    let half_fov = match model {\n        Equirectangular => return pixels as f64 / focal.max(1.0e-12),\n        Pinhole => r_norm.atan(),',
    'ERP focal to fov',
)
s = replace_once(
    s,
    '        KannalaBrandt4(_) | ThinPrismFisheye(_) => {}',
    '        Equirectangular | KannalaBrandt4(_) | ThinPrismFisheye(_) => {}',
    'ERP no jacobian clamp',
)
p.write_text(s)

p = Path('_brush/crates/brush-dataset/src/formats/nerfstudio.rs')
s = p.read_text()
s = replace_once(
    s,
    'use brush_render::kernels::camera_model::CameraModel::{\n    KannalaBrandt4, Pinhole, RadialTangential8,\n};',
    'use brush_render::kernels::camera_model::CameraModel::{\n    Equirectangular, KannalaBrandt4, Pinhole, RadialTangential8,\n};',
    'nerfstudio ERP enum import',
)
s = replace_once(
    s,
    '        None | Some("PERSPECTIVE" | "perspective") => Ok(Pinhole),\n',
    '        None | Some("PERSPECTIVE" | "perspective") => Ok(Pinhole),\n        Some("EQUIRECTANGULAR" | "equirectangular") => Ok(Equirectangular),\n',
    'nerfstudio ERP camera parser',
)
p.write_text(s)

p = Path('_brush/crates/brush-render/src/kernels/project_forward.rs')
s = p.read_text()
s = replace_once(
    s,
    '''        CameraModel::KannalaBrandt4(_)
        | CameraModel::RadialTangential8(_)
        | CameraModel::ThinPrismFisheye(_) => {''',
    '''        CameraModel::Equirectangular => {
            // ERP covers the whole sphere.  Only reject the camera centre and
            // a tiny polar cap where longitude has a mathematical singularity;
            // c21's spherical mask fades those pixels to zero supervision.
            let d2 = mean_c.x() * mean_c.x() + mean_c.y() * mean_c.y() + mean_c.z() * mean_c.z();
            let h2 = mean_c.x() * mean_c.x() + mean_c.z() * mean_c.z();
            if d2 < 1.0e-10f32 || h2 < d2 * 1.2e-3f32 {
                terminate!();
            }
        }
        CameraModel::KannalaBrandt4(_)
        | CameraModel::RadialTangential8(_)
        | CameraModel::ThinPrismFisheye(_) => {''',
    'ERP full-sphere visibility',
)
s = replace_once(
    s,
    '    depths[write_id as usize] = mean_c.z();\n',
    '''    depths[write_id as usize] = match camera_model {
        CameraModel::Equirectangular => mean_c.length(),
        _ => mean_c.z(),
    };
''',
    'ERP radial depth sort',
)
p.write_text(s)

# Two direct ERP seam variants belong to one original 360 source position.
p = Path('_brush/crates/brush-dataset/src/formats/mod.rs')
s = p.read_text()
s = s.replace('six contiguous cubemap faces', 'two contiguous direct-ERP seam variants')
s = s.replace('(front/right/back/left/up/down)', '(native and 180-degree rolled)')
s = s.replace('Keep all six together', 'Keep both together')
s = replace_once(s, '            let source_group = i / 6;', '            let source_group = i / 2;', 'two-view source-position holdout')
p.write_text(s)

p = Path('_brush/crates/brush-process/src/train_stream.rs')
s = p.read_text()
s = s.replace('complete six-face cubemap groups', 'complete two-view direct-ERP seam groups')
s = s.replace('balanced over the full sphere', 'balanced over complementary ERP seams')
s = replace_once(s, '    let groups = n / 6;', '    let groups = n / 2;', 'two-view train-fit groups')
s = replace_once(s, '            for j in 0..6 {', '            for j in 0..2 {', 'two-view train-fit loop')
s = replace_once(s, '                let idx = g * 6 + j;', '                let idx = g * 2 + j;', 'two-view train-fit index')
s = replace_once(s, '        indices.extend(0..n.min(6));', '        indices.extend(0..n.min(2));', 'two-view train-fit fallback')
p.write_text(s)


# ---------------------------------------------------------------------------
# 360GS frontend: replace six cubemap training images with two direct ERPs.
# Geometry/depth preparation remains c20; cubemap rendering is retained only
# for the optional guarded depth proposal path.
# ---------------------------------------------------------------------------
p = Path('training.js')
s = p.read_text()

helpers = r'''
function trErpFrameCanvas(video,w,h,rollHalf=false){
  const base=document.createElement('canvas');base.width=w;base.height=h;
  const b=base.getContext('2d',{alpha:false});if(!b)throw new Error('ERP学習画像Canvasを作成できません。');
  b.imageSmoothingEnabled=true;b.imageSmoothingQuality='high';b.drawImage(video,0,0,w,h);
  if(!rollHalf)return base;
  const out=document.createElement('canvas');out.width=w;out.height=h;
  const c=out.getContext('2d',{alpha:false});if(!c)throw new Error('ERP seam移動Canvasを作成できません。');
  const half=Math.floor(w/2),right=w-half;
  c.drawImage(base,half,0,right,h,0,0,right,h);
  c.drawImage(base,0,0,half,h,right,0,half,h);
  return out;
}
function trErpWeightMask(w,h){
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d');if(!x)throw new Error('ERP球面重みmaskを作成できません。');
  const im=x.createImageData(w,h),d=im.data,seamFrac=.045;
  const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
  for(let yy=0;yy<h;yy++){
    const lat=((yy+.5)/h-.5)*Math.PI,area=Math.max(0,Math.cos(lat));
    for(let xx=0;xx<w;xx++){
      const edge=Math.min(xx+.5,w-xx-.5)/w,seam=smooth(edge/seamFrac),weight=Math.max(0,Math.min(1,area*seam));
      const i=(yy*w+xx)*4;d[i]=255;d[i+1]=255;d[i+2]=255;d[i+3]=Math.round(weight*255);
    }
  }
  x.putImageData(im,0,0);return c;
}
async function trPng(canvas){return new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error('PNG生成に失敗しました。')),'image/png'));}
function trNerfstudioMatrix(pose,yawDeg=0){
  // Desired Brush camera pose is the same +Y-down convention used by the
  // former COLMAP path. Nerfstudio's loader converts OpenGL (+Y up,+Z back)
  // by flipping its local Y/Z columns, so invert that conversion here.
  const Rb=trReflectYMat(trMul(pose.cameraToWorld,trYaw(yawDeg))),C=trReflectY3(pose.position);
  const Rgl=[Rb[0],-Rb[1],-Rb[2],Rb[3],-Rb[4],-Rb[5],Rb[6],-Rb[7],-Rb[8]];
  return[[Rgl[0],Rgl[1],Rgl[2],C[0]],[Rgl[3],Rgl[4],Rgl[5],C[1]],[Rgl[6],Rgl[7],Rgl[8],C[2]],[0,0,0,1]];
}
'''
s = replace_once(s, 'async function trBuildDataset(item,id){\n', helpers + '\nasync function trBuildDataset(item,id){\n', 'direct ERP frontend helpers')

s = replace_once(
    s,
    "  const dir=await trDir(base,dn),sel=trSelect(Math.min(item.optimization.poses.length,item.source.frames.length));\n  const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,rr=trRenderer(size),focal=(size/2)/Math.tan(TR_FOV*Math.PI/360);\n  await trWrite(dir,'sparse/0/cameras.txt',`# CAMERA_ID MODEL WIDTH HEIGHT PARAMS\\n1 PINHOLE ${size} ${size} ${focal} ${focal} ${size/2} ${size/2}\\n`);\n  await trWrite(dir,'sparse/0/points3D.txt','# 360GS uses root init.ply for BA/SfM-informed browser initialization.\\n');\n",
    "  const dir=await trDir(base,dn),sel=trSelect(Math.min(item.optimization.poses.length,item.source.frames.length));\n  const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,erpW=size,erpH=Math.max(2,Math.round(size/2));\n",
    'remove cubemap COLMAP dataset header',
)

old_tail = r'''  const lines=['# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME'];let iid=1,made=0;
  for(let o=0;o<sel.length;o++){
    if(id!==trRunId)throw new Error('処理が更新されました。');
    const fi=sel[o],pose=workingPoses[fi],tm=item.source.frames[fi].time;
    await trSeek(tm);
    for(let k=0;k<TR_FACES.length;k++){
      const face=TR_FACES[k];
      rr.render(trVideo,face.yaw,face.pitch);
      const blob=await trJpeg(rr.canvas),name=`f${String(o).padStart(3,'0')}_${face.name}.jpg`;
      await trWrite(dir,`images/${name}`,blob);
      const Rcw=trReflectYMat(trMul(pose.cameraToWorld,trFaceRot(face))),C=trReflectY3(pose.position),R=trT(Rcw),pv=trMv(R,C),q=trQuat(R);
      lines.push(`${iid} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${-pv[0]} ${-pv[1]} ${-pv[2]} 1 ${name}`,'');
      iid++;made++;trProgress(2+8*made/(sel.length*TR_FACES.length),`Brush用6面cubemapを準備しています ${made}/${sel.length*TR_FACES.length}`);
      await new Promise(r=>setTimeout(r,0));
    }
  }
  await trWrite(dir,'sparse/0/images.txt',lines.join('\n')+'\n');
  return{dir,views:sel.length*TR_FACES.length,size,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,depthPoints:seed.depthPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight,depthPrior:depth,poseRefinement,refinedPoses:workingPoses};'''
new_tail = r'''  const frames=[],maskBlob=await trPng(trErpWeightMask(erpW,erpH));let made=0;
  const variants=[{tag:'erp0',yaw:0,roll:false},{tag:'erp180',yaw:180,roll:true}];
  for(let o=0;o<sel.length;o++){
    if(id!==trRunId)throw new Error('処理が更新されました。');
    const fi=sel[o],pose=workingPoses[fi],tm=item.source.frames[fi].time;
    await trSeek(tm);
    for(const variant of variants){
      const canvas=trErpFrameCanvas(trVideo,erpW,erpH,variant.roll),blob=await trJpeg(canvas),stem=`f${String(o).padStart(3,'0')}_${variant.tag}`,name=`${stem}.jpg`;
      await trWrite(dir,`images/${name}`,blob);await trWrite(dir,`masks/${stem}.png`,maskBlob);
      frames.push({file_path:`images/${name}`,camera_model:'EQUIRECTANGULAR',w:erpW,h:erpH,cx:erpW/2,cy:erpH/2,camera_angle_x:Math.PI*2,camera_angle_y:Math.PI,transform_matrix:trNerfstudioMatrix(pose,variant.yaw)});
      made++;trProgress(6+4*made/(sel.length*variants.length),`Brush用direct ERPを準備しています ${made}/${sel.length*variants.length}`);await new Promise(r=>setTimeout(r,0));
    }
  }
  await trWrite(dir,'transforms.json',JSON.stringify({camera_model:'EQUIRECTANGULAR',w:erpW,h:erpH,cx:erpW/2,cy:erpH/2,camera_angle_x:Math.PI*2,camera_angle_y:Math.PI,frames},null,2));
  return{dir,views:sel.length*2,size:erpW,erpHeight:erpH,seedCount:seed.count,seedAnchors:seed.anchors,sourceTracks:seed.sourceTracks,stereoPoints:seed.stereoPoints,depthPoints:seed.depthPoints,seedScale:seed.sceneScale,seedSpacing:seed.spacing,randomDepthSeeds:seed.randomDepthSeeds,geometryPreflight:preflight,depthPrior:depth,poseRefinement,refinedPoses:workingPoses,projection:'direct-erp-dual-seam'};'''
s = replace_once(s, old_tail, new_tail, 'replace cubemap image export with direct ERP dataset')

s = s.replace("label:'高品質・球面幾何＋post-pose再調整'", "label:'高品質・direct ERP＋post-pose再調整'")
s = s.replace("label:'品質優先・球面幾何＋post-pose再調整'", "label:'品質優先・direct ERP＋post-pose再調整'")
s = s.replace("label:'省メモリ・球面幾何＋post-pose再調整'", "label:'省メモリ・direct ERP＋post-pose再調整'")
s = replace_once(s, "      if('eval-split-every'in c)c['eval-split-every']=6;", "      if('eval-split-every'in c)c['eval-split-every']=6;", 'eval split config anchor')
# eval-split-every is the number of source groups between held-out groups; the
# patched Brush splitter groups contiguous ERP pairs internally, so keep 6.

s = s.replace(' / SH degree 1 / 6-face 90deg cubemap / source-position hold-out every 6th group', ' / SH degree 1 / direct ERP dual-seam spherical-weighted supervision / source-position hold-out every 6th group')
s = s.replace('c19ではpose既知の球面epipolar対応、複数視点支持、実測点で較正したcross-view depth inlier、surface-aware初期化を組み合わせています。改善が限定的なら、次はcubemap学習を終了し直接ERP rasterizationとカメラ自己較正へ進みます。', 'c21ではc20の球面幾何とpose再調整を維持し、6面cubemapを廃止してdirect ERP rasterizationへ移行しています。残る誤差はERP camera model、stitching distortion、Gaussian geometryを個別に評価します。')

# Result interpretation / diagnostics identify the experiment explicitly.
s = s.replace('Brush training remains six-face 90 degree cubemap', 'Brush training uses direct equirectangular projection')
s = s.replace('6面90° cubemap', 'direct ERP')
s = s.replace('6面cubemap', 'direct ERP')

# Cache keys and visible version.
s = s.replace('v0.3c20','v0.3c21').replace('v=0.3c20','v=0.3c21')
p.write_text(s)

for name in ['index.html','video.html','README.md']:
    q=Path(name)
    if q.exists():
        q.write_text(q.read_text().replace('v0.3c20','v0.3c21').replace('v=0.3c20','v=0.3c21'))

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c21\n'
    'Direct differentiable equirectangular Gaussian projection in Brush/WebGPU\n'
    'c20 spherical geometry and post-triangulation camera pose refinement are retained unchanged\n'
    'Six-face cubemap training is replaced by two complementary direct ERP views per source position (native + 180-degree roll)\n'
    'A spherical-area alpha mask (cos latitude) and seam taper provide weighted photometric supervision while avoiding rectangular-tile seam gradients\n'
    'Brush adds an Equirectangular camera model with analytic projection Jacobian and analytic covariance/mean VJP; ERP depth sorting uses radial range\n'
    'Tiny polar caps are excluded from rasterization where longitude is mathematically singular; their spherical area weight is near zero\n'
    'SH degree 1, c20 trusted geometry, depth guards, Gaussian budget and browser-safe GPU-only growth remain controlled\n'
    'c20 baseline: 14,747 Gaussians; train 20.47 dB / 0.581; held-out 17.25 dB / 0.530; gap 3.23 dB; anisotropy p90 43.2x\n'
    'Build date: 2026-08-17\n'
)
