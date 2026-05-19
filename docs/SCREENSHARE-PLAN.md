# Plan: Laptop → Orbit screenshare (toggleable, server-relayed)

> Status: **NOT BUILT** — design approved, deferred. Pick this up later.
> Owner context: requested by Andreas; clicker + bookmark fixes shipped first
> (commit `eddf6bd`). This file is the spec to resume from.

## Goal

From a Mac/Windows laptop on the same (guest) network, toggle a live view of
the laptop screen onto the Orbit display **instead of the configured website**,
controlled from the OrbitControl panel. No software install on the laptop.

## Decisions already made (do not re-litigate)

- **Transport: server-relayed, NOT WebRTC P2P and NOT a TURN/SFU.**
  Laptop captures via browser `getDisplayMedia()`, encodes frames, sends them
  over a dedicated WebSocket to the OrbitControl Node server, which fans them
  out to the kiosk page. Reason: works through guest-net AP-isolation (only
  Orbit's IP/port must be reachable), no heavy media deps on the Pi, no P2P
  negotiation. A real SFU/TURN (mediasoup/Janus/coturn) was rejected as far
  too heavy for this feature.
- **Frame format: WebP/JPEG still-frames over WS, NOT MediaRecorder/WebM video.**
  Rationale: this is screen *sharing* (slides, text, desktop — not film). A
  Pi-5 kiosk Chromium decoding a continuous VP8/WebM stream via MediaSource is
  more fragile (buffer stalls = perceived "lag", Safari codec differences,
  A/V-sync). Swapping a still image at high fps has no GOP/buffer to wait on,
  so it looks sharper and lower-latency for static content at equal bandwidth.
  Aim HIGH on fps/quality (Pi 5 + LAN usually handle it); make both runtime-
  tunable so we can dial it live. Video would only win for moving film, which
  the user explicitly does not want.
- **Audio: out of scope** (video only). Easy to add later if asked.
- **Security: explicitly skipped for now, by the user's call.** Anyone who can
  reach `/share` can put their screen on Orbit. Mark this loudly in code:
  `// SECURITY: unauthenticated by design — revisit before any non-trusted net`.
  Revisit before this is exposed beyond a trusted/temporary setup.

## Architecture

```
Laptop browser (Chrome/Edge/Safari, no install)
  open  http://<orbit>/share
  getDisplayMedia() -> offscreen canvas -> canvas.toBlob(webp|jpeg, q) @ fps
        |
        |  binary frames over  ws://<orbit>/screenshare/ws?role=send
        v
OrbitControl (server.js)  --  screenshareWss (own WebSocketServer noServer)
        |  keep only latest frame, fan out, drop frames to slow receivers
        v
Kiosk chromium  ->  http://localhost/screenshare  (role=recv)
        single <img>/<canvas>, createImageBitmap per frame, fullscreen black
```

Toggle: control panel button -> `POST /api/screenshare/toggle`
  - off→on: `cdp.navigate('http://localhost/screenshare')`
  - on→off: `cdp.navigate(settings.url)`
  - state in memory only (NOT persisted) — a reboot must not strand the kiosk
    on a dead share; existing reconnect logic in server.js (~L661) already
    restores `settings.url` on a blank page.

## Implementation checklist

- [ ] **server.js — WS route.** New `screenshareWss = new WebSocketServer({ noServer:true })`.
      In the existing `server.on('upgrade')` handler (mirrors the `/cdp/*`
      branch, ~server.js:131-145) add a branch for path `/screenshare/ws`.
      Query `?role=send|recv`. Single active sender; a new sender displaces the
      old (notify the old one then close). Latest-frame-only; if a receiver's
      `bufferedAmount` is over a threshold, drop the frame (never queue —
      queuing is what creates lag).
- [ ] **server.js — toggle endpoint + state.** `POST /api/screenshare/toggle`
      flips in-memory `screenshareActive`, navigates chromium accordingly,
      returns `{ active }`. Broadcast new state to control clients over the
      existing control WS (reuse `broadcastJson` / `broadcastStatus`).
- [ ] **public/share.html + public/js/share.js — sender (laptop).**
      "Share screen" button → `getDisplayMedia({video:{frameRate}})`. Draw
      track to an offscreen canvas, `canvas.toBlob` (prefer `image/webp`,
      fall back to `image/jpeg` for Safari) on a fps timer, send binary over
      the WS. Controls: target fps (default ~15, range 5–30), quality slider,
      Stop. Show connection state + a tiny self-preview. Reconnect WS on drop.
- [ ] **public/screenshare.html + public/js/screenshare.js — receiver (kiosk).**
      Fullscreen black page. Per incoming blob: `createImageBitmap` →
      draw to a `<canvas>` sized to viewport (object-fit: contain). Idle
      state "Waiting for a screen…" when no frames for N seconds.
- [ ] **public/index.html + public/js/control.js — control toggle.**
      Button (near existing nav/reload controls) calling the toggle endpoint;
      reflect live `screenshareActive` from the control WS broadcast so all
      open panels stay in sync. Toast on toggle.
- [ ] **public/css/style.css** — styles for the share/receiver/idle UI.
- [ ] **Tune & verify** on real hardware: fps/quality ceiling on Pi 5 + the
      actual network; confirm it survives guest-net AP-isolation; confirm the
      kiosk returns cleanly to `settings.url` on toggle-off and on reboot.

## Gotchas / notes for whoever resumes

- `getDisplayMedia()` requires a **secure context** (https) OR `http://localhost`.
  Over plain `http://<orbit-ip>/share` Chrome blocks screen capture. Options to
  resolve when building: serve the panel over https (self-signed +
  trust, or the existing cloudflared tunnel), or document that the laptop must
  use the tunnel URL for `/share`. **This is the #1 thing to settle first.**
- WS upgrade routing already has precedent for non-default paths — copy the
  `/cdp/devtools/*` pattern exactly so we don't swallow control-panel sockets.
- Keep frame fan-out latest-only. The instant you queue frames per client you
  reintroduce the "lag" the user explicitly does not want.
- Don't persist screenshare state to settings.json.
- Independent of the clicker/bookmark work — no overlap with commit `eddf6bd`.
