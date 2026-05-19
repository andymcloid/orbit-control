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

extract_num() {
  echo "$1" | sed -n "s/.*\"$2\":\\([0-9][0-9]*\\).*/\\1/p"
}

read_kiosk_args() {
  local target url w h s res
  # Prefer the dedicated plain-text endpoint: "URL\nWIDTHxHEIGHT". This avoids
  # parsing the settings JSON, which now contains multiple "url" keys (the
  # bookmarks array) — the old greedy sed matched a bookmark's url and the
  # kiosk restarted on the wrong page.
  target=$(curl -sf "http://localhost:${OC_PORT}/api/kiosk-target" 2>/dev/null)
  if [ -n "$target" ]; then
    url=$(printf '%s\n' "$target" | sed -n '1p')
    w=$(printf '%s\n' "$target" | sed -n '2p' | sed -n 's/^\([0-9][0-9]*\)x.*/\1/p')
    h=$(printf '%s\n' "$target" | sed -n '2p' | sed -n 's/^[0-9][0-9]*x\([0-9][0-9]*\).*/\1/p')
  else
    # Fallback (server unreachable): the resolution object has no nested "url",
    # so anchoring to the FIRST top-level "url" before the bookmarks array is
    # still safe enough for a degraded path.
    s=$(fetch_settings)
    url=$(echo "$s" | sed -n 's/^{[^}]*\?"url":"\([^"]*\)".*/\1/p')
    res=$(echo "$s" | sed -n 's/.*"resolution":{\([^}]*\)}.*/\1/p')
    w=$(extract_num "$res" "width")
    h=$(extract_num "$res" "height")
  fi
  url="${url:-https://example.com}"
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

  # Let labwc launch chromium itself via its autostart file — the same model
  # `cage -s -- chromium` used. labwc runs autostart ONLY after its Wayland
  # socket is fully up, and chromium inherits the exact WAYLAND_DISPLAY labwc
  # actually bound. The old approach (start labwc backgrounded, poll for the
  # wayland-0 socket *file*, then start chromium with a hardcoded
  # WAYLAND_DISPLAY=wayland-0) raced: on a kiosk restart a stale wayland-0
  # socket from the just-killed previous session still exists, so the file
  # check passes instantly and chromium connects to a dead socket
  # (ECONNREFUSED) — or labwc binds wayland-1 because wayland-0's lock is
  # stale, and chromium on hardcoded wayland-0 never connects. Either way:
  # crash-loop for 20-60s until timing happens to line up. Delegating launch
  # to the compositor removes the race entirely.
  LABWC_HOME="$HOME/.cache/orbit-labwc"
  RT="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  mkdir -p "$LABWC_HOME/labwc"

  # rc.xml: neutralises clicker keystrokes that would otherwise break the kiosk
  # (long-press Enter on the MK118 remote = Alt+F4 = chromium dies; long-press
  # Tab = Alt+Tab = labwc window-cycle). The server renders this from the
  # suppressKeys setting; labwc reads exactly one rc.xml from here and resolves
  # keybinds before the key reaches chromium, so a no-op bind eats the chord.
  # If the server is unreachable, fall back to a hardcoded rc.xml that still
  # blocks the two dangerous chords — never leave the kiosk killable.
  RCXML=$(curl -sf "http://localhost:${OC_PORT}/api/labwc-config" 2>/dev/null)
  if [ -z "$RCXML" ]; then
    RCXML='<?xml version="1.0"?>
<labwc_config><keyboard>
<keybind key="A-F4"><action name="None"/></keybind>
<keybind key="A-Tab"><action name="None"/></keybind>
</keyboard></labwc_config>'
  fi
  printf '%s\n' "$RCXML" > "$LABWC_HOME/labwc/rc.xml"

  # Autostart: run chromium in the foreground; when it exits, SIGTERM labwc
  # (the autostart script's parent) so this foreground `labwc` returns and the
  # loop restarts the whole stack cleanly.
  {
    printf '%s' "/usr/lib/chromium/chromium"
    for _f in "${CHROMIUM_FLAGS[@]}"; do printf ' %q' "$_f"; done
    printf ' %q\n' "$KIOSK_URL"
    echo 'kill "$PPID" 2>/dev/null'
  } > "$LABWC_HOME/labwc/autostart"
  chmod +x "$LABWC_HOME/labwc/autostart"

  # Clear stale wayland sockets/locks from a previously-killed session so
  # labwc consistently binds wayland-0 instead of skipping to wayland-1.
  # Safe here: the previous labwc ran in the foreground below and has already
  # returned, so nothing is using a Wayland socket at this point.
  pgrep -x labwc >/dev/null || rm -f "$RT"/wayland-[0-9] "$RT"/wayland-[0-9].lock 2>/dev/null

  XDG_CONFIG_HOME="$LABWC_HOME" labwc >> "$LOG" 2>&1

  echo "[$(date)] chromium/labwc exited, restarting in 3s..." >> "$LOG"
  sleep 3
done
