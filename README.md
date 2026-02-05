# OrbitControl

Web-based kiosk controller for Raspberry Pi. Navigate URLs, zoom pages, live preview, click interaction — all remotely via a clean dark-themed control panel.

Built for [DietPi](https://dietpi.com/) with Chromium kiosk mode.

## Features

- **Remote URL navigation** — Change what the kiosk displays, instantly via Chrome DevTools Protocol (CDP)
- **Live preview** — Real-time screenshot stream of the kiosk screen, right in the control panel
- **Click-through interaction** — Click on the preview to interact with the kiosk remotely
- **Page zoom** — Scale content up/down with a slider (25%–300%), applied live via CSS zoom
- **Kiosk restart** — Kill and auto-restart Chromium without rebooting
- **System reboot** — Remote reboot from the control panel
- **System info** — IP, hostname, CPU temp, memory, disk, uptime — all live
- **Persistent settings** — URL, zoom level saved to `settings.json`, survives reboots
- **Auto-reconnect** — CDP connection and WebSocket both reconnect automatically

## Architecture

```
┌─────────────────────────────────────────┐
│  Browser on your PC/phone               │
│  http://<pi-ip>/  →  Control Panel      │
└──────────────┬──────────────────────────┘
               │ HTTP + WebSocket
┌──────────────▼──────────────────────────┐
│  OrbitControl Server (Node.js, port 80) │
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

## Requirements

- Raspberry Pi running DietPi (tested on Pi 3B+)
- Node.js 18+
- Chromium (installed via `dietpi-software`)
- DietPi autostart mode 11 (Chromium kiosk)

## Installation

```bash
# Clone to /opt
sudo git clone https://github.com/andymcloid/orbit-control.git /opt/orbit-control
cd /opt/orbit-control

# Install dependencies
npm install

# Copy example config
cp settings.example.json settings.json

# Create systemd service
sudo cp orbit-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orbit-control
sudo systemctl start orbit-control
```

Then update your Chromium autostart script to:
1. Wait for OrbitControl to be ready
2. Launch Chromium with `--remote-debugging-port=9222`
3. Load the URL from OrbitControl's API

See `chromium-autostart.sh` for a reference implementation.

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
| POST | `/api/reboot` | Reboot the Pi |

## Files

```
orbit-control/
├── server.js                 # Express + WebSocket server
├── settings.json             # Runtime config (git-ignored)
├── settings.example.json     # Example config
├── lib/
│   ├── cdp.js                # Chrome DevTools Protocol client
│   └── system.js             # System commands (reboot, info)
├── public/
│   ├── index.html            # Control panel
│   ├── kiosk.html            # Legacy kiosk iframe page
│   ├── css/style.css         # Dark theme UI
│   └── js/
│       ├── control.js        # Control panel logic
│       └── kiosk.js          # Legacy kiosk logic
├── orbit-control.service     # Systemd unit file
└── chromium-autostart.sh     # Reference kiosk autostart script
```

## License

MIT
