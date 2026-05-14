# Pi OS Lite + cage Stack Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate OrbitControl's kiosk runtime from DietPi Kiosk (xinit+X11) to Raspberry Pi OS Lite 64-bit (Bookworm) with cage as the Wayland kiosk compositor. Replace xbindkeys hotkey with an evdev listener in Node. Rewrite WiFi management against nmcli.

**Architecture:** Clean break — no DietPi compatibility retained. The Node/Express server is unchanged in shape (same endpoints, same settings schema); only `lib/wifi.js` is rewritten and `lib/hotkey.js` is added. Pi-side scripts (`setup.sh`, `chromium-autostart.sh`) are largely rewritten. Frontend untouched.

**Tech Stack:** Node 18+, Express, ws, NetworkManager (nmcli), cage (Wayland kiosk compositor), Chromium with Ozone Wayland, systemd autologin, raw evdev reads from `/dev/input/event*`.

**Spec:** [docs/superpowers/specs/2026-05-15-kiosk-pi-os-cage-migration-design.md](../specs/2026-05-15-kiosk-pi-os-cage-migration-design.md)

**Testing approach:** This repo has no test framework — existing pattern is `npm run dev` (starts Chrome with CDP + server in `ORBIT_DEV=1`) for manual smoke testing. We follow that pattern. Pi-side changes (setup.sh, autostart, cage, hotkey, wifi nmcli) require deployment to a real Pi for verification — Task 8 is the end-to-end smoke test.

---

## File Structure

| File | Responsibility |
|---|---|
| `server.js` | Express app + WS. Add `toggleAdminPanel()` helper; wire `hotkey.start()` at boot. |
| `lib/hotkey.js` (new) | Raw evdev reader. Exports `start(onTrigger)`. No-op on non-Linux / dev mode. |
| `lib/wifi.js` | Full rewrite: nmcli-based. Same public API. |
| `lib/system.js` | Verified unchanged — `restartKiosk()` continues to use the getty@tty1 chain. |
| `scripts/setup.sh` | Rewritten: Pi OS Lite packages, Node install, autologin, .bash_profile, input group. |
| `chromium-autostart.sh` | Inner loop rewritten: cage replaces xinit. |
| `README.md` | Install section rewritten for Pi OS Lite. |
| `package.json` | No new deps (hotkey.js uses raw fs.read). |

---

## Task 1: Extract `toggleAdminPanel()` helper in server.js

**Goal:** Refactor `/api/admin-toggle` endpoint body into a reusable function so both the HTTP endpoint and the hotkey listener can call the same code path. No behavior change.

**Files:**
- Modify: `server.js:140-156` (the existing `/api/admin-toggle` handler)

- [ ] **Step 1: Add the helper function above the route handlers**

Insert this function in `server.js` immediately after `writeSettings()` (around line 29, before `const app = express()`):

```javascript
async function toggleAdminPanel() {
  const settings = readSettings();
  const port = parseInt(process.env.PORT, 10) || 80;
  const adminUrl = 'http://localhost' + (port === 80 ? '' : ':' + port) + '/';
  let currentUrl = '';
  try {
    currentUrl = (await cdp.getCurrentUrl()) || '';
  } catch {}
  const isOnAdmin = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(currentUrl);
  const target = isOnAdmin ? (settings.url || 'https://example.com') : adminUrl;
  await cdp.navigate(target);
  return { target, was: currentUrl };
}
```

- [ ] **Step 2: Replace the endpoint body to call the helper**

Find the existing handler at `server.js:140-156` and replace it with:

