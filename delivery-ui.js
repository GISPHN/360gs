import { encodePlyToSpzV4, buildViewerUrl } from './delivery.js?v=0.3c25';

const previewUrls = [];

function setVersion() {
  document.querySelectorAll('.version').forEach(n => n.textContent = 'Prototype v0.3c25');
}

function notify(text, kind = 'success') {
  const p = document.querySelector('#train-message');
  if (!p) return;
  p.hidden = false;
  p.className = `message-box ${kind}`;
  p.textContent = text;
}

function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}

function addViewerEntry() {
  const bar = document.querySelector('.screen-toolbar');
  if (!bar || bar.querySelector('[data-c24-viewer]')) return;
  const a = document.createElement('a');
  a.dataset.c24Viewer = '1';
  a.className = 'back-button';
  a.href = './viewer.html?v=0.3c25';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '保存済み3DGSを表示';
  bar.append(a);
}

function augmentResult() {
  const result = window.__360gsTrainingResult;
  const box = document.querySelector('#train-result');
  const actions = box?.querySelector('.train-result-actions');
  if (!result?.ready || !(result.blob instanceof Blob) || !actions) return;
  if (actions.querySelector('[data-c24-spz]')) return;

  const segment = result.segmentId ?? 'result';
  const plyName = `360gs_segment_${segment}.ply`;
  const spzName = `360gs_segment_${segment}.spz`;

  const spz = document.createElement('button');
  spz.type = 'button';
  spz.className = 'train-secondary';
  spz.dataset.c24Spz = '1';
  spz.textContent = 'SPZ v4を保存';
  spz.addEventListener('click', async () => {
    const old = spz.textContent;
    spz.disabled = true;
    spz.textContent = 'SPZ v4変換中…';
    try {
      if (!(result.spzBlob instanceof Blob)) {
        notify('SPZ v4へこの端末内で変換しています。3DGSデータは外部へ送信しません。');
        result.spzBlob = await encodePlyToSpzV4(result.blob, { bounds: result.viewBounds || result.bounds });
      }
      download(result.spzBlob, spzName);
      spz.textContent = `SPZ v4を保存 (${(result.spzBlob.size / 1024 / 1024).toFixed(2)} MB)`;
      notify(`SPZ v4を生成しました。PLY ${(result.blob.size / 1024 / 1024).toFixed(2)} MB → SPZ ${(result.spzBlob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      spz.textContent = old;
      notify(`SPZ v4変換: ${e?.message || e}`, 'warning');
    } finally {
      spz.disabled = false;
    }
  });

  const webgl = document.createElement('button');
  webgl.type = 'button';
  webgl.className = 'train-secondary';
  webgl.dataset.c24Webgl = '1';
  webgl.textContent = 'WebGLビューア';
  webgl.addEventListener('click', () => {
    const u = URL.createObjectURL(result.blob);
    previewUrls.push(u);
    const url = buildViewerUrl({ src: u, name: plyName, base: location.href });
    window.open(url, '_blank', 'noopener');
  });

  const viewerLink = document.createElement('a');
  viewerLink.className = 'train-secondary';
  viewerLink.href = './viewer.html?v=0.3c25';
  viewerLink.target = '_blank';
  viewerLink.rel = 'noopener';
  viewerLink.textContent = 'PLY / SPZを別画面で開く';
  viewerLink.style.textDecoration = 'none';

  actions.append(spz, webgl, viewerLink);

  const meta = box.querySelector('#train-result-meta');
  if (meta && !meta.textContent.includes('SPZ')) {
    meta.textContent += ' / SPZ v4対応';
  }
  notify('3DGS生成が完了しました。c24ではPLYに加えてSPZ v4保存とWebGL 2表示を利用できます。');
}

setVersion();
addViewerEntry();
window.addEventListener('360gs:training-ready', () => setTimeout(augmentResult, 0));
if (window.__360gsTrainingResult?.ready) augmentResult();

window.addEventListener('beforeunload', () => {
  for (const u of previewUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
});