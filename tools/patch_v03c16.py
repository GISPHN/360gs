from pathlib import Path

VERSION = '0.3c16'
OLD_VERSION = '0.3c15'


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'patch target not found: {label}')
    return text.replace(old, new, 1)


# --- pose.js: direct ERP spherical correspondences first, perspective fallback ---
p = Path('pose.js')
s = p.read_text()
if not s.startswith("import { sphericalDetectFeatures"):
    s = "import { sphericalDetectFeatures, sphericalMatchFeatures } from './spherical.js?v=0.3c16';\n\n" + s

old = '''function poseCollectCorrespondences(leftFrame, rightFrame) {
  const correspondences = [];
  for (const leftView of leftFrame.views) {
    let best = null;
    for (const rightView of rightFrame.views) { const matches = poseMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; }
    if (!best || best.matches.length < 3) continue;
    for (const match of best.matches) correspondences.push({ leftBearing: poseBearingFromViewPoint(match.leftX, match.leftY, leftView.yaw), rightBearing: poseBearingFromViewPoint(match.rightX, match.rightY, best.rightView.yaw), quality: match.distance });
  }
  return correspondences;
}

async function poseBuildFrame(time, maps) {
  const panorama = await poseCapturePanorama(time);
  return { time, views: maps.map((map, index) => ({ yaw: POSE_VIEW_YAWS[index], features: poseDetectFeatures(poseProjectPerspective(panorama, map)) })) };
}
'''
new = '''function poseCollectCorrespondences(leftFrame, rightFrame) {
  // v0.3c16: match directly on the equirectangular sphere first. Bearings are
  // created from the original ERP pixels, so camera geometry no longer depends
  // on four tangent-plane crops. Keep the old path only as a safety fallback.
  const directMatches = sphericalMatchFeatures(leftFrame.sphericalFeatures || [], rightFrame.sphericalFeatures || [], {
    ratio: 0.80,
    reverseRatio: 0.84,
    minConfidence: 0.13,
  });
  if (directMatches.length >= POSE_MIN_CORRESPONDENCES) {
    return directMatches.slice(0, POSE_MAX_CORRESPONDENCES).map((match) => ({
      leftBearing: [...match.left.bearing],
      rightBearing: [...match.right.bearing],
      quality: match.quality,
      source: 'erp',
    }));
  }

  const correspondences = [];
  for (const leftView of leftFrame.views) {
    let best = null;
    for (const rightView of rightFrame.views) { const matches = poseMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; }
    if (!best || best.matches.length < 3) continue;
    for (const match of best.matches) correspondences.push({ leftBearing: poseBearingFromViewPoint(match.leftX, match.leftY, leftView.yaw), rightBearing: poseBearingFromViewPoint(match.rightX, match.rightY, best.rightView.yaw), quality: match.distance, source: 'perspective-fallback' });
  }
  return correspondences;
}

async function poseBuildFrame(time, maps) {
  const panorama = await poseCapturePanorama(time);
  const sphericalFeatures = sphericalDetectFeatures(panorama, POSE_EQ_WIDTH, POSE_EQ_HEIGHT, {
    maxFeatures: 300,
    scanStep: 4,
    minResponse: 850,
    minStd: 6.5,
    minAngleDeg: 1.8,
    maxLatitudeDeg: 80,
  });
  return {
    time,
    sphericalFeatures,
    views: maps.map((map, index) => ({ yaw: POSE_VIEW_YAWS[index], features: poseDetectFeatures(poseProjectPerspective(panorama, map)) })),
  };
}
'''
s = replace_once(s, old, new, 'pose direct ERP frame/correspondence path')

