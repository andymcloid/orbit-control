# Kiosk Stack Migration: DietPi Kiosk → Pi OS Lite + cage

**Date:** 2026-05-15
**Status:** Approved for implementation
**Scope:** Migrate OrbitControl's kiosk runtime from DietPi Kiosk (xinit + X11 + xbindkeys + unclutter) to Raspberry Pi OS Lite 64-bit (Bookworm) with cage as the Wayland kiosk compositor. Clean break — no DietPi compatibility retained.

## Background

OrbitControl currently assumes a DietPi Kiosk base image, which provides xinit, X11, xbindkeys, and unclutter-xfixes preinstalled and wires up autologin + chromium autostart out of the box. We are switching to a vanilla Raspberry Pi OS Lite 64-bit install because:

- DietPi Kiosk is an extra abstraction layer we don't control
- Wayland on Bookworm gives better GPU acceleration on Pi out of the box (V3D driver)
- Pi OS Lite is the more "standard" base — easier to reason about, easier to support
- The user is wiping the SD card right now, so backwards compatibility has zero value

The terminal user experience after this spec is implemented:

```
1. Flash Pi OS Lite 64-bit via Raspberry Pi Imager (sets user/wifi/ssh)
2. ssh in, install chromium+cage manually OR let setup.sh do it
3. git clone <repo> && cd orbit-control
4. sudo bash scripts/setup.sh
5. sudo reboot
6. Kiosk shows the configured URL
```

## Architecture

```
Pi OS Lite 64-bit (Bookworm)
└── systemd autologin on tty1 (kiosk-user)
    └── ~/.bash_profile (created by setup.sh)
        └── ~/chromium-autostart.sh (copied by setup.sh)
            └── while-loop: cage -s -- chromium-browser --ozone-platform=wayland ...

orbit-control.service (systemd, runs as root for port 80)
└── node server.js
    ├── REST/WS endpoints (unchanged)
    ├── lib/wifi.js (rewritten against nmcli, same exports)
    └── lib/hotkey.js (NEW: evdev listener → admin-toggle)
```

**Unchanged:** `settings.json` schema, all API endpoints, the entire frontend (`control.js`, `index.html`, `style.css`), CDP code, update mechanism.

## Files Changed

| File | Change type | Summary |
|---|---|---|
| `scripts/setup.sh` | Rewritten | Pi OS Lite package list, Node.js install, tty1 autologin override, `.bash_profile` generation, input-group membership |
| `chromium-autostart.sh` | Rewritten inner loop | cage replaces xinit; drop xrandr/unclutter/xbindkeys; add Wayland flags |
| `lib/wifi.js` | Full rewrite | nmcli-based, same public API (`getStatus`, `listSaved`, `scan`, `connect`, `forget`) |
| `lib/hotkey.js` | New | evdev listener for Ctrl+Alt+A → triggers admin-toggle |
| `server.js` | Small additions | Extract `toggleAdminPanel()` helper, wire `hotkey.start()` at startup |
| `package.json` | New dep | `evdev` (or equivalent npm package for reading /dev/input) |
| `README.md` | Rewritten install section | New Pi OS Lite instructions |
| `lib/system.js` | Verified | `restartKiosk()` uses getty@tty1 chain — keep, verify on new stack |

## Section 1: setup.sh

`scripts/setup.sh` is rewritten to handle a clean Raspberry Pi OS Lite 64-bit (Bookworm) install end-to-end.

### Package list

Install (apt) if missing:
- `chromium-browser` — kiosk browser
- `cage` — Wayland kiosk compositor
- `network-manager` — sanity check (default on Bookworm Lite, but verify)
- `curl` — used by setup + Node bootstrap

Removed from prior list: `xinit`, `xbindkeys`, `unclutter-xfixes`.

Note: User may already have `chromium`, `cage`, `mpv` installed manually. Setup must be idempotent — re-check before installing. `mpv` is not installed by setup.sh (not needed by OrbitControl).

### Node.js install (new)

If `node --version` is missing or major version < 18:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```
Skipped if Node 18+ already present.

### User detection

`KIOSK_USER="${SUDO_USER:-pi}"` — same `$SUDO_USER` auto-detection as today. Default fallback changed from `kiosk` to `pi` since that's the Pi OS Imager default. Works for any username the user picked at first boot.

### tty1 autologin override (new)

Write `/etc/systemd/system/getty@tty1.service.d/override.conf`:
```ini
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin <KIOSK_USER> --noclear %I $TERM
```

Then `systemctl daemon-reload` (and `systemctl restart getty@tty1` only if not on tty1 ourselves — avoid kicking ourselves off).

### .bash_profile (new)

Write to `~<KIOSK_USER>/.bash_profile`:
```bash
# OrbitControl: auto-start kiosk on tty1, not over SSH
if [ "$(tty)" = "/dev/tty1" ] && [ -z "$XDG_RUNTIME_DIR" ] && [ -x ~/chromium-autostart.sh ]; then
  exec ~/chromium-autostart.sh
