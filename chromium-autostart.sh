#!/bin/bash
# OrbitControl Kiosk Autostart (Pi OS Lite + labwc)
#
# Compositor is labwc, NOT cage: cage on Pi 5 can't give chromium a working
# GL context (chromium's GPU process dies with EGL_BAD_PARAMETER and the whole
# page falls back to software rasterisation — ~45% CPU per core on a static
# page, crash-looping the GPU process dozens of times). Under labwc chromium
# gets hardware V3D (WebGL/canvas/raster all GPU) and the GPU process is
# stable. labwc is launched headless-style; we run chromium ourselves against
# its Wayland socket and tear labwc down when chromium exits, so the restart
# loop behaves exactly like the old `cage -s -- chromium` did.
#
# chromium is invoked as /usr/lib/chromium/chromium (the real binary) instead
# of /usr/bin/chromium (the Pi wrapper) to skip wrapper-injected flags like
# --force-renderer-accessibility (rebuilds the a11y tree on every DOM mutation
# = heavy CPU on dynamic dashboards) and the invalid
# --js-flags=--no-decommit-pooled-pages.
#
# OrbitControl controls chromium via CDP (port 9222).

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
  url=$(extract "$s" "url"); url="${url:-https://example.com}"
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

# Fetch chromium flag list from the server (one flag per line). Falls back to
# the server's /default endpoint if user-edited flags were somehow blanked,
# and to a tiny hardcoded set if the server is unreachable.
read_kiosk_flags() {
  local out
  out=$(curl -sf "http://localhost:${OC_PORT}/api/kiosk-flags" 2>/dev/null)
  if [ -z "$out" ]; then
    out=$(curl -sf "http://localhost:${OC_PORT}/api/kiosk-flags/default" 2>/dev/null)
  fi
  if [ -z "$out" ]; then
    out=$'--ozone-platform=wayland\n--enable-features=UseOzonePlatform,VaapiVideoDecoder\n--kiosk\n--start-fullscreen\n--noerrdialogs\n--disable-infobars\n--disable-popup-blocking\n--no-sandbox\n--remote-debugging-port=9222'
  fi
  # Split on newlines into the global array CHROMIUM_FLAGS, skipping blanks
  # and comment lines (any line starting with #).
  CHROMIUM_FLAGS=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
    esac
    CHROMIUM_FLAGS+=("$line")
  done <<< "$out"
}

# Kiosk loop — if chromium/labwc exits/crashes, it restarts automatically
while true; do
  read_kiosk_args
  read_kiosk_flags
  # --window-size is derived from the saved resolution rather than stored as a
  # flag, so the resolution selector in the UI keeps working as a separate
  # control.
  CHROMIUM_FLAGS+=("--window-size=${KIOSK_W},${KIOSK_H}")
  echo "[$(date)] Starting kiosk: ${KIOSK_W}x${KIOSK_H} URL=$KIOSK_URL flags=${#CHROMIUM_FLAGS[@]}" >> "$LOG"

  # Start labwc as the compositor with an empty autostart (we launch chromium
  # ourselves so we control its lifecycle). Wait for its Wayland socket, run
  # chromium against it, then kill labwc when chromium exits so the loop
  # restarts the whole thing — same lifecycle the old cage line had.
  LABWC_HOME="$HOME/.cache/orbit-labwc"
  mkdir -p "$LABWC_HOME/labwc"
  : > "$LABWC_HOME/labwc/autostart"
  XDG_CONFIG_HOME="$LABWC_HOME" labwc >> "$LOG" 2>&1 &
  LABWC_PID=$!
  RT="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  for _i in $(seq 1 50); do [ -S "$RT/wayland-0" ] && break; sleep 0.2; done
  WAYLAND_DISPLAY=wayland-0 /usr/lib/chromium/chromium "${CHROMIUM_FLAGS[@]}" "$KIOSK_URL" >> "$LOG" 2>&1
  kill "$LABWC_PID" 2>/dev/null; wait "$LABWC_PID" 2>/dev/null

  echo "[$(date)] chromium/labwc exited, restarting in 3s..." >> "$LOG"
  sleep 3
done
