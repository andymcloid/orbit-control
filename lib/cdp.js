const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;
let ws = null;
let cmdId = 1;
let pending = new Map();
let connected = false;
let reconnectTimer = null;
let zoomScriptId = null;
let currentZoom = 1;
let screenshotInterval = null;

// Callbacks
let onConnectChange = null;
let onScreenshotFrame = null;
let hideCursorScriptId = null;

// Cage on Pi OS Lite has no built-in --hide-cursor; the compositor only hides
// the pointer when the focused client tells it to via wl_pointer.set_cursor(null),
// which chromium does when the CSS cursor under the pointer resolves to none.
// Inject a stylesheet on every page so the kiosk never shows a cursor.
const HIDE_CURSOR_CSS = 'html,body,*{cursor:none!important;}';
const HIDE_CURSOR_JS = '(function(){function inject(){if(!document.head){return setTimeout(inject,30);}var s=document.createElement(\'style\');s.id=\'__orbit_hide_cursor\';s.textContent=' + JSON.stringify(HIDE_CURSOR_CSS) + ';document.head.appendChild(s);}inject();})();';

function setOnConnectChange(fn) { onConnectChange = fn; }
function setOnScreenshotFrame(fn) { onScreenshotFrame = fn; }
function isConnected() { return connected; }

function getDebuggerUrl() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          const page = tabs.find((t) => t.type === 'page');
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else {
            reject(new Error('No page tab found'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected to browser'));
    }
    const id = cmdId++;
    const msg = JSON.stringify({ id, method, params });
    pending.set(id, { resolve, reject, timer: setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP command timeout'));
    }, 10000) });
    ws.send(msg);
  });
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  getDebuggerUrl()
    .then((url) => {
      ws = new WebSocket(url);

      ws.on('open', async () => {
        connected = true;
        zoomScriptId = null;
        hideCursorScriptId = null;
        console.log('[CDP] Connected to Chromium');
        try { await send('Page.enable'); } catch {}
        try {
          await send('Runtime.evaluate', { expression: HIDE_CURSOR_JS });
          const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_CURSOR_JS });
          hideCursorScriptId = r.identifier;
        } catch {}
        if (currentZoom !== 1) {
          applyZoom(currentZoom).catch(() => {});
        }
        if (onConnectChange) onConnectChange(true);
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          clearTimeout(p.timer);
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        }
        // Capture a frame immediately when page finishes loading
        if (msg.method === 'Page.loadEventFired' && screenshotInterval) {
          captureFrame();
        }
      });

      ws.on('close', () => {
        connected = false;
        stopPreview();
        console.log('[CDP] Disconnected from Chromium');
        if (onConnectChange) onConnectChange(false);
        scheduleReconnect();
      });

      ws.on('error', () => {});
    })
    .catch(() => {
      connected = false;
      if (onConnectChange) onConnectChange(false);
      scheduleReconnect();
    });
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }
}

// --- Public API ---

async function navigate(url) {
  return send('Page.navigate', { url });
}

async function reload(ignoreCache = false) {
  return send('Page.reload', { ignoreCache });
}

async function clearBrowserCache() {
  await send('Network.clearBrowserCache');
}

async function getCurrentUrl() {
  const result = await send('Runtime.evaluate', {
    expression: 'window.location.href',
  });
  return result?.result?.value || null;
}

async function applyZoom(factor) {
  const js = `document.documentElement.style.zoom = '${factor}'`;
  await send('Runtime.evaluate', { expression: js });
  if (zoomScriptId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: zoomScriptId }).catch(() => {});
  }
  const result = await send('Page.addScriptToEvaluateOnNewDocument', { source: js });
  zoomScriptId = result.identifier;
}

async function setZoom(factor) {
  currentZoom = factor;
  return applyZoom(factor);
}

// Screenshot-based preview (works with --disable-gpu)
let capturing = false;

async function captureFrame() {
  if (!connected || capturing) return;
  capturing = true;
  try {
    // Use captureBeyondViewport: false to only capture what's visible
    const result = await send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 35,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    if (result?.data && onScreenshotFrame) {
      onScreenshotFrame(result.data);
    }
  } catch {}
  capturing = false;
}

let previewFps = 1;

function setPreviewFps(fps) {
  const clamped = Math.max(1, Math.min(30, parseInt(fps, 10) || 1));
  if (clamped === previewFps) return;
  previewFps = clamped;
  // Hot-swap: if a preview interval is running, restart it at the new rate.
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = setInterval(captureFrame, Math.round(1000 / previewFps));
    console.log('[CDP] Preview rate set to', previewFps, 'fps');
  }
}

function startPreview() {
  if (screenshotInterval) return;
  console.log('[CDP] Starting preview polling at', previewFps, 'fps');
  captureFrame(); // first frame immediately
  screenshotInterval = setInterval(captureFrame, Math.round(1000 / previewFps));
}

function stopPreview() {
  if (!screenshotInterval) return;
  console.log('[CDP] Stopping preview polling');
  clearInterval(screenshotInterval);
  screenshotInterval = null;
}

function isPreviewRunning() {
  return !!screenshotInterval;
}

async function click(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
  });
}

// Low-level pointer event for press/move/release/wheel — used by the preview
// pane so drag-to-select, scroll-wheel and click are forwarded faithfully
// rather than synthesised as a single tap.
function buttonMask(name) {
  if (name === 'left') return 1;
  if (name === 'right') return 2;
  if (name === 'middle') return 4;
  return 0;
}

async function mouseEvent(action, x, y, opts = {}) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  const button = opts.button || 'left';
  if (action === 'press') {
    return send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: xi, y: yi, button,
      buttons: buttonMask(button),
      clickCount: opts.clickCount || 1,
    });
  }
  if (action === 'release') {
    return send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: xi, y: yi, button,
      buttons: 0,
      clickCount: opts.clickCount || 1,
    });
  }
  if (action === 'move') {
    // While a button is held the page treats this as a drag; otherwise it's
    // a plain hover. Chromium's renderer extends text selection only when
    // mouseMoved arrives with `button` set to the held button (not 'none'),
    // matching what Puppeteer's mouse.move does.
    const buttons = opts.buttons != null ? opts.buttons : 0;
    const heldButton = buttons & 1 ? 'left'
      : buttons & 4 ? 'middle'
      : buttons & 2 ? 'right'
      : 'none';
    return send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: xi, y: yi,
      button: heldButton,
      buttons,
    });
  }
  if (action === 'wheel') {
    return send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: xi, y: yi,
      deltaX: opts.dx || 0,
      deltaY: opts.dy || 0,
    });
  }
}

async function closeBrowser() {
  return send('Browser.close');
}

module.exports = {
  connect,
  isConnected,
  setOnConnectChange,
  setOnScreenshotFrame,
  navigate,
  reload,
  clearBrowserCache,
  getCurrentUrl,
  setZoom,
  click,
  mouseEvent,
  closeBrowser,
  startPreview,
  stopPreview,
  isPreviewRunning,
  setPreviewFps,
};
