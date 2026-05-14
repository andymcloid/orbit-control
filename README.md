# OrbitControl

Web-based kiosk controller for Raspberry Pi (and local development). Navigate URLs, zoom pages, live preview with monitor overlay, click interaction — all remotely via a clean dark-themed control panel.

Built for Raspberry Pi OS Lite (Bookworm) with Chromium kiosk mode under [cage](https://github.com/cage-kiosk/cage). Works on any Linux with Chromium, and includes a cross-platform dev mode for Windows/Mac/Linux.

## Features

- **Remote URL navigation** — Change what the kiosk displays instantly via Chrome DevTools Protocol (CDP)
- **Live preview** — Real-time screenshot stream overlaid on a monitor image, with loading spinner during transitions
- **Click-through interaction** — Click on the preview to interact with the kiosk remotely
- **Page zoom** — Scale content with a slider (25%–300%), applied live via CSS zoom
- **Kiosk restart** — Kill and auto-restart Chromium without rebooting
- **System reboot** — Remote reboot from the control panel
- **System info** — IP, hostname, CPU temp, memory, disk, uptime — all live
- **Persistent settings** — URL and zoom level saved to `settings.json`, survives reboots
- **Auto-reconnect** — CDP connection and WebSocket both reconnect automatically
- **Preview LED toggle** — Click the power button on the monitor overlay to toggle the live stream
- **Smart loading states** — Spinner shown during navigation, reload, restart, and reboot with proper state machine handling
- **Cross-platform dev mode** — `npm run dev` launches a local Chrome + server on any OS
- **Automated production setup** — `npm run setup` installs prerequisites and systemd service on Linux

## Screenshot

The control panel features a fixed left sidebar with all controls and a centered monitor preview:

```
┌──────────┬────────────────────────────────┐
│          │                                │
│ Kiosk URL│       ┌──────────────┐         │
│ [url] Go │       │  ┌────────┐  │         │
│          │       │  │ Live   │  │         │
│ Page Zoom│       │  │Preview │  │         │
│ ──●───── │       │  └────────┘  │         │
│          │       │    Monitor   │         │
│ Actions  │       └──────────────┘         │
│ [Reload] │         ● Connected            │
│ [Restart]│                                │
│ [Reboot] │                                │
│          │                                │
│ Sys Info │                                │
│ IP  ...  │                                │
│ Mem ...  │                                │
└──────────┴────────────────────────────────┘
```

## Architecture

```
┌─────────────────────────────────────────┐
│  Browser on your PC/phone               │
│  http://<pi-ip>/  →  Control Panel      │
└──────────────┬──────────────────────────┘
               │ HTTP + WebSocket
┌──────────────▼──────────────────────────┐
│  OrbitControl Server (Node.js)          │
│  Express + ws                           │
├──────────────┬──────────────────────────┤
│  REST API    │  WebSocket               │
│  /api/*      │  Live status + preview   │
└──────────────┼──────────────────────────┘
               │ CDP (WebSocket :9222)
┌──────────────▼──────────────────────────┐
│  Chromium (kiosk mode, fullscreen)      │
│  --remote-debugging-port=9222           │
└─────────────────────────────────────────┘
```

## Quick Start (Development)

Works on Windows, macOS, and Linux. Requires Node.js 18+ and Chrome/Chromium/Edge installed.

```bash
git clone https://github.com/andymcloid/orbit-control.git
cd orbit-control
npm install
npm run dev
```

This will:
1. Find Chrome/Chromium/Edge on your system (or use `CHROME_PATH` env var)
2. Launch it with `--remote-debugging-port=9222`
3. Start the OrbitControl server on port 3000
4. Open the control panel in your default browser

Press `Ctrl+C` to stop everything.

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
   git clone https://github.com/andymcloid/orbit-control.git orbit-control
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

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `80` (production), `3000` (dev) |
| `ORBIT_DEV` | Dev mode flag (set automatically by `npm run dev`) | - |
| `CHROME_PATH` | Path to Chrome/Chromium binary | Auto-detected |
| `ORBIT_PORT` | Port the kiosk launcher connects to for the initial URL | `80` |

### settings.json

```json
{
  "url": "https://example.com",
  "zoom": 1,
  "resolution": { "width": 1920, "height": 1080 },
  "hideCursorDelay": 10,
  "name": "Orbit"
}
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get current settings |
| POST | `/api/settings` | Update settings |
| GET | `/api/system-info` | System information |
| GET | `/api/status` | Browser connection status + current URL |
| POST | `/api/navigate` | Navigate to URL `{url}` |
| POST | `/api/reload` | Reload current page |
| POST | `/api/zoom` | Set zoom level `{zoom: 1.5}` |
| POST | `/api/click` | Send click at `{x, y}` |
| POST | `/api/restart-kiosk` | Restart Chromium process |
| POST | `/api/reboot` | Reboot the system |

## Files

```
orbit-control/
├── server.js                 # Express + WebSocket server
├── package.json              # Dependencies and scripts (dev, setup, start)
├── settings.json             # Runtime config (git-ignored)
├── settings.example.json     # Example config
├── lib/
│   ├── cdp.js                # Chrome DevTools Protocol client
│   ├── hotkey.js             # evdev listener for Ctrl+Alt+A (kiosk ↔ admin toggle)
│   ├── system.js             # System commands (cross-platform)
│   ├── update.js             # Git-based self-update
│   └── wifi.js               # NetworkManager (nmcli) integration
├── public/
│   ├── index.html            # Control panel (left panel + centered preview)
│   ├── css/style.css         # Dark theme UI
│   ├── js/control.js         # Control panel logic + WebSocket
│   └── img/preview.png       # Monitor frame overlay image
├── scripts/
│   ├── dev.js                # Cross-platform dev launcher
│   └── setup.sh              # Linux/RPi automated setup
├── chromium-autostart.sh     # Kiosk launcher (copied to kiosk user's home by setup.sh)
└── orbit-control.service     # Systemd unit file
```

## How It Works

### Control Panel UI
- **Left panel** — Always-visible sidebar with URL input, zoom slider, action buttons (reload/restart/reboot), and system info table
- **Center stage** — Monitor image (`preview.png`) with the live screenshot overlaid on the screen area, a power LED button to toggle streaming, and a connection status badge

### Preview System
- Screenshots are captured via CDP `Page.captureScreenshot` at 1 fps (JPEG, quality 35)
- Frames are sent to connected WebSocket clients as base64-encoded data
- The power LED on the monitor overlay toggles streaming on/off
- A loading spinner is shown during navigation, reload, restart, and reboot
- **Navigate/Reload**: Spinner until next frame arrives (accelerated by `Page.loadEventFired` listener)
- **Restart/Reboot**: State machine waits for browser disconnect then reconnect cycle before accepting frames

### Dev Mode
- `scripts/dev.js` finds and launches Chrome with CDP enabled
- If Chrome crashes or is restarted via the UI, it auto-relaunches after 2 seconds
- The "Restart kiosk" button sends `Browser.close` via CDP (instead of `systemctl restart`)
- System info shows cross-platform data via Node.js `os` module (CPU temp and disk are Linux-only with N/A fallback)

## License

MIT
