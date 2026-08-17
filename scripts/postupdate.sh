#!/bin/bash
set -e

# Idempotent system-level provisioning — safe (and cheap) to run on every
# deploy. Called from BOTH:
#   - scripts/setup.sh   (first install over SSH)
#   - lib/update.js      ("Update from Git" in the panel)
# The update path matters: deployed kiosks are often unreachable over SSH
# (venue networks, no tunnel), so any NEW system dependency a version needs
# must be installable through the panel's update button alone. Add future
# apt packages to the list below and they reach every device on its next
# panel update — no shell access needed.
#
# Every step must be:
#   - root-safe and idempotent
#   - a fast no-op when already applied (this runs on every update)
#   - non-interactive (no prompts — it runs from a web request)

if [[ $EUID -ne 0 ]]; then
  echo "[postupdate] must run as root" >&2
  exit 1
fi

# --- Required system packages ---
# pipewire/pipewire-pulse/wireplumber: audio-output switching (lib/audio.js).
#   Pi OS Lite has no sound server; chromium is a pulse client and follows
#   the PipeWire default sink once these are installed (needs one reboot).
# fonts-noto*: emoji/CJK glyphs on dashboards (tofu boxes otherwise).
PACKAGES=(chromium labwc network-manager curl
          pipewire pipewire-pulse wireplumber
          fonts-noto fonts-noto-color-emoji fonts-noto-extra)

MISSING=()
for pkg in "${PACKAGES[@]}"; do
  if ! dpkg -s "$pkg" 2>/dev/null | grep -q '^Status: .* installed'; then
    MISSING+=("$pkg")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "[postupdate] Installing missing packages: ${MISSING[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
  # Rebuild the font cache so chromium picks up newly-installed fonts without
  # a reboot (no-op if nothing font-related changed).
  fc-cache -f >/dev/null 2>&1 || true
  echo "[postupdate] Packages installed."
else
  echo "[postupdate] All system packages present."
fi

# --- PipeWire user services ---
# They run inside the kiosk user's login session (systemd --user starts them
# on the tty1 autologin). Debian's user presets normally enable these already;
# --global makes it explicit and covers images where presets were trimmed.
systemctl --global enable pipewire.socket pipewire-pulse.socket wireplumber.service 2>/dev/null || true

# --- Strip forced accessibility flag from the Pi chromium wrapper ---
# /etc/chromium.d/00-rpi-vars force-adds --force-renderer-accessibility, which
# rebuilds the a11y tree on every DOM mutation (heavy CPU on dynamic pages).
# We bypass the wrapper in chromium-autostart.sh anyway, but keep any chromium
# launch on the box clean. Package updates can restore the flag, so re-check
# on every deploy.
RPI_VARS="/etc/chromium.d/00-rpi-vars"
if [[ -f "$RPI_VARS" ]] && grep -q -- '--force-renderer-accessibility' "$RPI_VARS"; then
  echo "[postupdate] Stripping --force-renderer-accessibility from $RPI_VARS"
  sed -i 's/ --force-renderer-accessibility//g' "$RPI_VARS"
fi

echo "[postupdate] Done."
