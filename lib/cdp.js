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
        console.log('[CDP] Connected to Chromium');
        try { await send('Page.enable'); } catch {}
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

async function reload() {
  return send('Page.reload');
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

function startPreview(intervalMs = 1000) {
  if (screenshotInterval) return;
  console.log('[CDP] Starting preview polling');
  captureFrame(); // first frame immediately
  screenshotInterval = setInterval(captureFrame, intervalMs);
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
  getCurrentUrl,
  setZoom,
  click,
  closeBrowser,
  startPreview,
  stopPreview,
  isPreviewRunning,
};