```javascript
app.post('/api/admin-toggle', async (req, res) => {
  try {
    const result = await toggleAdminPanel();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Smoke-test the endpoint in dev mode**

Run on a separate terminal:
```
npm run dev
```

Wait for the dev browser + server to start. Then in another terminal:
```
curl -X POST http://localhost:3000/api/admin-toggle
```

Expected: `{"ok":true,"target":"http://localhost:3000/","was":"about:blank"}` (or similar — the exact `was` value depends on what page the dev browser is on). Then run it again — `target` should flip to the saved URL.

Stop the dev server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Extract toggleAdminPanel helper from admin-toggle endpoint

Prep work for the evdev hotkey listener — it needs to invoke the
same toggle logic without an HTTP roundtrip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create `lib/hotkey.js` with raw evdev reader

**Goal:** New module that listens to `/dev/input/event*` for Ctrl+Alt+A presses and invokes a callback. No npm dependency — reads the evdev struct directly via `fs.createReadStream`.

**Files:**
- Create: `lib/hotkey.js`

- [ ] **Step 1: Write the module**

Create `lib/hotkey.js` with this content:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

// Linux evdev input_event struct (24 bytes on 64-bit):
//   struct timeval time;  // 16 bytes (sec + usec, both 8 bytes)
//   __u16 type;
//   __u16 code;
//   __s32 value;
const EVENT_SIZE = 24;
const EV_KEY = 1;

// Linux input event codes (from include/uapi/linux/input-event-codes.h)
const KEY_LEFTCTRL = 29;
const KEY_RIGHTCTRL = 97;
const KEY_LEFTALT = 56;
const KEY_RIGHTALT = 100;
const KEY_A = 30;

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';

const INPUT_DIR = '/dev/input';
const DEBOUNCE_MS = 500;

function watchDevice(devicePath, onTrigger, state) {
  let stream;
  try {
    stream = fs.createReadStream(devicePath);
  } catch (err) {
    console.warn('[hotkey] cannot open', devicePath, err.message);
    return null;
  }

  let buf = Buffer.alloc(0);

  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= EVENT_SIZE) {
      const event = buf.slice(0, EVENT_SIZE);
      buf = buf.slice(EVENT_SIZE);

      const type = event.readUInt16LE(16);
      const code = event.readUInt16LE(18);
      const value = event.readInt32LE(20);

      if (type !== EV_KEY) continue;

      // value: 0 = key up, 1 = key down, 2 = key repeat
      const down = value === 1 || value === 2;

      if (code === KEY_LEFTCTRL || code === KEY_RIGHTCTRL) {
        state.ctrl = down;
      } else if (code === KEY_LEFTALT || code === KEY_RIGHTALT) {
        state.alt = down;
      } else if (code === KEY_A && value === 1 && state.ctrl && state.alt) {
        const now = Date.now();
        if (now - state.lastTrigger > DEBOUNCE_MS) {
          state.lastTrigger = now;
          try {
            onTrigger();
          } catch (err) {
            console.warn('[hotkey] trigger callback threw:', err.message);
          }
        }
      }
    }
  });

  stream.on('error', (err) => {
    if (err.code !== 'ENODEV') {
      console.warn('[hotkey] stream error on', devicePath, err.message);
    }
  });

  return stream;
}

function scanAndWatch(onTrigger, openStreams) {
  let entries;
  try {
    entries = fs.readdirSync(INPUT_DIR);
  } catch (err) {
    console.warn('[hotkey] cannot read', INPUT_DIR, err.message);
    return;
  }

  for (const name of entries) {
    if (!/^event\d+$/.test(name)) continue;
    const full = path.join(INPUT_DIR, name);
    if (openStreams.has(full)) continue;

    // Per-device modifier state — events from one keyboard don't leak to another
    const state = { ctrl: false, alt: false, lastTrigger: 0 };
    const stream = watchDevice(full, onTrigger, state);
    if (stream) {
      openStreams.set(full, stream);
      stream.on('close', () => openStreams.delete(full));
    }
  }
}

function start(onTrigger) {
  if (!isLinux || isDevMode) {
    console.log('[hotkey] skipping (non-Linux or dev mode)');
    return;
  }

  const openStreams = new Map();
  scanAndWatch(onTrigger, openStreams);

  // Hot-plug: re-scan when /dev/input changes
  try {
    fs.watch(INPUT_DIR, () => {
      // Small delay — udev events come in bursts
      setTimeout(() => scanAndWatch(onTrigger, openStreams), 200);
    });
  } catch (err) {
    console.warn('[hotkey] cannot watch', INPUT_DIR, err.message);
  }

  console.log('[hotkey] listening for Ctrl+Alt+A on', openStreams.size, 'device(s)');
}

module.exports = { start };
```

- [ ] **Step 2: Sanity-check on the dev machine**

Run this one-liner to make sure the module loads without errors:

