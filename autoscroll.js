const AUTO_SCROLL_STORAGE_KEY = '360gs-auto-scroll';
const AUTO_SCROLL_TARGET_IDS = [
  'analysis-panel',
  'continuity-panel',
  'feature-panel',
  'pose-panel',
  'segment-panel',
  'sfm-panel',
  'tracking-panel',
  'ba-panel',
  'dataset-panel',
];

let autoScrollEnabled = localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== 'off';
let autoScrollLastTarget = null;
let autoScrollTimer = null;

function autoScrollIsVisible(element) {
  if (!element || element.hidden) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function autoScrollEnsureControl() {
  let control = document.querySelector('#auto-scroll-control');
  if (control) return control;

  control = document.createElement('button');
  control.id = 'auto-scroll-control';
  control.type = 'button';
  control.className = 'auto-scroll-control';
  control.setAttribute('aria-pressed', autoScrollEnabled ? 'true' : 'false');
  control.setAttribute('title', '処理結果が追加されたとき、その場所まで自動で移動します');
  control.addEventListener('click', () => {
    autoScrollEnabled = !autoScrollEnabled;
    localStorage.setItem(AUTO_SCROLL_STORAGE_KEY, autoScrollEnabled ? 'on' : 'off');
    autoScrollUpdateControl();
  });
  document.body.append(control);
  autoScrollUpdateControl();
  return control;
}

function autoScrollUpdateControl() {
  const control = document.querySelector('#auto-scroll-control');
  if (!control) return;
  control.setAttribute('aria-pressed', autoScrollEnabled ? 'true' : 'false');
  control.classList.toggle('is-off', !autoScrollEnabled);
  control.innerHTML = `<span class="auto-scroll-dot" aria-hidden="true"></span><span>自動スクロール ${autoScrollEnabled ? 'ON' : 'OFF'}</span>`;
}

function autoScrollTo(element) {
  if (!autoScrollEnabled || !autoScrollIsVisible(element)) return;
  if (autoScrollLastTarget === element) return;
  autoScrollLastTarget = element;

  window.clearTimeout(autoScrollTimer);
  autoScrollTimer = window.setTimeout(() => {
    if (!autoScrollEnabled || !autoScrollIsVisible(element)) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
      inline: 'nearest',
    });
  }, 180);
}

function autoScrollNewestVisibleTarget() {
  const visible = AUTO_SCROLL_TARGET_IDS
    .map((id) => document.getElementById(id))
    .filter(autoScrollIsVisible);
  if (!visible.length) return;

  const newest = visible[visible.length - 1];
  autoScrollTo(newest);
}

function autoScrollTargetFromNode(node) {
  if (!(node instanceof Element)) return null;
  if (node.id && AUTO_SCROLL_TARGET_IDS.includes(node.id)) return node;
  for (const id of AUTO_SCROLL_TARGET_IDS) {
    const found = node.querySelector?.(`#${id}`);
    if (found) return found;
  }
  return null;
}

const autoScrollObserver = new MutationObserver((mutations) => {
  let candidate = null;

  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      const target = mutation.target;
      if (target instanceof Element && AUTO_SCROLL_TARGET_IDS.includes(target.id) && autoScrollIsVisible(target)) {
        candidate = target;
      }
    }

    for (const node of mutation.addedNodes || []) {
      const target = autoScrollTargetFromNode(node);
      if (target && autoScrollIsVisible(target)) candidate = target;
    }
  }

  if (candidate) autoScrollTo(candidate);
  else autoScrollNewestVisibleTarget();
});

autoScrollEnsureControl();
autoScrollObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden', 'class', 'style'],
});

// 最初の動画解析結果が既に表示されている状態で読み込まれた場合にも追従する。
window.setTimeout(autoScrollNewestVisibleTarget, 300);
