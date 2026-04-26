#!/bin/bash
# OrbitControl Kiosk Autostart
# Chromium loads URL directly; OrbitControl controls it via CDP (port 9222).

OC_PORT="${ORBIT_PORT:-80}"
LOG=/home/kiosk/kiosk.log

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
  # $1 = json, $2 = jq-style key path (limited grep-based extraction)
  echo "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"
}

extract_num() {
  echo "$1" | sed -n "s/.*\"$2\":\\([0-9][0-9]*\\).*/\\1/p"
}

read_kiosk_args() {
  local s url w h
  s=$(fetch_settings)
  url=$(extract "$s" "url"); url="${url:-https://dietpi.com}"
  # Width/height are nested under "resolution"; pull them out of that subtree.
  local res
  res=$(echo "$s" | sed -n 's/.*"resolution":{\([^}]*\)}.*/\1/p')
  w=$(extract_num "$res" "width")
  h=$(extract_num "$res" "height")
  # Sanity: anything below 800x600 likely means stale/bogus data → fall back
  if [ -z "$w" ] || [ -z "$h" ] || [ "$w" -lt 800 ] || [ "$h" -lt 600 ]; then
    w=1920; h=1080
  fi
  KIOSK_URL="$url"
  KIOSK_W="$w"
  KIOSK_H="$h"
}

read_kiosk_args
echo "[$(date)] Starting kiosk: ${KIOSK_W}x${KIOSK_H} URL=$KIOSK_URL" >> "$LOG"

# Kiosk loop — if chromium exits/crashes, it restarts automatically
while true; do
  xinit /bin/sh -c "
    unclutter-xfixes -idle 10 &
    exec chromium-browser \
      --kiosk \
      --start-fullscreen \
      --window-size=${KIOSK_W},${KIOSK_H} \
      --window-position=0,0 \
      --noerrdialogs \
      --disable-infobars \
      --disable-gpu \
      --disable-software-rasterizer \
      --no-sandbox \
      --remote-debugging-port=9222 \
      '$KIOSK_URL'
  " -- :0 vt1 >> "$LOG" 2>&1

  echo "[$(date)] Chromium exited, restarting in 3s..." >> "$LOG"
  read_kiosk_args
  sleep 3
done
