# OrbitControl

Web-based kiosk controller for Raspberry Pi (and local development). Navigate URLs, zoom pages, live preview with monitor overlay, click interaction — all remotely via a clean dark-themed control panel.

Built for [DietPi](https://dietpi.com/) with Chromium kiosk mode. Works on any Linux with Chromium, and includes a cross-platform dev mode for Windows/Mac/Linux.

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

## Production Setup (Raspberry Pi / Linux)

```bash
git clone https://github.com/andymcloid/orbit-control.git /opt/orbit-control
cd /opt/orbit-control
sudo npm run setup
```

The setup script will:
1. Check and install prerequisites (Node.js 18+, Chromium, unclutter-xfixes, xinit, curl)
2. Run `npm install --production`
3. Create `settings.json` from example if missing
4. Generate and install a systemd service
5. Enable and start the service
6. Copy `chromium-autostart.sh` to the kiosk user's home

The control panel will be available on port 80.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `80` (production), `3000` (dev) |
| `ORBIT_DEV` | Dev mode flag (set automatically by `npm run dev`) | - |
| `CHROME_PATH` | Path to Chrome/Chromium binary | Auto-detected |
| `ORBIT_PORT` | Port for chromium-autostart.sh to connect to | `80` |

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
│   └── system.js             # System commands (cross-platform)
├── public/
│   ├── index.html            # Control panel (left panel + centered preview)
│   ├── css/style.css         # Dark theme UI
│   ├── js/control.js         # Control panel logic + WebSocket
│   └── img/preview.png       # Monitor frame overlay image
├── scripts/
│   ├── dev.js                # Cross-platform dev launcher
│   └── setup.sh              # Linux/RPi automated setup
├── orbit-control.service     # Systemd unit file
└── chromium-autostart.sh     # Reference kiosk autostart script
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