old = '''function poseEstimatePair(leftFrame, rightFrame) {
  const correspondences = poseCollectCorrespondences(leftFrame, rightFrame);
  return { start: leftFrame.time, end: rightFrame.time, gap: rightFrame.time - leftFrame.time, correspondences: correspondences.length, ...poseEstimateRelative(correspondences, posePairSeed(leftFrame.time, rightFrame.time, correspondences.length)) };
}
'''
new = '''function poseEstimatePair(leftFrame, rightFrame) {
  const correspondences = poseCollectCorrespondences(leftFrame, rightFrame);
  const erpCorrespondences = correspondences.filter((corr) => corr.source === 'erp').length;
  return { start: leftFrame.time, end: rightFrame.time, gap: rightFrame.time - leftFrame.time, correspondences: correspondences.length, erpCorrespondences, geometrySource: erpCorrespondences ? 'direct-erp' : 'perspective-fallback', ...poseEstimateRelative(correspondences, posePairSeed(leftFrame.time, rightFrame.time, correspondences.length)) };
}
'''
s = replace_once(s, old, new, 'pose ERP diagnostic source')
s = s.replace("poseProgressText.textContent = '幾何学的な撮影位置を推定しています';", "poseProgressText.textContent = 'ERP全体から球面対応点を抽出し、撮影位置を推定しています';")
s = s.replace("poseProgressText.textContent = `撮影位置用の特徴点を準備しています (${index + 1}/${times.length})`;", "poseProgressText.textContent = `ERP球面特徴を準備しています (${index + 1}/${times.length})`;")
s = s.replace("poseProgressText.textContent = '相対カメラ姿勢推定まで完了しました';", "poseProgressText.textContent = 'ERP球面対応による相対カメラ姿勢推定まで完了しました';")
s = s.replace(OLD_VERSION, VERSION)
p.write_text(s)


# --- sfm.js: direct ERP spherical correspondences first, perspective fallback ---
p = Path('sfm.js')
s = p.read_text()
if not s.startswith("import { sphericalDetectFeatures"):
    s = "import { sphericalDetectFeatures, sphericalMatchFeatures } from './spherical.js?v=0.3c16';\n\n" + s

old = '''function sfmCollectCorrespondences(leftFrame, rightFrame) { const corr = []; for (const leftView of leftFrame.views) { let best = null; for (const rightView of rightFrame.views) { const matches = sfmMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; } if (!best || best.matches.length < 3) continue; for (const m of best.matches) corr.push({ leftBearing: sfmBearing(m.leftX, m.leftY, leftView.yaw), rightBearing: sfmBearing(m.rightX, m.rightY, best.rightView.yaw), quality: m.distance }); } return corr; }
async function sfmBuildFrame(time, maps) { const pano = await sfmCapturePanorama(time); return { time, views: maps.map((map, i) => ({ yaw: SFM_VIEW_YAWS[i], features: sfmDetect(sfmProject(pano, map)) })) }; }
'''
new = '''function sfmCollectCorrespondences(leftFrame, rightFrame) {
  const directMatches = sphericalMatchFeatures(leftFrame.sphericalFeatures || [], rightFrame.sphericalFeatures || [], {
    ratio: 0.79,
    reverseRatio: 0.83,
    minConfidence: 0.13,
  });
  if (directMatches.length >= SFM_MIN_CORRESPONDENCES) {
    return directMatches.slice(0, SFM_MAX_CORRESPONDENCES).map((match) => ({
      leftBearing: [...match.left.bearing],
      rightBearing: [...match.right.bearing],
      quality: match.quality,
      source: 'erp',
    }));
  }
  const corr = [];
  for (const leftView of leftFrame.views) {
    let best = null;
    for (const rightView of rightFrame.views) { const matches = sfmMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; }
    if (!best || best.matches.length < 3) continue;
    for (const m of best.matches) corr.push({ leftBearing: sfmBearing(m.leftX, m.leftY, leftView.yaw), rightBearing: sfmBearing(m.rightX, m.rightY, best.rightView.yaw), quality: m.distance, source: 'perspective-fallback' });
  }
  return corr;
}
async function sfmBuildFrame(time, maps) {
  const pano = await sfmCapturePanorama(time);
  const sphericalFeatures = sphericalDetectFeatures(pano, SFM_EQ_WIDTH, SFM_EQ_HEIGHT, {
    maxFeatures: 320,
    scanStep: 4,
    minResponse: 820,
    minStd: 6.2,
    minAngleDeg: 1.7,
    maxLatitudeDeg: 80,
  });
  return { time, sphericalFeatures, views: maps.map((map, i) => ({ yaw: SFM_VIEW_YAWS[i], features: sfmDetect(sfmProject(pano, map)) })) };
}
'''
s = replace_once(s, old, new, 'sfm direct ERP frame/correspondence path')
s = s.replace('3D化候補区間の内部だけキーフレームを追加し、相対姿勢を再推定します。さらに1枚飛ばしの整合性も確認し、成立した対応から疎な3D点を三角測量します。大きすぎる視差角は姿勢破綻の可能性があるため除外します。', '3D化候補区間の内部だけキーフレームを追加し、ERP全体から直接得た球面bearingで相対姿勢を再推定します。さらに1枚飛ばしの整合性も確認し、成立した対応から疎な3D点を三角測量します。ERP特徴が不足する場合だけ従来の透視特徴へ自動で戻します。')
s = s.replace("sfmProgressText.textContent = '候補区間の局所SfM再計算まで完了しました';", "sfmProgressText.textContent = 'ERP球面対応による局所SfM再計算まで完了しました';")
s = s.replace(OLD_VERSION, VERSION)
p.write_text(s)


