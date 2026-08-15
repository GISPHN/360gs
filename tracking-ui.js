import './dataset.js';

const trackingSourceVideo = document.querySelector('#source-video');

function trackingEnsureStylesheet() {
  if (!document.querySelector('link[data-360gs-tracking]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './tracking.css';
    link.dataset['360gsTracking'] = '1';
    document.head.append(link);
  }
  if (!document.querySelector('link[data-360gs-dataset]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './dataset.css';
    link.dataset['360gsDataset'] = '1';
    document.head.append(link);
  }
}

function trackingEnsurePanel() {
  trackingEnsureStylesheet();
  let panel = document.querySelector('#tracking-panel');
  if (panel) return panel;
  const sfmPanel = document.querySelector('#sfm-panel');
  if (!sfmPanel) return null;
  panel = document.createElement('section');
  panel.id = 'tracking-panel';
  panel.className = 'tracking-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="tracking-heading">
      <div>
        <p class="eyebrow">特徴点追跡の安定化</p>
        <h3>高密度に特徴を追跡して3D化前の観測を増やす</h3>
      </div>
      <span class="tracking-auto">自動設定</span>
    </div>
    <p class="tracking-description">
      局所SfMで選ばれたフレームを、端末性能に合わせた解像度で再確認します。高信頼・中信頼の特徴を残し、
      前・右・後・左の偏りを確認しながら複数フレームの追跡を作ります。観測が不足する場合は自動で特徴点を追加探索します。
    </p>
    <div class="tracking-stats">
      <div><span>解析した区間</span><strong id="tracking-count">—</strong></div>
      <div><span>採用トラック</span><strong id="tracking-tracks">—</strong></div>
      <div><span>採用観測</span><strong id="tracking-observations">—</strong></div>
      <div><span>解析解像度</span><strong id="tracking-resolution">—</strong></div>
    </div>
    <div id="tracking-list" class="tracking-list"></div>
    <div id="tracking-message" class="message-box" hidden></div>
    <p class="tracking-note">特徴点が不足している場合でも、利用者が設定を変更する必要はありません。最大2回まで自動再探索し、改善した結果だけを次の全体最適化へ渡します。</p>`;
  sfmPanel.insertAdjacentElement('afterend', panel);
  return panel;
}

function trackingDirLabel(dir) {
  return ({ front: '前', right: '右', back: '後', left: '左' })[dir] || dir;
}

function trackingJudgeLabel(judge) {
  if (judge === 'good') return '良好';
  if (judge === 'candidate') return '試行可能';
  if (judge === 'reseed') return '追加探索が必要';
  return '保留';
}

function trackingRender(detail) {
  const panel = trackingEnsurePanel();
  if (!panel) return;
  panel.hidden = false;
  const results = detail?.results || [];
  panel.querySelector('#tracking-count').textContent = `${results.length}区間`;
  panel.querySelector('#tracking-tracks').textContent = (detail?.trackCount || 0).toLocaleString();
  panel.querySelector('#tracking-observations').textContent = (detail?.observationCount || 0).toLocaleString();
  panel.querySelector('#tracking-resolution').textContent = detail?.viewSize ? `${detail.viewSize}px` : '—';

  const list = panel.querySelector('#tracking-list');
  list.replaceChildren();
  for (const result of results) {
    const card = document.createElement('article');
    card.className = `tracking-card ${result.judge}`;
    const dirs = result.directionalBalance?.ratios || {};
    const directionRows = ['front', 'right', 'back', 'left'].map((dir) => {
      const pct = Math.round((dirs[dir] || 0) * 100);
      return `<div class="tracking-direction-row"><span>${trackingDirLabel(dir)}</span><div><i style="width:${Math.min(100, pct)}%"></i></div><strong>${pct}%</strong></div>`;
    }).join('');
    card.innerHTML = `
      <div class="tracking-card-head">
        <div><span>候補区間 ${result.segment?.id ?? '—'}</span><h4>${result.segment ? `${result.segment.start.toFixed(1)}秒 〜 ${result.segment.end.toFixed(1)}秒` : '特徴点追跡'}</h4></div>
        <span class="tracking-badge ${result.judge}">${trackingJudgeLabel(result.judge)}</span>
      </div>
      <div class="tracking-metrics">
        <span>採用トラック <strong>${result.trackCount}</strong></span>
        <span>採用観測 <strong>${result.observationCount}</strong></span>
        <span>高信頼 <strong>${result.high}</strong></span>
        <span>中信頼 <strong>${result.mid}</strong></span>
        <span>低信頼 <strong>${result.low}</strong></span>
        <span>自動再探索 <strong>${result.reseedPasses || 0}回</strong></span>
      </div>
      <div class="tracking-directions">
        <div class="tracking-directions-head"><span>方向別の観測分布</span><strong>${result.directionalBalance?.ok ? '偏りは許容範囲' : '偏りあり'}</strong></div>
        ${directionRows}
      </div>
      <p>${result.judge === 'good' ? '複数視点で追跡できる特徴を十分確保できました。次工程の全体最適化へ進めます。' : result.judge === 'candidate' ? '観測を一定数確保できました。ロバストな全体最適化で安定性を確認します。' : result.judge === 'reseed' ? '追加探索後も観測が少なめです。弱い観測を無理に増やさず、次工程では保守的に評価します。' : '特徴点の追跡が十分安定していません。この区間は保留を優先します。'}</p>`;
    list.append(card);
  }

  const message = panel.querySelector('#tracking-message');
  message.hidden = false;
  if (detail?.error) {
    message.className = 'message-box warning';
    message.textContent = `${detail.error} 元の局所SfM結果を使って安全側で全体最適化を試します。`;
  } else if (detail?.good?.length) {
    message.className = 'message-box success';
    message.textContent = `${detail.good.length}区間で複数視点トラックを十分確保できました。特徴点数を増やした結果を全体最適化へ渡します。`;
  } else if (detail?.candidates?.length) {
    message.className = 'message-box warning';
    message.textContent = '一定数の特徴追跡を確保できました。全体最適化で誤差が本当に改善するかを確認します。';
  } else {
    message.className = 'message-box warning';
    message.textContent = '自動再探索を行いましたが、複数視点トラックはまだ少なめです。3DGSへ無理に進まず、全体最適化で保守的に判定します。';
  }
}

function trackingReset() {
  const panel = document.querySelector('#tracking-panel');
  if (panel) panel.hidden = true;
}

window.addEventListener('360gs:tracking-summary', (event) => trackingRender(event.detail));
window.addEventListener('360gs:ba-ready', () => {
  const panel = document.querySelector('#tracking-panel');
  const baPanel = document.querySelector('#ba-panel');
  if (panel && baPanel && panel.nextElementSibling !== baPanel) baPanel.before(panel);
});
trackingSourceVideo?.addEventListener('loadedmetadata', trackingReset);
window.addEventListener('load', () => {
  document.querySelectorAll('.version').forEach((node) => { node.textContent = 'Prototype v0.3a'; });
});