fi
```

The `XDG_RUNTIME_DIR` check prevents double-launch if cage is already running.

If `.bash_profile` already exists, append the guard only if it's not already present (grep for a unique marker comment).

### Input group (new)

`usermod -aG input "$KIOSK_USER"` — required so `lib/hotkey.js` can open `/dev/input/event*` without udev rules.

### chromium-autostart.sh copy

Same as today (line 121-124): copy script to `~<KIOSK_USER>/chromium-autostart.sh`, chmod +x, chown.

### systemd service

Same content as today's setup.sh lines 86-102 — `orbit-control.service` runs as root, `Restart=always`, `WantedBy=multi-user.target`.

### Idempotence

The full script must be safely re-runnable. Each step checks current state first:
- Package install: dpkg query before apt
- Node install: version check before NodeSource
- Autologin override: check file content matches before writing
- `.bash_profile`: append-only with marker check
- `usermod -aG`: only if user not already in group

## Section 2: chromium-autostart.sh

### What stays

- Top-level `OC_PORT` env + `LOG` setup
- `Wait for OrbitControl server` loop (line 8-16)
- `fetch_settings`, `extract`, `extract_num`, `read_kiosk_args` functions (line 19-48)
- The outer `while true; do … sleep 3; done` restart-on-crash loop (line 67-99)

### What's rewritten

The inner xinit invocation (line 69-94) becomes:

```bash
exec cage -s -- chromium-browser \
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
  "$KIOSK_URL"
```

### What's removed

- `unclutter-xfixes -idle 10 &` — cage handles cursor hiding via its own input timeout
- `xbindkeys` + the `XBINDKEYS_CONF` self-heal block (line 53-65) — replaced by `lib/hotkey.js` on the server side
- `xrandr` mode-switching (line 77-78) — cage uses HDMI EDID native mode; userland mode-switching not applicable

### Resolution behavior

cage takes the HDMI output's native resolution from EDID/firmware. The `settings.resolution` (width/height) flows into `--window-size`, which:
- Sets chromium's internal viewport dimensions
- Does NOT change physical display resolution (cage forces fullscreen)

In practice this means: physical resolution = HDMI native; chromium reports `settings.resolution` to webpages. The Display Resolution dropdown in the UI keeps working but its physical effect is limited to chromium's reported viewport, not the X-style mode switching it provided before. Out of scope to redesign this UI in Spec 1; revisit if it causes confusion in practice.

## Section 3: lib/wifi.js

Full rewrite against `nmcli`. Public API unchanged:
```js
module.exports = { getStatus, listSaved, scan, connect, forget };
```

Frontend (`control.js`, the WiFi modal in `index.html`) is not modified.

### Command mapping

| Function | New nmcli command(s) |
|---|---|
| `getStatus` | `nmcli -t -f NAME,TYPE,DEVICE connection show --active` (filter type=802-11-wireless) + `nmcli -t -f IP4.ADDRESS device show <iface>` |
| `listSaved` | `nmcli -t -f NAME,TYPE connection show` (filter type=802-11-wireless) |
| `scan` | `nmcli -t -f SSID,SIGNAL,SECURITY,FREQ device wifi list --rescan yes` |
| `connect` | `nmcli device wifi connect "<ssid>" password "<pwd>"` for new; `nmcli connection up "<name>"` for already-saved with no password change |
| `forget` | `nmcli connection delete "<name>"` |

### Parsing

Use `-t` (terse) flag for colon-separated output, robust to spaces. SSID values containing `:` are escaped by nmcli with `\:`; unescape on parse.

### Quality score

nmcli's SIGNAL column is already 0-100, so `dbmToQuality()` is dropped. The frontend already accepts a `quality` field; we just pass through SIGNAL directly.

### Dev-mode

Same approach as today: `isLinux === false || isDevMode` returns fake data so dev on Windows/Mac works unchanged.

### Timeouts

Bump connect timeout to 30s (nmcli's `device wifi connect` can take 10-30s on first connect). Other operations stay at 5-10s.

### Iface detection

Today: hardcoded `wlan0` with `ORBIT_WIFI_IFACE` override. Keep this behavior — nmcli auto-detects which device to use for `device wifi list`/`connect`, but explicit `ifname <iface>` is added to commands for predictability.

## Section 4: lib/hotkey.js (new)

Listens for Ctrl+Alt+A on any connected keyboard, triggers admin-toggle.

### Module shape

```js
module.exports = { start };

