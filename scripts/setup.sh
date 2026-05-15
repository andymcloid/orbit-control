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
for pkg in chromium cage network-manager curl; do
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

# --- Ensure NetworkManager is the active network manager ---
# Pi OS Lite Bookworm ships with dhcpcd as the default; we need NM running
# so `nmcli` (used by lib/wifi.js) actually sees wlan0 as a managed device.

if ! systemctl is-active --quiet NetworkManager; then
  info "Enabling NetworkManager..."
  systemctl enable --now NetworkManager
fi

if systemctl is-enabled --quiet dhcpcd 2>/dev/null; then
  info "Disabling dhcpcd (NetworkManager takes over)..."
  systemctl disable --now dhcpcd
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
