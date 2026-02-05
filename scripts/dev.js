const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const PORT = 3000;
const CDP_PORT = 9222;
const platform = os.platform();

// ──────────────────────────────────────────────
// Chrome/Chromium detection
// ──────────────────────────────────────────────

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  if (platform === 'win32') {
    const prefixes = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean);

    const suffixes = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
    ];

    for (const prefix of prefixes) {
      for (const suffix of suffixes) {
        const p = path.join(prefix, suffix);
        if (fs.existsSync(p)) return p;
      }
    }
  }

  if (platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  if (platform === 'linux') {
    const linuxNames = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
    for (const name of linuxNames) {
      try {
        return execSync(`which ${name}`, { encoding: 'utf8' }).trim();
      } catch {}
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// Open URL in default browser
// ──────────────────────────────────────────────

function openBrowser(url) {
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ──────────────────────────────────────────────
// Kill process occupying a port
// ──────────────────────────────────────────────

function killPort(port) {
  try {
    if (platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.trim().split('\n')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
      }
      if (pids.size > 0) console.log(`[dev] Killed old process(es) on port ${port}`);
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {}
}

// ──────────────────────────────────────────────
// Wait for a port to become reachable
// ──────────────────────────────────────────────

function waitForPort(port, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.get(`http://${host}:${port}`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    }
    attempt();
  });
}

// ──────────────────────────────────────────────
// Chrome launcher (restartable)
// ──────────────────────────────────────────────

let chrome = null;
let shuttingDown = false;

function launchChrome(chromePath, userDataDir) {
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    'about:blank',
  ];

  console.log('[dev] Launching browser with CDP on port', CDP_PORT);
  chrome = spawn(chromePath, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  });

  chrome.on('error', (err) => {
    console.error('[dev] Failed to launch browser:', err.message);
  });

  chrome.on('exit', (code) => {
    chrome = null;
    if (shuttingDown) return;
    console.log(`[dev] Browser exited (code ${code}), restarting in 2s...`);
    setTimeout(() => {
      if (!shuttingDown) launchChrome(chromePath, userDataDir);
    }, 2000);
  });
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  console.log('[dev] OrbitControl development mode');
  console.log('[dev] Platform:', platform);

  // 1. Find Chrome
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('[dev] ERROR: Could not find Chrome, Chromium, or Edge.');
    console.error('[dev] Install one of them, or set the CHROME_PATH environment variable.');
    process.exit(1);
  }
  console.log('[dev] Found browser:', chromePath);

  // 2. Create temp user-data-dir
  const userDataDir = path.join(os.tmpdir(), 'orbit-control-dev-profile');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // 3. Launch Chrome with CDP
  launchChrome(chromePath, userDataDir);

  // 4. Wait for CDP to be ready
  try {
    await waitForPort(CDP_PORT, '127.0.0.1', 15000);
    console.log('[dev] Browser CDP is ready on port', CDP_PORT);
  } catch {
    console.error('[dev] ERROR: Browser did not start CDP on port', CDP_PORT);
    shuttingDown = true;
    if (chrome) chrome.kill();
    process.exit(1);
  }

  // 5. Kill any old process on the server port, then start
  killPort(PORT);
  const serverPath = path.join(__dirname, '..', 'server.js');
  console.log('[dev] Starting OrbitControl server on port', PORT);

  const server = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(PORT),
      ORBIT_DEV: '1',
    },
  });

  server.on('error', (err) => {
    console.error('[dev] Failed to start server:', err.message);
    shuttingDown = true;
    if (chrome) chrome.kill();
    process.exit(1);
  });

  // 6. Wait for server to be ready, then open control panel
  try {
    await waitForPort(PORT, '127.0.0.1', 10000);
    const url = `http://localhost:${PORT}`;
    console.log('[dev] Server is ready at', url);
    console.log('[dev] Opening control panel in your default browser...');
    openBrowser(url);
  } catch {
    console.error('[dev] WARNING: Server did not become ready in time.');
  }

  console.log('');
  console.log('[dev] OrbitControl is running in development mode.');
  console.log(`[dev] Control panel: http://localhost:${PORT}`);
  console.log('[dev] Press Ctrl+C to stop.');
  console.log('');

  // 7. Cleanup on exit
  function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[dev] Shutting down...');
    if (chrome && !chrome.killed) {
      console.log('[dev] Stopping browser...');
      chrome.kill();
    }
    if (!server.killed) {
      console.log('[dev] Stopping server...');
      server.kill();
    }
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  server.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev] Server exited with code ${code}`);
      shuttingDown = true;
      if (chrome) chrome.kill();
      process.exit(code);
    }
  });
}

main().catch((err) => {
  console.error('[dev] Fatal error:', err);
  process.exit(1);
});