function start(onTrigger) {
  // onTrigger called with no args when Ctrl+Alt+A pressed
}
```

### Dependency

Use the `evdev` npm package (or equivalent: `node-evdev`, or a small `~40-line` raw `fs.read` implementation if neither works on arm64). Decision deferred to plan-time: try `evdev` first, fall back if it doesn't build/run on Pi.

### Behavior

1. On `start(cb)`:
   - Scan `/dev/input/event*` for devices with EV_KEY capability
   - Open each as a keyboard input source
2. Track Ctrl + Alt modifier state per-device
3. On A keydown with both modifiers held: call `cb()` (debounced ~500ms to avoid double-fires on key-repeat)
4. Hot-plug: `fs.watch('/dev/input')` re-scans on directory changes

### Error handling

- Wrap everything in try/catch — never crash the server
- If permission denied on a device, log warning, continue with others
- If no keyboards found at startup: log info, keep watcher running for hot-plug
- If `ORBIT_DEV=1` or `os.platform() !== 'linux'`: `start()` is a no-op

### Integration in server.js

Extract `/api/admin-toggle` body into a `toggleAdminPanel()` function:

```js
async function toggleAdminPanel() {
  const settings = readSettings();
  const port = parseInt(process.env.PORT, 10) || 80;
  const adminUrl = 'http://localhost' + (port === 80 ? '' : ':' + port) + '/';
  let currentUrl = '';
  try { currentUrl = (await cdp.getCurrentUrl()) || ''; } catch {}
  const isOnAdmin = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(currentUrl);
  const target = isOnAdmin ? (settings.url || 'https://example.com') : adminUrl;
  await cdp.navigate(target);
  return { target, was: currentUrl };
}
```

Both the endpoint and the hotkey listener call this helper.

After `server.listen()`:
```js
const hotkey = require('./lib/hotkey');
hotkey.start(() => {
  toggleAdminPanel().catch((err) => console.warn('hotkey toggle failed:', err.message));
});
```

### Permissions

Kiosk user is added to the `input` group by setup.sh. The orbit-control.service runs as root anyway, so it has full access regardless — but the input-group setup is for when/if we ever de-privilege the service.

## Out of Scope (deferred to Spec 2)

- Advanced Chromium flags UI in OrbitControl panel
- Persisting custom flags to `settings.json`
- Letting `chromium-autostart.sh` read a flags array from settings

These are independent and orthogonal to Spec 1. Spec 2 builds on the new stack but doesn't require changes to the migration work.

## Testing Strategy

### What can be tested on dev (Windows/Mac)

- `lib/wifi.js` dev-mode paths (ORBIT_DEV=1 returns fake data)
- `lib/hotkey.js` no-op skip on non-Linux platforms
- `server.js` extraction of `toggleAdminPanel()` (existing endpoint still works)
- JSON parsing in chromium-autostart.sh (manual run against running server)

### What requires the Pi

- `setup.sh` full run on clean Pi OS Lite 64-bit
- cage + chromium launch with all flags
- Wayland-mode chromium connectivity via CDP on port 9222
- nmcli scan/connect/forget against real WiFi networks
- Ctrl+Alt+A hotkey with a real USB keyboard
- Autologin chain: power on → tty1 login → bash_profile → autostart → cage → chromium → URL loaded
- `systemctl restart orbit-control` from within the panel doesn't kill the kiosk (CDP reconnects)
- chrome://gpu in the kiosk reports hardware acceleration

### Manual smoke test on Pi after install

1. `sudo reboot`
2. Kiosk shows configured URL within ~30s
3. From laptop: `http://<pi-ip>/` shows control panel
4. Click Reload, see kiosk reload
5. Connect USB keyboard, press Ctrl+Alt+A — kiosk shows admin panel
6. Press Ctrl+Alt+A again — kiosk returns to configured URL
7. Manage WiFi → Scan, see networks; connect to a test SSID
8. Restart Kiosk button — kiosk restarts cleanly
9. Reboot button — system reboots and comes back up showing kiosk

## Risks & Open Questions

- **evdev npm package may not build on arm64**: Mitigation: have a raw-fs.read fallback prototype ready during implementation. If both fail, drop hotkey from Spec 1 and revisit.
- **Bookworm Lite default network stack**: Spec assumes NetworkManager is default; setup.sh sanity-checks and installs if missing. If Bookworm Lite ever switches back to dhcpcd, this assumption breaks — caught by the install step.
- **cage's cursor-hiding behavior**: cage hides cursor on input idle, but the exact behavior may differ from unclutter-xfixes. Verify visually on Pi. Acceptable risk — UX delta is minor.
- **`systemctl restart orbit-control` from the panel**: orbit-control.service exits → CDP connection drops on the kiosk side. The kiosk's chromium stays alive (running under cage, not under orbit-control). When orbit-control comes back, CDP reconnects automatically. Verify this chain works as expected.
- **Display Resolution dropdown semantics shift**: Document in README that under cage, "resolution" affects chromium's reported viewport only, not physical output. Don't redesign the UI in Spec 1.