```bash
node -e "require('./lib/hotkey').start(() => console.log('TRIGGER'))"
```

Expected on Windows/Mac: `[hotkey] skipping (non-Linux or dev mode)` then the process exits (no event loop work pending).

- [ ] **Step 3: Commit**

```bash
git add lib/hotkey.js
git commit -m "$(cat <<'EOF'
Add lib/hotkey.js — raw evdev listener for Ctrl+Alt+A

Replaces the xbindkeys-based hotkey from the X11 stack. Reads
/dev/input/event* directly without an npm dep so we don't bet on
a native module building on arm64.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire `hotkey.start()` into server.js

**Goal:** After `server.listen()`, start the hotkey listener so Ctrl+Alt+A on any keyboard triggers `toggleAdminPanel()`.

**Files:**
- Modify: `server.js` (top imports + bottom of file)

- [ ] **Step 1: Add the import**

In `server.js` near the other lib imports (line 6-9), add:

```javascript
const hotkey = require('./lib/hotkey');
```

- [ ] **Step 2: Start the listener after `server.listen()`**

Find `server.js:335-338` (the `server.listen(PORT, ...)` block at the bottom). Replace it with:

```javascript
server.listen(PORT, () => {
  console.log(`OrbitControl running on http://0.0.0.0:${PORT}`);
  cdp.connect();
  hotkey.start(() => {
    toggleAdminPanel().catch((err) =>
      console.warn('[hotkey] toggle failed:', err.message)
    );
  });
});
```

- [ ] **Step 3: Smoke-test the dev server still starts**

```
npm run dev
```

Expected output should include `[hotkey] skipping (non-Linux or dev mode)`. Server starts normally on port 3000. Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Wire hotkey listener into server startup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `lib/wifi.js` against nmcli

**Goal:** Replace wpa_cli with nmcli. Public API (`getStatus`, `listSaved`, `scan`, `connect`, `forget`) unchanged so the frontend WiFi modal keeps working. Dev-mode fake data preserved.

**Files:**
- Replace entire contents: `lib/wifi.js`

- [ ] **Step 1: Replace the file**

Overwrite `lib/wifi.js` with this:

```javascript
const { execFile } = require('child_process');
const os = require('os');

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';
const IFACE = process.env.ORBIT_WIFI_IFACE || 'wlan0';
const NMCLI = '/usr/bin/nmcli';

