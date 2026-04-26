#!/bin/bash
set -e

# OrbitControl Production Setup Script
# Run with: sudo npm run setup

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $1"; }
error() { echo -e "${RED}[setup]${NC} $1"; exit 1; }

# --- Pre-flight checks ---

if [[ "$(uname)" != "Linux" ]]; then
  error "This setup script is for Linux only. Use 'npm run dev' for development on Windows/Mac."
fi

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root. Try: sudo npm run setup"
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(which node 2>/dev/null || echo '')"

if [[ -z "$NODE_BIN" ]]; then
  error "Node.js not found in PATH. Install Node.js 18+ first."
fi

NODE_VERSION=$($NODE_BIN --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  error "Node.js 18+ required (found $($NODE_BIN --version))"
fi

info "Install directory: $INSTALL_DIR"
info "Node binary: $NODE_BIN"

# --- Install system prerequisites ---

info "Checking system prerequisites..."

PACKAGES_TO_INSTALL=()

for pkg in chromium-browser unclutter-xfixes xinit curl xbindkeys; do
  if ! command -v "$pkg" &>/dev/null && ! dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
    PACKAGES_TO_INSTALL+=("$pkg")
  fi
done

if [[ ${#PACKAGES_TO_INSTALL[@]} -gt 0 ]]; then
  info "Installing missing packages: ${PACKAGES_TO_INSTALL[*]}"
  apt-get update -qq
  apt-get install -y -qq "${PACKAGES_TO_INSTALL[@]}"
else
  info "All system prerequisites are installed."
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
else
  info "settings.json already exists, skipping."
fi

# --- Generate and install systemd service ---

SERVICE_FILE="/etc/systemd/system/orbit-control.service"
info "Generating systemd service file..."

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

info "Service file written to $SERVICE_FILE"

# --- Enable and start service ---

systemctl daemon-reload
systemctl enable orbit-control
systemctl restart orbit-control

info "orbit-control service enabled and started."

# --- Chromium autostart setup ---

info "Setting up Chromium kiosk autostart..."

KIOSK_USER="${SUDO_USER:-kiosk}"
KIOSK_HOME=$(eval echo "~$KIOSK_USER")

AUTOSTART_DEST="$KIOSK_HOME/chromium-autostart.sh"
cp "$INSTALL_DIR/chromium-autostart.sh" "$AUTOSTART_DEST"
chmod +x "$AUTOSTART_DEST"
chown "$KIOSK_USER:$KIOSK_USER" "$AUTOSTART_DEST" 2>/dev/null || true

info "Autostart script copied to $AUTOSTART_DEST"

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
