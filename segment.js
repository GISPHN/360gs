const segmentPoseMessage = document.querySelector('#pose-message');
const segmentPoseTimeline = document.querySelector('#pose-timeline');
const segmentSourceVideo = document.querySelector('#source-video');
const segmentProgressText = document.querySelector('#progress-text');

let segmentLastSignature = '';
let segmentObserver = null;

const SEGMENT_MIN_PAIRS = 2;
const SEGMENT_MIN_DURATION = 1.2;
const SEGMENT_HARD_INLIER = 0.25;
const SEGMENT_HARD_PARALLAX = 0.16;
const SEGMENT_CANDIDATE_INLIER = 0.30;
const SEGMENT_CANDIDATE_PARALLAX = 0.16;
const SEGMENT_GOOD_INLIER = 0.45;
const SEGMENT_GOOD_PARALLAX = 0.45;

function segmentMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function segmentEnsurePanel() {
  let panel = document.querySelector('#segment-panel');
  if (panel) return panel;
  const posePanel = document.querySelector('#pose-panel');
  if (!posePanel) return null;

  panel = document.createElement('section');
  panel.id = 'segment-panel';
  panel.className = 'segment-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'segment-title');
  panel.innerHTML = `
    <div class="segment-heading">
      <div>
        <p class="eyebrow">自動区間分割</p>
        <h3 id="segment-title">3D化しやすい区間へ自動整理</h3>
      </div>
      <span class="segment-auto">自動設定</span>
    </div>
    <p class="segment-description">
      相対姿勢の成立状況、幾何学的内点率、視差角を区間ごとに再評価し、姿勢推定が不安定な箇所を境界候補として扱います。
      安定した連続区間は3D化候補として残し、短すぎる区間や不安定な区間は保留します。
    </p>
    <div class="segment-stats">
      <div class="segment-stat"><span>自動分割後の区間</span><strong id="segment-count">—</strong></div>
      <div class="segment-stat"><span>3D化候補</span><strong id="segment-candidates">—</strong></div>
      <div class="segment-stat"><span>保留</span><strong id="segment-hold">—</strong></div>
      <div class="segment-stat"><span>分割境界候補</span><strong id="segment-breaks">—</strong></div>
    </div>
    <div class="segment-legend" aria-hidden="true">
      <span><i class="segment-legend-dot good"></i>良好候補</span>
      <span><i class="segment-legend-dot candidate"></i>3D化候補</span>
      <span><i class="segment-legend-dot hold"></i>保留</span>
      <span><i class="segment-legend-dot break"></i>分割境界</span>
    </div>
    <div id="segment-timeline" class="segment-timeline" aria-label="自動区間分割の結果"></div>
    <div id="segment-list" class="segment-list"></div>
    <div id="segment-message" class="message-box" aria-live="polite" hidden></div>
    <p class="segment-note">この版の区間評価は、直前のRANSAC / Essential matrixによる相対姿勢推定結果を区間単位で再評価したものです。絶対距離スケールはまだ未確定です。</p>
  `;
  posePanel.insertAdjacentElement('afterend', panel);
  return panel;
}

function segmentParsePair(element) {
  const title = element.getAttribute('title') || '';
  const match = title.match(/([\d.]+)〜([\d.]+)秒：内点率\s*(\d+)%\s*\/\s*視差\s*([\d.]+)°/);
  if (!match) return null;
  const state = element.classList.contains('good') ? 'good' : element.classList.contains('weak') ? 'weak' : 'attention';
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    inlierRatio: Number(match[3]) / 100,
    parallaxDeg: Number(match[4]),
    state,
  };
}

function segmentReadPairs() {
  if (!segmentPoseTimeline) return [];
  return Array.from(segmentPoseTimeline.children).map(segmentParsePair).filter(Boolean).sort((a, b) => a.start - b.start);
}

function segmentIsHardBreak(pair) {
  if (pair.state === 'weak') return true;
  if (pair.inlierRatio < SEGMENT_HARD_INLIER) return true;
  if (pair.parallaxDeg < SEGMENT_HARD_PARALLAX) return true;
  return false;
}