function nmcli(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!isLinux || isDevMode) return resolve('');
    execFile(NMCLI, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.message = (err.message || '') + (stderr ? ' — ' + stderr.trim() : '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

// Unescape nmcli's -t (terse) output: \: → :, \\ → \
function unescape(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

// Split a -t mode row on unescaped colons.
function splitTerse(row) {
  const out = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      cur += row[i + 1];
      i++;
    } else if (ch === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function getStatus() {
  if (!isLinux || isDevMode) return { connected: false, ssid: null, ip: null, state: 'DEV' };

  // nmcli -t -f GENERAL.STATE,IP4.ADDRESS,GENERAL.CONNECTION device show <iface>
  let out = '';
  try {
    out = await nmcli(['-t', '-f', 'GENERAL.STATE,IP4.ADDRESS,GENERAL.CONNECTION', 'device', 'show', IFACE]);
  } catch (err) {
    return { connected: false, ssid: null, ip: null, state: 'ERROR', error: err.message };
  }

  let stateRaw = '';
  let ip = null;
  let connName = null;
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);
    if (key === 'GENERAL.STATE') stateRaw = val;
    else if (key.startsWith('IP4.ADDRESS')) ip = val.split('/')[0] || null;
    else if (key === 'GENERAL.CONNECTION') connName = val && val !== '--' ? val : null;
  }

  // stateRaw is e.g. "100 (connected)" or "30 (disconnected)"
  const connected = /^100/.test(stateRaw);

  // Get SSID, BSSID, freq from the active wifi connection (if any)
  let ssid = connName;
  let bssid = null;
  let freq = null;
  if (connected) {
    try {
      const listOut = await nmcli(['-t', '-f', 'IN-USE,SSID,BSSID,FREQ', 'device', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'no']);
      for (const line of listOut.split('\n')) {
        if (!line) continue;
        const parts = splitTerse(line);
        if (parts[0] === '*') {
          ssid = parts[1] || ssid;
          bssid = parts[2] || null;
          freq = parts[3] ? parseInt(parts[3], 10) : null;
          break;
        }
      }
    } catch {}
  }

  return {
    connected,
    ssid: ssid || null,
    bssid,
    ip,
    freq,
    state: stateRaw.replace(/^\d+\s*\(?|\)?\s*$/g, '').toUpperCase() || null,
  };
}

async function listSaved() {
  if (!isLinux || isDevMode) return [];
  const out = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
  const result = [];
  let activeOut = '';
  try {
    activeOut = await nmcli(['-t', '-f', 'NAME', 'connection', 'show', '--active']);
  } catch {}
  const active = new Set(activeOut.split('\n').map((l) => unescape(l.trim())).filter(Boolean));

  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = splitTerse(line);
    if (parts[1] !== '802-11-wireless') continue;
    const name = parts[0];
    result.push({
      id: name, // nmcli uses connection name as the stable identifier
      ssid: name, // connection name == SSID when created via `nmcli device wifi connect`
      current: active.has(name),
      disabled: false,
    });
  }
  return result;
}

async function scan() {
  if (!isLinux || isDevMode) {
    return [
      { ssid: 'DevNetwork', level: -50, quality: 100, secured: true, freq: 2412 },
    ];
  }
  const out = await nmcli(
    ['-t', '-f', 'SSID,SIGNAL,SECURITY,FREQ,BSSID', 'device', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'yes'],
    15000
  );
  const networks = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = splitTerse(line);
    const ssid = parts[0];
    if (!ssid || ssid === '--') continue;
    const signal = parseInt(parts[1], 10) || 0;
    const security = parts[2] || '';
    const freq = parseInt(parts[3], 10) || null;
    const bssid = parts[4] || null;

    const existing = networks.get(ssid);
    if (!existing || signal > existing.quality) {
      networks.set(ssid, {
        ssid,
        bssid,
        freq,
        // No dBm from nmcli — convert quality back to a rough dBm so frontend keeps working
        level: signal > 0 ? Math.round(-100 + signal / 2) : -100,
        quality: signal,
        secured: security !== '' && security !== '--',
        flags: security,
      });
    }
  }
  return Array.from(networks.values()).sort((a, b) => b.quality - a.quality);
}

async function connect(ssid, password) {
  if (!ssid) throw new Error('ssid required');
  if (!isLinux || isDevMode) return { id: -1, dev: true };

  const saved = await listSaved();
  const existing = saved.find((n) => n.ssid === ssid);

  if (existing && !password) {
    // Already saved, no password change — just bring it up
    await nmcli(['connection', 'up', ssid], 30000);
    return { id: ssid };
  }

  if (existing && password) {
    // Update password on existing connection
    await nmcli(['connection', 'modify', ssid, '802-11-wireless-security.psk', password]);
    await nmcli(['connection', 'up', ssid], 30000);
    return { id: ssid };
  }

  // New network — let nmcli create the connection
  const args = ['device', 'wifi', 'connect', ssid, 'ifname', IFACE];
  if (password) args.push('password', password);
  await nmcli(args, 30000);
  return { id: ssid };
}

async function forget(ssid) {
  if (!isLinux || isDevMode) return { ok: true, dev: true };
  const saved = await listSaved();
  const target = saved.find((n) => n.ssid === ssid);
  if (!target) throw new Error('network not saved');
  await nmcli(['connection', 'delete', ssid]);
  return { ok: true };
}