# --- tracking.js: use direct ERP features as the primary observation set ---
p = Path('tracking.js')
s = p.read_text()
old_import = "import './tracking-ui.js';\n"
new_import = "import './tracking-ui.js';\nimport { sphericalDetectFeatures } from './spherical.js?v=0.3c16';\n"
s = replace_once(s, old_import, new_import, 'tracking spherical import')

old = '''function trFilterFramesToTracks(frames, tracks) {
  const keys = new Set();
  for (const track of tracks) for (const obs of track.observations) keys.add(obs.key);
  return frames.map((frame, frameIndex) => ({
    time: frame.time,
    views: frame.views.map((view, viewIndex) => ({
      yaw: view.yaw,
      features: view.features
        .filter((feature, featureIndex) => keys.has(`${frameIndex}:${viewIndex}:${featureIndex}`))
        .map((feature) => ({
          x: feature.x,
          y: feature.y,
          descriptor: feature.descriptor,
          response: Math.round(1000 + 9000 * Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0)),
          trackingConfidence: Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0),
          dir: feature.dir,
        })),
    })),
  }));
}
'''
new = '''function trFilterFramesToTracks(frames, tracks) {
  const keys = new Set();
  for (const track of tracks) for (const obs of track.observations) keys.add(obs.key);
  return frames.map((frame, frameIndex) => ({
    time: frame.time,
    views: frame.views.map((view, viewIndex) => ({
      yaw: view.yaw,
      spherical: !!view.spherical,
      features: view.features
        .filter((feature, featureIndex) => keys.has(`${frameIndex}:${viewIndex}:${featureIndex}`))
        .map((feature) => ({
          x: feature.x,
          y: feature.y,
          descriptor: feature.descriptor,
          response: Math.round(1000 + 9000 * Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0)),
          trackingConfidence: Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0),
          baseConfidence: feature.baseConfidence,
          dir: feature.dir,
          bearing: Array.isArray(feature.bearing) ? [...feature.bearing] : undefined,
          spherical: !!feature.spherical,
        })),
    })),
  }));
}
'''
s = replace_once(s, old, new, 'tracking preserve direct bearings')

old = '''async function trBuildDenseFrames(source, viewSize, pass, generation) {
  const mapInfo = trMaps(viewSize);
  const frames = [];
  for (let frameIndex = 0; frameIndex < source.frames.length; frameIndex += 1) {
    if (generation !== trGeneration) return null;
    const time = source.frames[frameIndex].time;
    const pano = await trCapturePanorama(time, mapInfo.eqWidth, mapInfo.eqHeight);
    const views = mapInfo.maps.map((map, viewIndex) => {
      const gray = trProject(pano, map);
      return { yaw: TR_VIEW_YAWS[viewIndex], dir: TR_VIEW_DIRS[viewIndex], features: trDetect(gray, viewSize, pass, TR_VIEW_DIRS[viewIndex]) };
    });
    frames.push({ time, views });
    if (trProgressText) trProgressText.textContent = `特徴点追跡を安定化しています（${frameIndex + 1}/${source.frames.length}）`;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}
'''
new = '''async function trBuildDenseFrames(source, viewSize, pass, generation) {
  const mapInfo = trMaps(viewSize);
  const frames = [];
  const passCfg = trPassConfig(pass, viewSize);
  for (let frameIndex = 0; frameIndex < source.frames.length; frameIndex += 1) {
    if (generation !== trGeneration) return null;
    const time = source.frames[frameIndex].time;
    const pano = await trCapturePanorama(time, mapInfo.eqWidth, mapInfo.eqHeight);
    const sphericalFeatures = sphericalDetectFeatures(pano, mapInfo.eqWidth, mapInfo.eqHeight, {
      maxFeatures: Math.min(520, 340 + pass * 70),
      scanStep: Math.max(4, Math.round(mapInfo.eqWidth / 210)),
      minResponse: pass === 0 ? 820 : pass === 1 ? 590 : 430,
      minStd: passCfg.minStd,
      minAngleDeg: viewSize >= 300 ? 1.15 : viewSize >= 240 ? 1.45 : 1.85,
      maxLatitudeDeg: 80,
    });
    let views;
    if (sphericalFeatures.length >= 28) {
      // One whole-sphere observation set per source frame prevents cubemap seam
      // duplication while retaining directional labels for coverage diagnostics.
      views = [{ yaw: 0, dir: 'erp', spherical: true, features: sphericalFeatures }];
    } else {
      views = mapInfo.maps.map((map, viewIndex) => {
        const gray = trProject(pano, map);
        return { yaw: TR_VIEW_YAWS[viewIndex], dir: TR_VIEW_DIRS[viewIndex], spherical: false, features: trDetect(gray, viewSize, pass, TR_VIEW_DIRS[viewIndex]) };
      });
    }
    frames.push({ time, views, geometrySource: sphericalFeatures.length >= 28 ? 'direct-erp' : 'perspective-fallback' });
    if (trProgressText) trProgressText.textContent = `ERP球面特徴を追跡しています（${frameIndex + 1}/${source.frames.length}）`;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}
'''
s = replace_once(s, old, new, 'tracking direct ERP dense frames')
s = s.replace("if (trProgressText) trProgressText.textContent = '特徴点追跡を安定化し、全体最適化へ進みます';", "if (trProgressText) trProgressText.textContent = 'ERP球面特徴の追跡を安定化し、角度BAへ進みます';")
s = s.replace(OLD_VERSION, VERSION)
p.write_text(s)