function segmentScoreRun(pairs, index) {
  const start = pairs[0].start;
  const end = pairs[pairs.length - 1].end;
  const duration = Math.max(0, end - start);
  const medianInlier = segmentMedian(pairs.map((pair) => pair.inlierRatio));
  const medianParallax = segmentMedian(pairs.map((pair) => pair.parallaxDeg));
  const goodRatio = pairs.filter((pair) => pair.state === 'good').length / Math.max(1, pairs.length);
  const attentionRatio = pairs.filter((pair) => pair.state === 'attention').length / Math.max(1, pairs.length);

  let quality = 'hold';
  if (
    pairs.length >= SEGMENT_MIN_PAIRS &&
    duration >= SEGMENT_MIN_DURATION &&
    medianInlier >= SEGMENT_CANDIDATE_INLIER &&
    medianParallax >= SEGMENT_CANDIDATE_PARALLAX
  ) {
    quality = 'candidate';
  }
  if (
    pairs.length >= 3 &&
    duration >= SEGMENT_MIN_DURATION &&
    medianInlier >= SEGMENT_GOOD_INLIER &&
    medianParallax >= SEGMENT_GOOD_PARALLAX &&
    goodRatio >= 0.5
  ) {
    quality = 'good';
  }

  return {
    id: index + 1,
    start,
    end,
    duration,
    pairs,
    pairCount: pairs.length,
    medianInlier,
    medianParallax,
    goodRatio,
    attentionRatio,
    quality,
  };
}

function segmentBuildResult(pairs) {
  const runs = [];
  const breaks = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      runs.push(current);
      current = [];
    }
  };

  for (const pair of pairs) {
    if (segmentIsHardBreak(pair)) {
      flush();
      breaks.push(pair);
    } else {
      current.push(pair);
    }
  }
  flush();

  const segments = runs.map((run, index) => segmentScoreRun(run, index));
  return { segments, breaks };
}

function segmentFormatTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}分${rest.toFixed(0)}秒`;
}

function segmentQualityLabel(quality) {
  if (quality === 'good') return '良好候補';
  if (quality === 'candidate') return '3D化候補';
  return '保留';
}

function segmentRenderTimeline(container, segments, breaks, duration) {
  container.replaceChildren();
  const safeDuration = Math.max(duration || 0, ...segments.map((segment) => segment.end), ...breaks.map((pair) => pair.end), 1);
  const items = [
    ...segments.map((segment) => ({ start: segment.start, end: segment.end, kind: segment.quality, label: `区間${segment.id} ${segmentQualityLabel(segment.quality)}` })),
    ...breaks.map((pair) => ({ start: pair.start, end: pair.end, kind: 'break', label: `分割境界候補 ${pair.start.toFixed(1)}〜${pair.end.toFixed(1)}秒` })),
  ].sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const item of items) {
    if (item.start > cursor) {
      const spacer = document.createElement('div');
      spacer.className = 'segment-timeline-gap';
      spacer.style.flexGrow = String(item.start - cursor);
      container.append(spacer);
    }
    const block = document.createElement('div');
    block.className = `segment-timeline-block ${item.kind}`;
    block.style.flexGrow = String(Math.max(0.12, item.end - item.start));
    block.title = item.label;
    container.append(block);
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < safeDuration) {
    const spacer = document.createElement('div');
    spacer.className = 'segment-timeline-gap';
    spacer.style.flexGrow = String(safeDuration - cursor);
    container.append(spacer);
  }
}

function segmentRenderCards(container, segments) {
  container.replaceChildren();
  if (!segments.length) {
    const empty = document.createElement('div');
    empty.className = 'segment-empty';
    empty.textContent = '連続して姿勢が成立する区間をまだ抽出できませんでした。';
    container.append(empty);
    return;
  }

  for (const segment of segments) {
    const card = document.createElement('article');
    card.className = `segment-card ${segment.quality}`;
    const recommendation = segment.quality === 'good'
      ? 'この区間は優先的な3D化候補です。'
      : segment.quality === 'candidate'
        ? 'この区間は3D化候補です。次工程で追加の整合性確認を行います。'
        : 'この区間は短い、または姿勢の安定性が不足しているため保留します。';

    card.innerHTML = `
      <div class="segment-card-head">
        <div>
          <span class="segment-card-kicker">区間 ${segment.id}</span>
          <h4>${segmentFormatTime(segment.start)} 〜 ${segmentFormatTime(segment.end)}</h4>
        </div>
        <span class="segment-badge ${segment.quality}">${segmentQualityLabel(segment.quality)}</span>
      </div>
      <div class="segment-card-metrics">
        <span>長さ <strong>${segmentFormatTime(segment.duration)}</strong></span>
        <span>姿勢区間 <strong>${segment.pairCount}組</strong></span>
        <span>内点率中央値 <strong>${Math.round(segment.medianInlier * 100)}%</strong></span>
        <span>視差角中央値 <strong>${segment.medianParallax.toFixed(2)}°</strong></span>
      </div>
      <p>${recommendation}</p>
    `;
    container.append(card);
  }
}

function segmentRender() {
  const panel = segmentEnsurePanel();
  if (!panel || !segmentSourceVideo || !segmentPoseTimeline) return;
  const pairs = segmentReadPairs();
  if (!pairs.length) return;

  const duration = Number.isFinite(segmentSourceVideo.duration) ? segmentSourceVideo.duration : pairs[pairs.length - 1].end;
  const signature = `${segmentSourceVideo.currentSrc || segmentSourceVideo.src}|${pairs.map((pair) => `${pair.start}-${pair.end}-${pair.state}-${pair.inlierRatio}-${pair.parallaxDeg}`).join('|')}`;
  if (signature === segmentLastSignature) return;
  segmentLastSignature = signature;

  if (segmentProgressText) segmentProgressText.textContent = '安定した3D候補区間へ自動整理しています';

  const result = segmentBuildResult(pairs);
  const candidateSegments = result.segments.filter((segment) => segment.quality === 'good' || segment.quality === 'candidate');
  const holdSegments = result.segments.filter((segment) => segment.quality === 'hold');

  panel.hidden = false;
  panel.querySelector('#segment-count').textContent = result.segments.length ? `${result.segments.length}区間` : 'なし';
  panel.querySelector('#segment-candidates').textContent = candidateSegments.length ? `${candidateSegments.length}区間` : 'なし';
  panel.querySelector('#segment-hold').textContent = holdSegments.length ? `${holdSegments.length}区間` : 'なし';
  panel.querySelector('#segment-breaks').textContent = result.breaks.length ? `${result.breaks.length}箇所` : 'なし';

  segmentRenderTimeline(panel.querySelector('#segment-timeline'), result.segments, result.breaks, duration);
  segmentRenderCards(panel.querySelector('#segment-list'), result.segments);

  const message = panel.querySelector('#segment-message');
  message.hidden = false;
  if (candidateSegments.length === 1 && result.breaks.length === 0) {
    message.className = 'message-box success';
    message.textContent = '動画全体を1つの3D化候補区間として扱えます。次工程ではこの区間内で軌跡全体の整合性を高めます。';
  } else if (candidateSegments.length > 0) {
    message.className = 'message-box success';
    message.textContent = `この動画は、まず${candidateSegments.length}個の安定した3D化候補区間として処理するのが適切です。不安定な境界を無理につながず、各候補区間を個別に再構成してから接続可能性を確認します。`;
  } else {
    message.className = 'message-box warning';
    message.textContent = '現時点では十分に長く安定した3D化候補区間を抽出できませんでした。次工程では不安定区間へ追加キーフレームを投入し、より細かい再解析を行う必要があります。';
  }

  panel.dataset.segmentCount = String(result.segments.length);
  panel.dataset.candidateCount = String(candidateSegments.length);
  panel.dataset.breakCount = String(result.breaks.length);
  window.__360gsSegmentResult = { duration, pairs, ...result, candidateSegments, holdSegments };
  window.dispatchEvent(new CustomEvent('360gs:segments-ready', { detail: window.__360gsSegmentResult }));

  if (segmentProgressText) segmentProgressText.textContent = '自動区間分割まで完了しました';
}

function segmentMaybeRun() {
  if (!segmentPoseMessage || segmentPoseMessage.hidden || !segmentPoseMessage.textContent.trim()) return;
  window.setTimeout(segmentRender, 80);
}

function segmentReset() {
  segmentLastSignature = '';
  const panel = document.querySelector('#segment-panel');
  if (panel) panel.hidden = true;
  window.__360gsSegmentResult = null;
}

if (segmentPoseMessage && segmentPoseTimeline) {
  segmentObserver = new MutationObserver(segmentMaybeRun);
  segmentObserver.observe(segmentPoseMessage, { attributes: true, attributeFilter: ['hidden', 'class'], childList: true, characterData: true, subtree: true });
  segmentSourceVideo?.addEventListener('loadedmetadata', segmentReset);
  segmentMaybeRun();
}
