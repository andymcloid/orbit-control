#!/bin/bash
# OrbitControl Kiosk Autostart
# Chromium loads URL directly; OrbitControl controls it via CDP (port 9222).

OC_PORT="${ORBIT_PORT:-80}"

# Wait for OrbitControl server to be ready (max 30s)
echo "[$(date)] Waiting for OrbitControl server (port $OC_PORT)..." >> /home/kiosk/kiosk.log
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${OC_PORT}/api/settings" > /dev/null 2>&1; then
    echo "[$(date)] OrbitControl server is ready" >> /home/kiosk/kiosk.log
    break
  fi
  sleep 1
done

# Read starting URL from OrbitControl
URL=$(curl -sf "http://localhost:${OC_PORT}/api/settings" 2>/dev/null | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
URL="${URL:-https://dietpi.com}"
echo "[$(date)] Starting kiosk with URL: $URL" >> /home/kiosk/kiosk.log

# Kiosk loop — if chromium exits/crashes, it restarts automatically
while true; do
  xinit /bin/sh -c "
    unclutter-xfixes -idle 10 &
    exec chromium-browser \
      --kiosk \
      --start-fullscreen \
      --noerrdialogs \
      --disable-infobars \
      --disable-gpu \
      --disable-software-rasterizer \
      --no-sandbox \
      --remote-debugging-port=9222 \
      '$URL'
  " -- :0 vt1 >> /home/kiosk/kiosk.log 2>&1

  echo "[$(date)] Chromium exited, restarting in 3s..." >> /home/kiosk/kiosk.log
  # Re-read URL in case it changed
  URL=$(curl -sf "http://localhost:${OC_PORT}/api/settings" 2>/dev/null | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
  URL="${URL:-https://dietpi.com}"
  sleep 3
done