module.exports = { getStatus, listSaved, scan, connect, forget };
```

- [ ] **Step 2: Smoke-test dev-mode paths**

```
npm run dev
```

Open the control panel, click "Manage" under Network, click "Scan". You should see `DevNetwork` appear (the dev-mode fake from line 71). The saved list should be empty. Stop the dev server with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add lib/wifi.js
git commit -m "$(cat <<'EOF'
Rewrite lib/wifi.js against nmcli for Bookworm

NetworkManager is the default network stack on Pi OS Lite Bookworm,
so wpa_cli no longer has a control socket. Public API (getStatus,
listSaved, scan, connect, forget) unchanged so the frontend WiFi
modal keeps working.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite `chromium-autostart.sh` for cage

**Goal:** Replace the xinit-based inner loop with `cage -s -- chromium-browser`. Drop unclutter, xbindkeys, xrandr. Keep settings-fetch, the OrbitControl-server wait loop, and the crash-restart loop.

**Files:**
- Replace entire contents: `chromium-autostart.sh`

- [ ] **Step 1: Replace the file**

Overwrite `chromium-autostart.sh` with this:

```bash
#!/bin/bash
# OrbitControl Kiosk Autostart (Pi OS Lite + cage)
# Chromium loads URL directly under cage; OrbitControl controls it via CDP (port 9222).

OC_PORT="${ORBIT_PORT:-80}"
LOG=$HOME/kiosk.log

# Wait for OrbitControl server to be ready (max 30s)
echo "[$(date)] Waiting for OrbitControl server (port $OC_PORT)..." >> "$LOG"
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${OC_PORT}/api/settings" > /dev/null 2>&1; then
    echo "[$(date)] OrbitControl server is ready" >> "$LOG"
    break
  fi
  sleep 1
done

# Read settings (URL + resolution) from OrbitControl
fetch_settings() {
  curl -sf "http://localhost:${OC_PORT}/api/settings" 2>/dev/null
}

extract() {
  echo "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"
}

extract_num() {
  echo "$1" | sed -n "s/.*\"$2\":\\([0-9][0-9]*\\).*/\\1/p"
}

read_kiosk_args() {
  local s url w h res
  s=$(fetch_settings)
  url=$(extract "$s" "url"); url="${url:-https://dietpi.com}"
  res=$(echo "$s" | sed -n 's/.*"resolution":{\([^}]*\)}.*/\1/p')
  w=$(extract_num "$res" "width")
  h=$(extract_num "$res" "height")
  if [ -z "$w" ] || [ -z "$h" ] || [ "$w" -lt 800 ] || [ "$h" -lt 600 ]; then
    w=1920; h=1080
  fi
  KIOSK_URL="$url"
  KIOSK_W="$w"
  KIOSK_H="$h"
}

# Kiosk loop — if chromium/cage exits/crashes, it restarts automatically
while true; do
  read_kiosk_args
  echo "[$(date)] Starting kiosk: ${KIOSK_W}x${KIOSK_H} URL=$KIOSK_URL" >> "$LOG"

  cage -s -- chromium-browser \
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform,VaapiVideoDecoder,CanvasOopRasterization \
    --kiosk \
    --start-fullscreen \
    --window-size=${KIOSK_W},${KIOSK_H} \
    --noerrdialogs \
    --disable-infobars \
    --ignore-gpu-blocklist \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --use-gl=egl \
    --no-sandbox \
    --remote-debugging-port=9222 \
    "$KIOSK_URL" >> "$LOG" 2>&1

  echo "[$(date)] cage/chromium exited, restarting in 3s..." >> "$LOG"
  sleep 3
done
```

- [ ] **Step 2: Commit**

```bash
git add chromium-autostart.sh
git commit -m "$(cat <<'EOF'
Rewrite chromium-autostart.sh for cage on Pi OS Lite

Replaces the xinit/X11 launch with cage (Wayland kiosk compositor).
Drops unclutter-xfixes (cage handles cursor hiding), xbindkeys
(now lib/hotkey.js on the server side), and xrandr mode-switching
(cage takes HDMI native).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite `scripts/setup.sh` for Pi OS Lite

**Goal:** End-to-end setup on a clean Pi OS Lite 64-bit Bookworm install. Idempotent. Installs Node.js + cage + chromium + NetworkManager. Configures tty1 autologin, writes `.bash_profile`, adds user to `input` group, installs systemd service, copies autostart script.

**Files:**
- Replace entire contents: `scripts/setup.sh`

- [ ] **Step 1: Replace the file**

Overwrite `scripts/setup.sh` with this:

```bash
#!/bin/bash
set -e

# OrbitControl Production Setup Script (Pi OS Lite 64-bit, Bookworm)
# Run with: sudo bash scripts/setup.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $1"; }
error() { echo -e "${RED}[setup]${NC} $1"; exit 1; }

# --- Pre-flight ---

if [[ "$(uname)" != "Linux" ]]; then
  error "This setup script is for Linux only. Use 'npm run dev' for development on Windows/Mac."
fi

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root. Try: sudo bash scripts/setup.sh"
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIOSK_USER="${SUDO_USER:-pi}"
KIOSK_HOME=$(eval echo "~$KIOSK_USER")

if [[ ! -d "$KIOSK_HOME" ]]; then
  error "Home directory for user '$KIOSK_USER' not found: $KIOSK_HOME"
fi

info "Install directory: $INSTALL_DIR"
info "Kiosk user: $KIOSK_USER (home: $KIOSK_HOME)"

# --- Install system packages ---

info "Checking system packages..."
PACKAGES_TO_INSTALL=()
for pkg in chromium-browser cage network-manager curl; do
  if ! dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
    PACKAGES_TO_INSTALL+=("$pkg")
  fi
done

if [[ ${#PACKAGES_TO_INSTALL[@]} -gt 0 ]]; then
  info "Installing: ${PACKAGES_TO_INSTALL[*]}"
  apt-get update -qq
  apt-get install -y -qq "${PACKAGES_TO_INSTALL[@]}"
else
  info "All system packages already installed."
fi

# --- Install Node.js 20.x if missing or too old ---

NODE_BIN="$(which node 2>/dev/null || echo '')"
NEED_NODE=1
if [[ -n "$NODE_BIN" ]]; then
  NODE_MAJOR=$($NODE_BIN --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    NEED_NODE=0
    info "Node.js $($NODE_BIN --version) already installed."
  fi
fi

if [[ "$NEED_NODE" -eq 1 ]]; then
  info "Installing Node.js 20.x via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  NODE_BIN="$(which node)"
  info "Installed Node.js $($NODE_BIN --version)"
fi

# --- npm install ---

info "Installing Node.js dependencies..."
cd "$INSTALL_DIR"
OWNER=$(stat -c '%U' "$INSTALL_DIR" 2>/dev/null || echo "root")
if [[ "$OWNER" != "root" ]]; then
  sudo -u "$OWNER" npm install --production
else
  npm install --production
fi

# --- Settings file ---

if [[ ! -f "$INSTALL_DIR/settings.json" ]]; then
  info "Creating settings.json from example..."
  cp "$INSTALL_DIR/settings.example.json" "$INSTALL_DIR/settings.json"
  chown "$OWNER:$OWNER" "$INSTALL_DIR/settings.json" 2>/dev/null || true
else
  info "settings.json already exists, skipping."
fi

# --- Add kiosk user to input group (for evdev /dev/input/event* reads) ---

if id -nG "$KIOSK_USER" | grep -qw input; then
  info "$KIOSK_USER already in 'input' group."
else
  info "Adding $KIOSK_USER to 'input' group..."
  usermod -aG input "$KIOSK_USER"
fi

# --- systemd service for orbit-control ---

SERVICE_FILE="/etc/systemd/system/orbit-control.service"
info "Writing systemd service..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OrbitControl Kiosk Manager
After=network.target
Before=getty@tty1.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable orbit-control
systemctl restart orbit-control
info "orbit-control service enabled and started."

# --- tty1 autologin override ---

AUTOLOGIN_DIR="/etc/systemd/system/getty@tty1.service.d"
AUTOLOGIN_FILE="$AUTOLOGIN_DIR/override.conf"
DESIRED_AUTOLOGIN="[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM"

mkdir -p "$AUTOLOGIN_DIR"
if [[ -f "$AUTOLOGIN_FILE" ]] && diff -q <(echo "$DESIRED_AUTOLOGIN") "$AUTOLOGIN_FILE" >/dev/null 2>&1; then
  info "tty1 autologin already configured."
else
  info "Configuring tty1 autologin for $KIOSK_USER..."
  echo "$DESIRED_AUTOLOGIN" > "$AUTOLOGIN_FILE"
  systemctl daemon-reload
  # Don't restart getty@tty1 here — if we're on it, we'd kick ourselves off.
fi

# --- Copy chromium-autostart.sh to kiosk user home ---

AUTOSTART_DEST="$KIOSK_HOME/chromium-autostart.sh"
cp "$INSTALL_DIR/chromium-autostart.sh" "$AUTOSTART_DEST"
chmod +x "$AUTOSTART_DEST"
chown "$KIOSK_USER:$KIOSK_USER" "$AUTOSTART_DEST" 2>/dev/null || true
info "Autostart script copied to $AUTOSTART_DEST"

# --- .bash_profile — auto-launch on tty1 ---

BASH_PROFILE="$KIOSK_HOME/.bash_profile"
MARKER="# OrbitControl auto-start"
PROFILE_SNIPPET="$MARKER
if [ \"\$(tty)\" = \"/dev/tty1\" ] && [ -z \"\$XDG_RUNTIME_DIR\" ] && [ -x ~/chromium-autostart.sh ]; then
  exec ~/chromium-autostart.sh
fi"

if [[ -f "$BASH_PROFILE" ]] && grep -qF "$MARKER" "$BASH_PROFILE"; then
  info ".bash_profile auto-start snippet already present."
else
  info "Appending auto-start snippet to $BASH_PROFILE..."
  echo "" >> "$BASH_PROFILE"
  echo "$PROFILE_SNIPPET" >> "$BASH_PROFILE"
  chown "$KIOSK_USER:$KIOSK_USER" "$BASH_PROFILE" 2>/dev/null || true
fi

# --- Done ---

echo ""
info "==============================="
info " OrbitControl setup complete!"
info "==============================="
echo ""
info "Service status:  systemctl status orbit-control"
info "Server logs:     journalctl -u orbit-control -f"
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
info "Control panel:   http://${IP}/"
echo ""
warn "Reboot to start the kiosk:   sudo reboot"
echo ""
```

