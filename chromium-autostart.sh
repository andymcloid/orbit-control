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

# Kiosk loop — if chromium/cage exits/crashes, it restarts automatically
while true; do
  read_kiosk_args
  read_kiosk_flags
  # --window-size is derived from the saved resolution rather than stored as a
  # flag, so the resolution selector in the UI keeps working as a separate
  # control.
  CHROMIUM_FLAGS+=("--window-size=${KIOSK_W},${KIOSK_H}")
  echo "[$(date)] Starting kiosk: ${KIOSK_W}x${KIOSK_H} URL=$KIOSK_URL flags=${#CHROMIUM_FLAGS[@]}" >> "$LOG"

  cage -s -- chromium "${CHROMIUM_FLAGS[@]}" "$KIOSK_URL" >> "$LOG" 2>&1

  echo "[$(date)] cage/chromium exited, restarting in 3s..." >> "$LOG"
  sleep 3
done
