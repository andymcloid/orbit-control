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

# Kiosk loop — if chromium/cage exits/crashes, it restarts automatically
while true; do
  read_kiosk_args
  echo "[$(date)] Starting kiosk: ${KIOSK_W}x${KIOSK_H} URL=$KIOSK_URL" >> "$LOG"

  cage -s -- chromium \
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