- [ ] **Step 2: Commit**

```bash
git add scripts/setup.sh
git commit -m "$(cat <<'EOF'
Rewrite setup.sh for Pi OS Lite 64-bit (Bookworm)

End-to-end clean-install setup: installs Node.js + cage +
chromium + NetworkManager, configures tty1 autologin, writes
.bash_profile to auto-launch the kiosk, adds the kiosk user
to the input group for evdev access. Idempotent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update README.md install instructions

**Goal:** Replace DietPi-specific install steps with Pi OS Lite instructions. Document the resolution-dropdown semantics change.

**Files:**
- Modify: `README.md` (install section, hardware-requirements section if present)

- [ ] **Step 1: Read the current README**

Open `README.md` and locate the install section (mentions "DietPi", "kiosk user", or similar). Note its current structure so the rewrite matches the surrounding tone.

- [ ] **Step 2: Replace the install section**

Replace the DietPi install steps with a section like this (adapt headings to match the existing README style):

```markdown
## Install on a Raspberry Pi

**Target:** Raspberry Pi 4 or newer, Raspberry Pi OS Lite 64-bit (Bookworm).

1. Flash Raspberry Pi OS Lite 64-bit with the Raspberry Pi Imager. In imager settings, set:
   - Hostname (e.g. `orbit`)
   - Username (e.g. `pi` — any name works)
   - WiFi (optional; you can set it up later via the control panel over Ethernet)
   - Enable SSH
2. SSH into the Pi.
3. Clone and run setup:
   ```bash
   git clone <your-repo-url> orbit-control
   cd orbit-control
   sudo bash scripts/setup.sh
   sudo reboot
   ```
4. After reboot, the kiosk shows the URL configured in `settings.json` (defaults to a placeholder — set your real URL via the control panel at `http://<pi-ip>/`).

### What setup.sh does

- Installs `chromium-browser`, `cage` (Wayland kiosk compositor), `network-manager`, and Node.js 20.x
- Configures tty1 autologin for your user
- Writes `~/.bash_profile` to auto-launch the kiosk on tty1 login
- Adds the kiosk user to the `input` group (so Ctrl+Alt+A hotkey works)
- Installs and starts the `orbit-control` systemd service on port 80

### Hotkey: Ctrl+Alt+A

Plug in a USB keyboard, press **Ctrl+Alt+A** to toggle between the kiosk URL and the admin control panel. Useful when WiFi is misconfigured and you need to reach the panel without network access.

### Display resolution

