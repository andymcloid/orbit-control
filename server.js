const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getSystemInfo, restartKiosk, reboot } = require('./lib/system');
const update = require('./lib/update');
const cdp = require('./lib/cdp');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {
      url: 'https://dietpi.com',
      resolution: { width: 1920, height: 1080 },
      hideCursorDelay: 10,
      name: 'Orbit',
    };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- REST API ---

app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  const current = readSettings();
  const updated = { ...current, ...req.body };
  if (req.body.resolution) {
    updated.resolution = { ...current.resolution, ...req.body.resolution };
  }
  writeSettings(updated);
  res.json(updated);
});

app.get('/api/system-info', async (req, res) => {
  try {
    const info = await getSystemInfo();
    info.git = update.getGitInfo(__dirname);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  let currentUrl = null;
  try {
    currentUrl = await cdp.getCurrentUrl();
  } catch {}
  res.json({
    browser_connected: cdp.isConnected(),
    current_url: currentUrl,
    settings: readSettings(),
  });
});

app.post('/api/navigate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const settings = readSettings();
    settings.url = url;
    writeSettings(settings);
    await cdp.navigate(url);
    res.json({ ok: true });
    broadcastStatus();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reload', async (req, res) => {
  try {
    await cdp.reload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zoom', async (req, res) => {
  const { zoom } = req.body;
  if (!zoom || zoom < 0.25 || zoom > 5) return res.status(400).json({ error: 'zoom must be 0.25-5' });
  try {
    const settings = readSettings();
    settings.zoom = zoom;
    writeSettings(settings);
    await cdp.setZoom(zoom);
    res.json({ ok: true });
    broadcastStatus();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/click', async (req, res) => {
  const { x, y } = req.body;
  if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
  try {
    await cdp.click(Math.round(x), Math.round(y));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restart-kiosk', async (req, res) => {
  try {
    if (process.env.ORBIT_DEV === '1') {
      await cdp.closeBrowser();
    } else {
      await restartKiosk();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reboot', (req, res) => {
  res.json({ ok: true, message: 'Rebooting...' });
  setTimeout(() => reboot(), 1000);
});

let updateInProgress = false;

app.post('/api/update', async (req, res) => {
  if (updateInProgress) return res.status(409).json({ error: 'update already running' });
  if (process.env.ORBIT_DEV === '1') {
    return res.status(400).json({ error: 'update is disabled in dev mode' });
  }
  updateInProgress = true;
  res.json({ ok: true });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of controlClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  };

  try {
    await update.runUpdate(__dirname, {
      onLine: (stream, line) => broadcast({ type: 'update-output', stream, line }),
      onStep: (step) => broadcast({ type: 'update-step', step }),
    });
    update.invalidateGitInfoCache();
    broadcast({ type: 'update-status', status: 'restarting' });
    // Give the websocket a moment to flush, then exit. systemd's Restart=always
    // brings the service back up with the freshly pulled code.
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    broadcast({ type: 'update-status', status: 'error', error: err.message });
    updateInProgress = false;
  }
});

// --- WebSocket (control panel live updates + preview) ---

const controlClients = new Set();

function broadcastStatus() {
  const data = JSON.stringify({
    type: 'status',
    browser_connected: cdp.isConnected(),
    settings: readSettings(),
  });
  for (const ws of controlClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function updatePreview() {
  let anyWant = false;
  for (const ws of controlClients) {
    if (ws._wantPreview) { anyWant = true; break; }
  }
  if (anyWant && cdp.isConnected()) {
    cdp.startPreview();
  } else {
    cdp.stopPreview();
  }
}

wss.on('connection', (ws) => {
  controlClients.add(ws);
  ws._wantPreview = false;

  ws.send(JSON.stringify({
    type: 'status',
    browser_connected: cdp.isConnected(),
    settings: readSettings(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'preview-start') {
      ws._wantPreview = true;
      updatePreview();
    } else if (msg.type === 'preview-stop') {
      ws._wantPreview = false;
      updatePreview();
    }
  });

  ws.on('close', () => {
    controlClients.delete(ws);
    updatePreview();
  });
});

// Forward screenshot frames to control clients that want preview
cdp.setOnScreenshotFrame((data) => {
  const msg = JSON.stringify({ type: 'frame', data });
  for (const ws of controlClients) {
    if (ws._wantPreview && ws.readyState === 1) ws.send(msg);
  }
});

// --- CDP connection state ---
cdp.setOnConnectChange(async (connected) => {
  broadcastStatus();
  if (connected) {
    updatePreview();
    const settings = readSettings();
    if (settings.zoom && settings.zoom !== 1) {
      cdp.setZoom(settings.zoom).catch(() => {});
    }
    // Navigate to saved URL if browser is on a blank page
    try {
      const currentUrl = await cdp.getCurrentUrl();
      if (settings.url && (!currentUrl || currentUrl === 'about:blank' || currentUrl === 'chrome://newtab/')) {
        cdp.navigate(settings.url).catch(() => {});
      }
    } catch {}
  }
});

// --- Start ---

const PORT = parseInt(process.env.PORT, 10) || 80;
server.listen(PORT, () => {
  console.log(`OrbitControl running on http://0.0.0.0:${PORT}`);
  cdp.connect();
});
