// 360GS v0.3c24 Brush runtime delivery wrapper.
// Reconstruction and training mathematics remain the validated v0.3c22 build.
// This module only makes the browser delivery of that JS/WASM runtime more robust.

const BRUSH_RUNTIME_VERSION = '0.3c22';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorText(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 600);
}

async function fetchWithRetry(url, label, { reload = false } = {}) {
  const request = cache => fetch(url, { cache, credentials: 'same-origin' });
  let response;
  try {
    response = await request(reload ? 'reload' : 'force-cache');
  } catch (error) {
    throw new Error(`${label} network error: ${errorText(error)}`);
  }

  if (response.status === 429 || response.status >= 500) {
    let waitMs = 1200;
    const retryAfter = response.headers.get('Retry-After');
    const retrySeconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(retrySeconds)) {
      waitMs = Math.min(10000, Math.max(1000, retrySeconds * 1000));
    }
    console.warn(`[360GS] ${label}: HTTP ${response.status}; retrying in ${waitMs} ms`);
    await sleep(waitMs);
    try {
      response = await request('reload');
    } catch (error) {
      throw new Error(`${label} retry network error: ${errorText(error)}`);
    }
  }

  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  return response;
}

let corePromise = null;

async function loadCoreModule() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    const stableUrl = new URL('./vendor/brush-js/brush_js.js', import.meta.url);
    stableUrl.searchParams.set('v', BRUSH_RUNTIME_VERSION);
    stableUrl.searchParams.set('core', '1');

    // A small explicit request gives useful HTTP/network diagnostics before
    // dynamic import, whose browser error text is often intentionally terse.
    await fetchWithRetry(stableUrl, 'Brush JavaScript');
    try {
      return await import(stableUrl.href);
    } catch (firstError) {
      console.warn('[360GS] Brush JavaScript import failed; one cache-busting retry will be attempted.', firstError);
      const retryUrl = new URL(stableUrl);
      retryUrl.searchParams.set('retry', Date.now().toString());
      await fetchWithRetry(retryUrl, 'Brush JavaScript retry', { reload: true });
      try {
        return await import(retryUrl.href);
      } catch (secondError) {
        throw new Error(`Brush JavaScript module import failed after retry: ${errorText(secondError)}`);
      }
    }
  })();

  try {
    return await corePromise;
  } catch (error) {
    // Permit a later user-initiated retry after a transient network failure.
    corePromise = null;
    throw error;
  }
}

// Live bindings are populated after default() succeeds. training.js awaits
// default() before it reads these exports, so the existing c22 call sequence is
// preserved without modifying the training implementation itself.
export let BrushApp;
export let BrushMessageKind;
export let trainingDiagStage;

export default async function initBrushRuntime(moduleOrPath) {
  const core = await loadCoreModule();

  let wasmUrl;
  if (moduleOrPath instanceof URL) {
    wasmUrl = new URL(moduleOrPath.href);
  } else if (typeof moduleOrPath === 'string') {
    wasmUrl = new URL(moduleOrPath, globalThis.location?.href || import.meta.url);
  } else {
    wasmUrl = new URL('./vendor/brush-js/brush_js_bg.wasm', import.meta.url);
    wasmUrl.searchParams.set('v', BRUSH_RUNTIME_VERSION);
  }

  let wasmResponse = await fetchWithRetry(wasmUrl, 'Brush WebAssembly');
  const contentType = wasmResponse.headers.get('Content-Type') || 'unknown';
  const contentLength = Number(wasmResponse.headers.get('Content-Length'));
  console.info(`[360GS] Brush WASM HTTP ${wasmResponse.status} / ${contentType}${Number.isFinite(contentLength) ? ` / ${(contentLength / 1024 / 1024).toFixed(1)} MB` : ''}`);

  try {
    await core.default({ module_or_path: wasmResponse });
  } catch (firstError) {
    console.warn('[360GS] Brush WebAssembly initialization failed; one reload retry will be attempted.', firstError);
    wasmResponse = await fetchWithRetry(wasmUrl, 'Brush WebAssembly retry', { reload: true });
    try {
      await core.default({ module_or_path: wasmResponse });
    } catch (secondError) {
      throw new Error(`Brush WebAssembly initialization failed after retry: ${errorText(secondError)}`);
    }
  }

  BrushApp = core.BrushApp;
  BrushMessageKind = core.BrushMessageKind;
  trainingDiagStage = core.trainingDiagStage;

  if (typeof BrushApp !== 'function') {
    throw new Error('Brush runtime initialized but BrushApp export is unavailable.');
  }
}