Under cage, the physical display resolution is determined by HDMI EDID (whatever the screen reports as its preferred mode). The "Display Resolution" dropdown in the control panel sets chromium's reported viewport — useful for forcing a layout — but doesn't change the actual output mode.
```

If the existing README has an "Environment variables" table, leave it alone. If it references xinit / xbindkeys / DietPi anywhere outside the install section, update those references too (search for `dietpi`, `xinit`, `xbindkeys`, `DietPi`).

- [ ] **Step 3: Verify by reading the diff**

```bash
git diff README.md
```

Check that no stray DietPi references remain.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Update README for Pi OS Lite + cage install path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: End-to-end smoke test on the Pi

**Goal:** Verify the full migration works on the user's actual Pi. This task is manual — the user runs the checks and reports back. No code changes if everything passes; bug-fix follow-up tasks if not.

**Files:** None directly. Bugs found here become new tasks.

- [ ] **Step 1: Deploy to the Pi**

On the Pi (SSH'd in):
```bash
cd ~/orbit-control 2>/dev/null || git clone <repo-url> ~/orbit-control && cd ~/orbit-control
git pull
sudo bash scripts/setup.sh
sudo reboot
```

- [ ] **Step 2: After reboot, verify the kiosk boots**

Power-on or post-reboot: within ~30s, the configured URL should appear fullscreen on the HDMI display. The control panel should be reachable at `http://<pi-ip>/` from another machine.

If the kiosk doesn't appear:
- SSH in (it should still work)
- Check `journalctl -u orbit-control -n 100`
- Check `cat ~/kiosk.log`
- Check `systemctl status getty@tty1`

- [ ] **Step 3: Smoke checklist (matches spec § Testing Strategy)**

From the control panel at `http://<pi-ip>/`:
- [ ] Click **Reload** — kiosk reloads
- [ ] Click **Clear cache & reload** — kiosk reloads with cleared cache
- [ ] Set a new URL via the URL field + Go — kiosk navigates
- [ ] Toggle preview LED on the monitor frame — preview frames stream
- [ ] **Manage** under Network → **Scan** — real networks appear
- [ ] Connect to a test SSID (or use Forget on a saved one)
- [ ] **Restart kiosk** button — kiosk restarts, panel reconnects
- [ ] Plug in a USB keyboard, press **Ctrl+Alt+A** — kiosk switches to admin panel; press again — kiosk returns to URL
- [ ] **Reboot system** button — Pi reboots, comes back up showing the kiosk

In the kiosk itself (via Ctrl+Alt+A → admin → switch URL to `chrome://gpu` temporarily):
- [ ] **Canvas**, **WebGL**, **Video Decode** show "Hardware accelerated"

- [ ] **Step 4: Report results**

If everything passes: migration complete. Spec 2 (advanced flags panel) can begin.

If anything fails: capture the failing output (`journalctl -u orbit-control -n 200`, `cat ~/kiosk.log`, `nmcli device status`, etc.) and create follow-up tasks. The most likely failure points:
- Cage refuses to start because user isn't in `video` group → add `usermod -aG video "$KIOSK_USER"` to setup.sh
- nmcli command syntax differs slightly → fix per real-world output
- evdev struct size differs on this kernel (rare on arm64) → adjust `EVENT_SIZE`

---

## Self-Review

This plan has been checked against the spec:

- **§ Section 1 (setup.sh):** Covered by Task 6 (packages, Node install, autologin override, .bash_profile, input group, idempotence).
- **§ Section 2 (chromium-autostart.sh):** Covered by Task 5 (cage launch, dropped X11 tooling, Wayland flags retained, settings-fetch + restart-loop preserved).
- **§ Section 3 (lib/wifi.js):** Covered by Task 4 (nmcli for all five exports, dev-mode fakes, escape handling, 30s connect timeout).
- **§ Section 4 (lib/hotkey.js + server.js wiring):** Covered by Tasks 1-3 (helper extraction, raw evdev reader, hot-plug, integration).
- **§ README update:** Covered by Task 7.
- **§ Testing Strategy:** Covered by Task 8 smoke checklist.
- **§ Out of Scope (Spec 2):** Acknowledged; no tasks here touch the advanced flags UI.

Risks called out in the spec are addressed in Task 8's "most likely failure points" list.