# --- ba.js: consume precomputed direct ERP bearings when available ---
p = Path('ba.js')
s = p.read_text()
old = '''      descriptor: feature.descriptor,
      response: feature.response || 0,
      bearing: baBearing(feature.x, feature.y, view.yaw),
    }));
'''
new = '''      descriptor: feature.descriptor,
      response: feature.response || 0,
      bearing: Array.isArray(feature.bearing) && feature.bearing.length === 3
        ? baNormalize3(feature.bearing)
        : baBearing(feature.x, feature.y, view.yaw),
      spherical: !!feature.spherical,
    }));
'''
s = replace_once(s, old, new, 'BA direct spherical bearings')
s = s.replace('3フレーム以上で追跡できる特徴から明らかな外れ観測を先に除き、360°方向ベクトルの観測誤差を小さくするように最適化します。', '3フレーム以上で追跡できるERP球面特徴から明らかな外れ観測を先に除き、透視投影を介さない360°bearingの角度誤差を小さくするように最適化します。ERP特徴が不足した場合のみ従来観測を使用します。')
s = s.replace('これはブラウザ向けの小規模・ロバストなBundle Adjustmentです。', 'これはブラウザ向けの小規模・ロバストな球面Bundle Adjustmentです。')
s = s.replace(OLD_VERSION, VERSION)
p.write_text(s)


# --- video.html copy and cache keys ---
p = Path('video.html')
s = p.read_text()
s = s.replace('選ばれた360°キーフレームを前・右・後・左へ透視投影し、局所特徴点と対応点を評価します。', '選ばれた360°キーフレームのERP全体から直接球面特徴を抽出し、経度0°/360°の境界をまたいだ対応も含めて評価します。特徴が不足する場合だけ透視投影へ自動で戻します。')
s = s.replace('対応点を360°方向ベクトルへ変換し、RANSACとEssential matrixから相対回転と移動方向を求めます。', 'ERP上の対応点を直接360°bearingへ変換し、RANSACとEssential matrixから相対回転と移動方向を求めます。固定透視面の境界に依存しない球面幾何を優先します。')
s = s.replace(OLD_VERSION, VERSION)
p.write_text(s)


# --- training model is deliberately unchanged; only cache/version marker changes ---
for name in ['training.js', 'index.html', 'README.md']:
    p = Path(name)
    if p.exists():
        p.write_text(p.read_text().replace(OLD_VERSION, VERSION))

Path('BUILD_VERSION.txt').write_text(
    '360GS v0.3c16\n'
    'Direct ERP spherical correspondences for pose, local SfM, dense tracking and angular bundle adjustment\n'
    'Seam-safe tangent descriptors operate on the original equirectangular panorama with latitude-aware sampling\n'
    'Perspective feature extraction is retained only as an automatic fallback when direct ERP features are insufficient\n'
    '3DGS training model unchanged from v0.3c15/c13: six-face 90-degree cubemap, SH degree 1 and the same Gaussian density schedule\n'
    'This isolates camera-geometry quality before a clean-room WebGPU direct ERP Gaussian rasterizer is attempted\n'
    'c13 baseline: 46,128 Gaussians; train 19.75 dB / 0.568; held-out 19.10 dB / 0.532; gap 0.65 dB\n'
    'Build date: 2026-08-17\n'
)
