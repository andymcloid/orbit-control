(function () {
  const urlInput = document.getElementById('url-input');
  const btnNavigate = document.getElementById('btn-navigate');
  const bookmarkList = document.getElementById('bookmark-list');
  const bookmarkName = document.getElementById('bookmark-name');
  const bookmarkUrl = document.getElementById('bookmark-url');
  const btnBookmarkAdd = document.getElementById('btn-bookmark-add');
  const btnReload = document.getElementById('btn-reload');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const btnRestart = document.getElementById('btn-restart');
  const btnReboot = document.getElementById('btn-reboot');
  const btnUpdate = document.getElementById('btn-update');
  const btnUpdateClose = document.getElementById('btn-update-close');
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomValue = document.getElementById('zoom-value');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const fpsPreset = document.getElementById('fps-preset');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const sysInfo = document.getElementById('sys-info');
  const toastEl = document.getElementById('toast');
  const previewImg = document.getElementById('preview-img');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const drawer = document.getElementById('drawer');
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  const triggerBtn = document.getElementById('trigger-btn');
  const drawerClose = document.getElementById('drawer-close');
  const displayPreset = document.getElementById('display-preset');
  const displayCustom = document.getElementById('display-custom');
  const displayW = document.getElementById('display-w');
  const displayH = document.getElementById('display-h');
  const btnDisplayApply = document.getElementById('btn-display-apply');
  const displayHint = document.getElementById('display-hint');
  const netDot = document.getElementById('net-dot');
  const netSsid = document.getElementById('net-ssid');
  const btnNetManage = document.getElementById('btn-net-manage');
  const wifiModal = document.getElementById('wifi-modal');
  const btnWifiClose = document.getElementById('btn-wifi-close');
  const btnWifiScan = document.getElementById('btn-wifi-scan');
  const wifiList = document.getElementById('wifi-list');
  const wifiSaved = document.getElementById('wifi-saved');
  const wifiHint = document.getElementById('wifi-hint');
  const wifiModalDot = document.getElementById('wifi-modal-dot');
  const wifiModalSsid = document.getElementById('wifi-modal-ssid');
  const wifiConnectModal = document.getElementById('wifi-connect-modal');
  const wifiConnectTitle = document.getElementById('wifi-connect-title');
  const wifiPassword = document.getElementById('wifi-password');
  const btnWifiConnectSubmit = document.getElementById('btn-wifi-connect-submit');
  const btnWifiConnectCancel = document.getElementById('btn-wifi-connect-cancel');
  const wifiConnectMsg = document.getElementById('wifi-connect-msg');
  const btnAdvanced = document.getElementById('btn-advanced');
  const advancedModal = document.getElementById('advanced-modal');
  const advancedFlags = document.getElementById('advanced-flags');
  const advancedMsg = document.getElementById('advanced-msg');
  const advancedRemoteDebug = document.getElementById('advanced-remote-debug');
  const advancedRemoteInfo = document.getElementById('advanced-remote-info');
  const advancedSuppress = document.getElementById('advanced-suppress');
  const btnAdvancedCancel = document.getElementById('btn-advanced-cancel');
  const btnAdvancedReset = document.getElementById('btn-advanced-reset');
  const btnAdvancedSave = document.getElementById('btn-advanced-save');
  const updateModal = document.getElementById('update-modal');
  const updateTitle = document.getElementById('update-title');
  const updateStepText = document.getElementById('update-step-text');
  const updateOutput = document.getElementById('update-output');
  const updateStatusRow = document.getElementById('update-status-row');
  const updateSubstatus = document.getElementById('update-substatus');
  let ws;
  let toastTimer;
  let zoomTimer;
  let backdropHideTimer;
  let updating = false;

  // Per-client preview rate — saved locally because it's a viewer preference,
  // not anything about the kiosk. Server tracks each client's wanted rate and
  // uses the max across connected clients.
  const FPS_STORAGE_KEY = 'orbit.previewFps';
  function readLocalFps() {
    const v = parseInt(localStorage.getItem(FPS_STORAGE_KEY) || '1', 10);
    return Math.max(1, Math.min(30, isNaN(v) ? 1 : v));
  }
  function writeLocalFps(fps) {
    try { localStorage.setItem(FPS_STORAGE_KEY, String(fps)); } catch {}
  }
  // State: null = normal, 'wait-disconnect' = action fired, waiting for browser to go offline,
  //        'wait-reconnect' = browser went offline, waiting for it to come back
  let waitingForReconnect = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  // Show the <img> the moment the MJPEG stream produces its first frame, and
  // keep the placeholder spinner hidden after that — even if subsequent
  // multipart parts trigger more `load` events, they're no-ops.
  previewImg.addEventListener('load', () => {
    if (previewImg.style.display !== 'block') previewImg.style.display = 'block';
    if (previewPlaceholder.style.display !== 'none') previewPlaceholder.style.display = 'none';
  });

  // If the MJPEG stream stalls (server restart, network blip, chromium
  // disconnect+reconnect), the browser leaves the last frame on screen and
  // never re-requests. Force a fresh load by reassigning src with a cache
  // buster after a few seconds of no `load` events. This is the standard
  // pattern for keeping IP-camera MJPEG embeds alive.
  let lastFrameAt = Date.now();
  previewImg.addEventListener('load', () => { lastFrameAt = Date.now(); });
  setInterval(() => {
    if (Date.now() - lastFrameAt > 8000) {
      previewImg.src = '/preview.mjpeg?t=' + Date.now();
      lastFrameAt = Date.now();
    }
  }, 3000);

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'preview-start', fps: readLocalFps() }));
      // If we were mid-update when the connection dropped, the server has now
      // come back up with the new code → close the modal.
      if (updating) {
        updating = false;
        appendUpdateLine('ok', '✓ Server is back online with new code.');
        updateTitle.textContent = 'Update complete';
        updateSubstatus.textContent = 'Connected';
        updateStatusRow.classList.remove('bad');
        updateStatusRow.classList.add('ok');
        const spinner = updateStatusRow.querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';
        btnUpdateClose.hidden = false;
        // Server pushes fresh system-info on every WS connect, so the next
        // automatic push will refresh the table — no explicit fetch here.
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'status') {
        updateStatus(msg);
      } else if (msg.type === 'system-info') {
        renderSystemInfo(msg.info);
      } else if (msg.type === 'wifi-status') {
        renderWifiStatus(msg.status, msg.saved);
      } else if (msg.type === 'update-output') {
        appendUpdateLine(msg.stream === 'stderr' ? 'err' : 'std', msg.line);
      } else if (msg.type === 'update-step') {
        updateStepText.textContent = msg.step;
        updateSubstatus.textContent = msg.step;
        appendUpdateLine('ok', '➜ ' + msg.step);
      } else if (msg.type === 'update-status') {
        if (msg.status === 'restarting') {
          updateTitle.textContent = 'Restarting server...';
          updateSubstatus.textContent = 'Waiting for server to come back online';
          appendUpdateLine('ok', '↻ Restarting orbit-control service...');
        } else if (msg.status === 'error') {
          showUpdateError(msg.error);
        }
      }
    };

    ws.onclose = () => {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Server disconnected';
      setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }

  function wsSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function updateStatus(msg) {
    statusDot.className = 'status-dot' + (msg.browser_connected ? ' online' : '');
    statusText.textContent = msg.browser_connected ? 'Browser connected' : 'Browser offline';
    if (msg.settings) {
      urlInput.value = msg.settings.url || '';
      const z = Math.round((msg.settings.zoom || 1) * 100);
      zoomSlider.value = z;
      zoomValue.textContent = z + '%';
      if (Array.isArray(msg.settings.bookmarks)) renderBookmarks(msg.settings.bookmarks);
    }
    // State machine: wait for disconnect then reconnect
    if (waitingForReconnect === 'wait-disconnect' && !msg.browser_connected) {
      waitingForReconnect = 'wait-reconnect';
    } else if (waitingForReconnect === 'wait-reconnect' && msg.browser_connected) {
      waitingForReconnect = null;
    }
  }

  function showPreviewLoader(awaitReconnect) {
    previewImg.style.display = 'none';
    previewPlaceholder.style.display = 'flex';
    // Force the MJPEG stream to reconnect when the underlying chromium is
    // restarted — otherwise the browser sits on the dead connection.
    previewImg.src = '/preview.mjpeg?t=' + Date.now();
    if (awaitReconnect) waitingForReconnect = 'wait-disconnect';
  }

  // -- Drawer --
  function openDrawer() {
    clearTimeout(backdropHideTimer);
    drawerBackdrop.hidden = false;
    // Force layout so the opacity transition fires (display: none → block then add .show).
    drawerBackdrop.offsetHeight;
    drawerBackdrop.classList.add('show');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawerBackdrop.classList.remove('show');
    document.body.classList.remove('drawer-open');
    backdropHideTimer = setTimeout(() => { drawerBackdrop.hidden = true; }, 240);
  }

  triggerBtn.addEventListener('click', openDrawer);
  drawerClose.addEventListener('click', closeDrawer);
  drawerBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });

  // -- Pointer interaction on the preview --
  // mousedown/move/up are forwarded as individual CDP events over WS so a
  // drag really drags (text selection, draggable elements), a wheel really
  // scrolls, and a click is just press+release at the same coord. Throttle
  // move events to ~60Hz so a fast drag doesn't flood the socket.
  let dragging = false;
  let currentButtons = 0;
  let lastMoveSent = 0;
  // Multi-click tracker so a fast 2nd/3rd press at near-same coord is sent
  // as clickCount=2/3 — chromium's renderer needs this to fire word/paragraph
  // selection on dbl/triple click. (It does NOT auto-promote from CDP press
  // timing the way real OS mouse events do.)
  let lastPressTime = 0;
  let lastPressX = 0;
  let lastPressY = 0;
  let currentClickCount = 1;
  const MULTI_CLICK_MS = 400;
  const MULTI_CLICK_PX = 5;

  // Send mouse coords as normalized 0..1 instead of pixels. The preview
  // stream runs at 540p (or whatever lib/cdp.js picks for the screencast)
  // but the actual kiosk renders at settings.resolution — the server scales
  // these floats by the kiosk's real width/height before dispatching to CDP.
  // Means preview resolution can change without breaking click coordinates.
  function previewCoords(e) {
    const rect = previewImg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
    return { x, y };
  }

  function buttonName(btn) {
    if (btn === 0) return 'left';
    if (btn === 1) return 'middle';
    if (btn === 2) return 'right';
    return 'left';
  }
  function buttonBit(btn) {
    if (btn === 0) return 1;
    if (btn === 1) return 4;
    if (btn === 2) return 2;
    return 0;
  }

  previewImg.addEventListener('mousedown', (e) => {
    if (!previewImg.naturalWidth) return;
    e.preventDefault();
    dragging = true;
    currentButtons |= buttonBit(e.button);
    const now = performance.now();
    const dx = Math.abs(e.clientX - lastPressX);
    const dy = Math.abs(e.clientY - lastPressY);
    if (now - lastPressTime < MULTI_CLICK_MS && dx < MULTI_CLICK_PX && dy < MULTI_CLICK_PX) {
      currentClickCount = Math.min(currentClickCount + 1, 3);
    } else {
      currentClickCount = 1;
    }
    lastPressTime = now;
    lastPressX = e.clientX;
    lastPressY = e.clientY;
    const { x, y } = previewCoords(e);
    wsSend({ type: 'mouse', action: 'press', x, y, button: buttonName(e.button), clickCount: currentClickCount });
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    if (now - lastMoveSent < 16) return; // ~60Hz cap
    lastMoveSent = now;
    const { x, y } = previewCoords(e);
    wsSend({ type: 'mouse', action: 'move', x, y, buttons: currentButtons });
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    currentButtons &= ~buttonBit(e.button);
    const { x, y } = previewCoords(e);
    wsSend({ type: 'mouse', action: 'release', x, y, button: buttonName(e.button), clickCount: currentClickCount });
  });

  // Suppress the browser's native context menu on right-click so right-mouse
  // can be forwarded as a real button to the kiosk.
  previewImg.addEventListener('contextmenu', (e) => e.preventDefault());

  // Scroll on the preview → forward as mouseWheel to the kiosk page. Convert
  // line/page deltaMode to pixels with rough constants — chromium expects
  // CSS pixels.
  previewImg.addEventListener('wheel', (e) => {
    if (!previewImg.naturalWidth) return;
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }       // lines → px
    else if (e.deltaMode === 2) { dx *= 800; dy *= 800; }// pages → px
    const { x, y } = previewCoords(e);
    wsSend({ type: 'mouse', action: 'wheel', x, y, dx, dy });
  }, { passive: false });

  // -- Load data --
  function loadSettings() {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => {
        urlInput.value = s.url || '';
        const z = Math.round((s.zoom || 1) * 100);
        zoomSlider.value = z;
        zoomValue.textContent = z + '%';
        renderBookmarks(s.bookmarks || []);
      })
      .catch(() => {});
  }

  // -- Bookmarks (quicknav) --
  // Kept in settings.json so all panels + the kiosk share one list. Clicking
  // one is exactly the "Go" button: POST /api/navigate persists settings.url
  // AND navigates chromium, so the kiosk stays on it after a reboot. Favicon
  // is derived from the host via Google's s2 service — no storage, the panel
  // browser already has internet.
  let bookmarks = [];

  function faviconFor(url) {
    try {
      return 'https://www.google.com/s2/favicons?domain=' +
        encodeURIComponent(new URL(url).host) + '&sz=32';
    } catch { return ''; }
  }

  function renderBookmarks(list) {
    bookmarks = Array.isArray(list) ? list : [];
    if (!bookmarks.length) {
      bookmarkList.innerHTML = '<div class="bookmark-empty">No bookmarks yet.</div>';
      return;
    }
    bookmarkList.innerHTML = bookmarks
      .map((b, i) =>
        '<div class="bookmark-item" data-idx="' + i + '" title="' + escapeAttr(b.url) + '">' +
        '<img class="bookmark-favicon" src="' + escapeAttr(faviconFor(b.url)) + '" alt="" ' +
        'onerror="this.style.visibility=\'hidden\'">' +
        '<span class="bookmark-name">' + escapeText(b.name || b.url) + '</span>' +
        '<button class="bookmark-forget" data-forget="' + i + '" title="Remove">✕</button>' +
        '</div>'
      )
      .join('');
  }

  function saveBookmarks() {
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarks }),
    }).then(r => r.json());
  }

  bookmarkList.addEventListener('click', (e) => {
    const forget = e.target.closest('[data-forget]');
    if (forget) {
      e.stopPropagation();
      const idx = parseInt(forget.dataset.forget, 10);
      const b = bookmarks[idx];
      if (!b || !confirm('Remove bookmark "' + (b.name || b.url) + '"?')) return;
      bookmarks.splice(idx, 1);
      renderBookmarks(bookmarks);
      saveBookmarks().then(() => toast('Bookmark removed')).catch(() => toast('Failed'));
      return;
    }
    const item = e.target.closest('.bookmark-item');
    if (!item) return;
    const b = bookmarks[parseInt(item.dataset.idx, 10)];
    if (!b) return;
    showPreviewLoader();
    fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: b.url }),
    })
      .then(r => r.json())
      .then(res => toast(res.ok ? ('→ ' + (b.name || b.url)) : ('Error: ' + (res.error || 'unknown'))))
      .catch(() => toast('Failed to navigate'));
  });

  btnBookmarkAdd.addEventListener('click', () => {
    const name = bookmarkName.value.trim();
    let url = bookmarkUrl.value.trim();
    if (!url) { toast('Enter a URL'); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { toast('Invalid URL'); return; }
    bookmarks.push({ name: name || url, url });
    renderBookmarks(bookmarks);
    bookmarkName.value = '';
    bookmarkUrl.value = '';
    saveBookmarks().then(() => toast('Bookmark added')).catch(() => toast('Failed'));
  });

  bookmarkUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnBookmarkAdd.click();
  });

  // -- Preview FPS (client-local, sent over WS) --
  fpsPreset.value = String(readLocalFps());
  fpsPreset.addEventListener('change', () => {
    const fps = parseInt(fpsPreset.value, 10) || 1;
    writeLocalFps(fps);
    wsSend({ type: 'preview-fps', fps });
    toast('Preview ' + fps + ' fps');
  });

  // -- Advanced (chromium flags) modal --
  function syncRemoteDebugInfo() {
    advancedRemoteInfo.hidden = !advancedRemoteDebug.checked;
  }

  function renderSuppressKeys(available, enabled) {
    advancedSuppress.innerHTML = '';
    available.forEach(({ id, label }) => {
      const wrap = document.createElement('label');
      wrap.className = 'advanced-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = id;
      cb.checked = enabled.includes(id);
      const span = document.createElement('span');
      span.textContent = label;
      wrap.append(cb, span);
      advancedSuppress.appendChild(wrap);
    });
  }

  function selectedSuppressKeys() {
    return Array.from(advancedSuppress.querySelectorAll('input:checked')).map(cb => cb.value);
  }

  function openAdvancedModal() {
    advancedMsg.textContent = '';
    advancedMsg.className = 'advanced-msg';
    advancedFlags.value = 'Loading...';
    advancedFlags.disabled = true;
    advancedSuppress.innerHTML = '';
    Promise.all([
      fetch('/api/kiosk-flags').then(r => r.text()),
      fetch('/api/settings').then(r => r.json()),
      fetch('/api/suppress-keys').then(r => r.json()),
    ])
      .then(([flags, settings, suppress]) => {
        advancedFlags.value = flags;
        advancedFlags.disabled = false;
        advancedRemoteDebug.checked = settings.remoteDebugEnabled === true;
        renderSuppressKeys(suppress.available, suppress.enabled);
        syncRemoteDebugInfo();
      })
      .catch(() => { advancedFlags.value = ''; advancedFlags.disabled = false; });
    advancedModal.hidden = false;
  }

  function closeAdvancedModal() { advancedModal.hidden = true; }

  btnAdvanced.addEventListener('click', openAdvancedModal);
  btnAdvancedCancel.addEventListener('click', closeAdvancedModal);
  advancedRemoteDebug.addEventListener('change', syncRemoteDebugInfo);

  btnAdvancedReset.addEventListener('click', () => {
    fetch('/api/kiosk-flags/default')
      .then(r => r.text())
      .then(text => {
        advancedFlags.value = text;
        advancedMsg.textContent = 'Loaded defaults. Click Save & restart to apply.';
        advancedMsg.className = 'advanced-msg ok';
      })
      .catch(() => { advancedMsg.textContent = 'Could not load defaults.'; advancedMsg.className = 'advanced-msg err'; });
  });

  btnAdvancedSave.addEventListener('click', () => {
    const flags = advancedFlags.value;
    const remoteDebugEnabled = advancedRemoteDebug.checked;
    const suppressKeys = selectedSuppressKeys();
    btnAdvancedSave.disabled = true;
    advancedMsg.textContent = 'Saving...';
    advancedMsg.className = 'advanced-msg';
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kioskFlags: flags, remoteDebugEnabled, suppressKeys }),
    })
      .then(r => r.json())
      .then(() => {
        advancedMsg.textContent = 'Saved. Restarting kiosk...';
        advancedMsg.className = 'advanced-msg ok';
        showPreviewLoader(true);
        return fetch('/api/restart-kiosk', { method: 'POST' });
      })
      .then(() => {
        toast('Kiosk restarting with new flags...');
        setTimeout(closeAdvancedModal, 1200);
      })
      .catch(() => {
        advancedMsg.textContent = 'Save failed.';
        advancedMsg.className = 'advanced-msg err';
      })
      .finally(() => { btnAdvancedSave.disabled = false; });
  });

  // Render a system-info object into the sys-table. The data arrives via WS
  // push from the server every few seconds — no per-client HTTP polling.
  function renderSystemInfo(info) {
    if (!info) return;
    const cpuClass = info.cpuUsage == null ? '' : (info.cpuUsage >= 85 ? 'sys-status-bad' : info.cpuUsage >= 60 ? 'sys-status-warn' : 'sys-status-ok');
    const tempVal = parseFloat(info.cpuTemp);
    const tempClass = !isNaN(tempVal) ? (tempVal >= 80 ? 'sys-status-bad' : tempVal >= 70 ? 'sys-status-warn' : '') : '';
    const loadClass = info.load && info.load.stressed ? 'sys-status-warn' : '';
    const throttledClass = info.throttled ? (info.throttled.ok ? 'sys-status-ok' : 'sys-status-bad') : '';
    const memVal = parseInt(info.memory.percent);
    const memClass = !isNaN(memVal) && memVal >= 90 ? 'sys-status-bad' : '';
    const gitVal = info.git ? info.git.hash + ' (' + info.git.branch + ')' : 'N/A';

    sysInfo.innerHTML =
      row('IP', info.ip) +
      row('Hostname', info.hostname) +
      (info.model ? row('Model', info.model) : '') +
      row('CPU Temp', info.cpuTemp, tempClass) +
      (info.cpuUsage != null ? row('CPU Use', info.cpuUsage + '%' + (info.cpuFreq ? ' @ ' + info.cpuFreq : ''), cpuClass) : '') +
      (info.load ? row('Load', info.load.one + ' / ' + info.load.five + ' / ' + info.load.fifteen + ' (' + info.cpuCores + ' cores)', loadClass) : '') +
      (info.throttled ? row('Throttled', info.throttled.label, throttledClass) : '') +
      row('Memory', info.memory.percent + ' (' + info.memory.free + ' free)', memClass) +
      row('Disk', info.disk.percent + ' (' + info.disk.free + ' free)') +
      row('Uptime', info.uptime) +
      row('Version', gitVal);
  }

  function row(label, value, cls) {
    const c = cls ? ' class="' + cls + '"' : '';
    return '<tr><td>' + label + '</td><td' + c + '>' + (value || 'N/A') + '</td></tr>';
  }

  // -- Zoom --
  function applyZoom(pct) {
    zoomValue.textContent = pct + '%';
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      fetch('/api/zoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoom: pct / 100 }),
      })
        .then(r => r.json())
        .then(res => { if (!res.ok) toast('Error: ' + res.error); })
        .catch(() => toast('Failed'));
    }, 150);
  }

  zoomSlider.addEventListener('input', () => {
    applyZoom(parseInt(zoomSlider.value));
  });

  btnZoomReset.addEventListener('click', () => {
    zoomSlider.value = 100;
    applyZoom(100);
  });

  // -- Actions --
  btnNavigate.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    btnNavigate.disabled = true;
    showPreviewLoader();
    fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(r => r.json())
      .then(res => {
        toast(res.ok ? 'Navigating...' : 'Error: ' + (res.error || 'unknown'));
      })
      .catch(() => toast('Failed to send command'))
      .finally(() => { btnNavigate.disabled = false; });
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnNavigate.click();
  });

  btnReload.addEventListener('click', () => {
    showPreviewLoader();
    fetch('/api/reload', { method: 'POST' })
      .then(() => toast('Reloading page...'))
      .catch(() => toast('Failed'));
  });

  btnClearCache.addEventListener('click', () => {
    showPreviewLoader();
    fetch('/api/clear-cache', { method: 'POST' })
      .then(() => toast('Cache cleared, reloading...'))
      .catch(() => toast('Failed'));
  });

  btnRestart.addEventListener('click', () => {
    if (!confirm('Restart the kiosk browser?')) return;
    showPreviewLoader(true);
    fetch('/api/restart-kiosk', { method: 'POST' })
      .then(() => toast('Restarting kiosk...'))
      .catch(() => toast('Failed'));
  });

  btnReboot.addEventListener('click', () => {
    if (!confirm('Reboot the entire system? This will take ~30 seconds.')) return;
    showPreviewLoader(true);
    fetch('/api/reboot', { method: 'POST' })
      .then(() => toast('Rebooting system...'))
      .catch(() => toast('Failed'));
  });

  // -- Display resolution --
  const PRESET_VALUES = ['1920x1080', '1280x720', '1024x768', '960x640', '800x600'];

  function setDisplaySelectFromSettings(s) {
    if (!s || !s.resolution) return;
    const v = s.resolution.width + 'x' + s.resolution.height;
    if (PRESET_VALUES.includes(v)) {
      displayPreset.value = v;
      displayCustom.hidden = true;
    } else {
      displayPreset.value = 'custom';
      displayCustom.hidden = false;
      displayW.value = s.resolution.width;
      displayH.value = s.resolution.height;
    }
  }

  displayPreset.addEventListener('change', () => {
    displayCustom.hidden = displayPreset.value !== 'custom';
  });

  btnDisplayApply.addEventListener('click', () => {
    let w, h;
    if (displayPreset.value === 'custom') {
      w = parseInt(displayW.value, 10);
      h = parseInt(displayH.value, 10);
      if (!w || !h || w < 320 || h < 240) {
        toast('Enter valid width and height');
        return;
      }
    } else {
      [w, h] = displayPreset.value.split('x').map(Number);
    }
    if (!confirm('Set kiosk resolution to ' + w + ' × ' + h + ' and restart kiosk?')) return;

    btnDisplayApply.disabled = true;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: { width: w, height: h } }),
    })
      .then(r => r.json())
      .then(() => {
        showPreviewLoader(true);
        return fetch('/api/restart-kiosk', { method: 'POST' });
      })
      .then(() => toast('Resolution applied. Kiosk restarting...'))
      .catch(() => toast('Failed to apply resolution'))
      .finally(() => { btnDisplayApply.disabled = false; });
  });

  // -- Update from Git --
  function appendUpdateLine(kind, line) {
    const span = document.createElement('span');
    if (kind === 'err') span.className = 'out-err';
    else if (kind === 'fail') span.className = 'out-fail';
    else if (kind === 'ok') span.className = 'out-ok';
    span.textContent = line + '\n';
    updateOutput.appendChild(span);
    updateOutput.scrollTop = updateOutput.scrollHeight;
  }

  function showUpdateError(err) {
    updating = false;
    updateTitle.textContent = 'Update failed';
    updateSubstatus.textContent = err || 'unknown error';
    updateStatusRow.classList.add('bad');
    const spinner = updateStatusRow.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';
    btnUpdateClose.hidden = false;
    appendUpdateLine('fail', '✗ ' + (err || 'unknown error'));
  }

  btnUpdate.addEventListener('click', () => {
    if (updating) return;
    if (!confirm('Pull the latest from git and restart the OrbitControl server?\n\nThe kiosk will keep running. The control panel will briefly disconnect.')) return;
    updating = true;
    updateOutput.textContent = '';
    updateTitle.textContent = 'Updating...';
    updateStepText.textContent = 'Starting...';
    updateSubstatus.textContent = 'Sending update request...';
    updateStatusRow.classList.remove('ok', 'bad');
    const spinner = updateStatusRow.querySelector('.spinner');
    if (spinner) spinner.style.display = '';
    btnUpdateClose.hidden = true;
    updateModal.hidden = false;

    fetch('/api/update', { method: 'POST' })
      .then(r => r.json().then(j => ({ status: r.status, body: j })))
      .then(({ status, body }) => {
        if (status >= 400 || (body && body.error)) {
          showUpdateError(body && body.error ? body.error : 'request failed');
        } else {
          appendUpdateLine('ok', '✓ Update started.');
        }
      })
      .catch(() => showUpdateError('Could not reach server'));
  });

  btnUpdateClose.addEventListener('click', () => {
    updateModal.hidden = true;
  });

  // -- WiFi --
  let wifiConnectTarget = null;
  let wifiSavedSet = new Set();

  // Render wifi state into the UI. Called from the WS push every few seconds
  // AND from on-demand refresh paths (after connect/forget actions).
  function renderWifiStatus(status, saved) {
    const s = status || {};
    const ssid = s.ssid || '—';
    const online = s.connected;
    netDot.className = 'net-dot' + (online ? ' online' : '');
    netSsid.textContent = ssid;
    if (wifiModalSsid) {
      wifiModalSsid.textContent = ssid + (online && s.ip ? ' (' + s.ip + ')' : '');
      wifiModalDot.className = 'net-dot' + (online ? ' online' : '');
    }
    wifiSavedSet = new Set((saved || []).map((n) => n.ssid));
    renderSavedNetworks(saved || []);
  }

  function refreshWifiPanel() {
    // One-off fetch — used after wifi connect/forget when we want the panel
    // to update immediately instead of waiting up to a push interval.
    fetch('/api/wifi/status')
      .then((r) => r.json())
      .then((data) => renderWifiStatus(data.status, data.saved))
      .catch(() => {});
  }

  function renderSavedNetworks(saved) {
    if (!wifiSaved) return;
    if (!saved.length) {
      wifiSaved.innerHTML = '<div class="wifi-empty">No saved networks.</div>';
      return;
    }
    wifiSaved.innerHTML = saved
      .map(
        (n) =>
          '<div class="wifi-item' +
          (n.current ? ' current' : '') +
          '" data-ssid="' + escapeAttr(n.ssid) + '">' +
          '<span class="wifi-item-ssid">' + escapeText(n.ssid) + '</span>' +
          (n.current ? '<span class="wifi-item-meta">connected</span>' : '<span class="wifi-item-meta">saved</span>') +
          '<button class="wifi-item-forget" data-forget="' + escapeAttr(n.ssid) + '">forget</button>' +
          '</div>'
      )
      .join('');
  }

  function escapeText(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function qualityClass(q) {
    if (q >= 75) return 'q-4';
    if (q >= 50) return 'q-3';
    if (q >= 25) return 'q-2';
    return 'q-1';
  }

  function renderScanResults(networks) {
    if (!networks.length) {
      wifiList.innerHTML = '<div class="wifi-empty">No networks found. Try scanning again.</div>';
      return;
    }
    wifiList.innerHTML = networks
      .map((n) => {
        const isSaved = wifiSavedSet.has(n.ssid);
        return (
          '<div class="wifi-item" data-ssid="' + escapeAttr(n.ssid) + '" data-secured="' + (n.secured ? '1' : '0') + '">' +
          '<span class="wifi-item-bars ' + qualityClass(n.quality) + '"><span></span><span></span><span></span><span></span></span>' +
          '<span class="wifi-item-ssid">' + escapeText(n.ssid) + '</span>' +
          '<span class="wifi-item-lock">' + (n.secured ? '🔒' : '') + '</span>' +
          '<span class="wifi-item-meta">' + (isSaved ? 'saved · ' : '') + n.quality + '%</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function openWifiModal() {
    wifiModal.hidden = false;
    refreshWifiPanel();
    wifiList.innerHTML = '<div class="wifi-empty">Click Scan to look for networks.</div>';
  }

  function closeWifiModal() { wifiModal.hidden = true; }

  function openConnectModal(ssid, secured) {
    wifiConnectTarget = ssid;
    wifiConnectTitle.textContent = 'Connect to "' + ssid + '"';
    wifiPassword.value = '';
    wifiPassword.placeholder = secured ? 'Network password' : '(open network — leave empty)';
    wifiConnectMsg.textContent = '';
    wifiConnectMsg.className = 'wifi-connect-msg';
    wifiConnectModal.hidden = false;
    setTimeout(() => wifiPassword.focus(), 50);
  }

  function closeConnectModal() {
    wifiConnectModal.hidden = true;
    wifiConnectTarget = null;
  }

  btnNetManage.addEventListener('click', openWifiModal);
  btnWifiClose.addEventListener('click', closeWifiModal);
  btnWifiConnectCancel.addEventListener('click', closeConnectModal);

  btnWifiScan.addEventListener('click', () => {
    btnWifiScan.disabled = true;
    wifiHint.textContent = 'Scanning...';
    wifiList.innerHTML = '<div class="wifi-empty">Scanning, ~3s...</div>';
    fetch('/api/wifi/scan')
      .then((r) => r.json())
      .then((data) => {
        wifiHint.textContent = (data.networks || []).length + ' networks';
        renderScanResults(data.networks || []);
      })
      .catch(() => { wifiHint.textContent = 'Scan failed'; })
      .finally(() => { btnWifiScan.disabled = false; });
  });

  wifiList.addEventListener('click', (e) => {
    const item = e.target.closest('.wifi-item');
    if (!item || !item.dataset.ssid) return;
    openConnectModal(item.dataset.ssid, item.dataset.secured === '1');
  });

  wifiSaved.addEventListener('click', (e) => {
    const forget = e.target.closest('[data-forget]');
    if (forget) {
      e.stopPropagation();
      const ssid = forget.dataset.forget;
      if (!confirm('Forget saved network "' + ssid + '"?')) return;
      fetch('/api/wifi/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid }),
      })
        .then((r) => r.json())
        .then(() => { toast('Forgot ' + ssid); refreshWifiPanel(); })
        .catch(() => toast('Failed to forget'));
      return;
    }
    const item = e.target.closest('.wifi-item');
    if (item && item.dataset.ssid) openConnectModal(item.dataset.ssid, true);
  });

  btnWifiConnectSubmit.addEventListener('click', () => {
    if (!wifiConnectTarget) return;
    btnWifiConnectSubmit.disabled = true;
    wifiConnectMsg.textContent = 'Connecting...';
    wifiConnectMsg.className = 'wifi-connect-msg';
    fetch('/api/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: wifiConnectTarget, password: wifiPassword.value }),
    })
      .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
      .then(({ status, body }) => {
        if (status >= 400 || (body && body.error)) {
          wifiConnectMsg.textContent = (body && body.error) || 'failed';
          wifiConnectMsg.className = 'wifi-connect-msg err';
        } else {
          wifiConnectMsg.textContent = 'Saved. Switching to ' + wifiConnectTarget + '...';
          wifiConnectMsg.className = 'wifi-connect-msg ok';
          setTimeout(() => { closeConnectModal(); refreshWifiPanel(); }, 1500);
        }
      })
      .catch(() => {
        wifiConnectMsg.textContent = 'Network error';
        wifiConnectMsg.className = 'wifi-connect-msg err';
      })
      .finally(() => { btnWifiConnectSubmit.disabled = false; });
  });

  wifiPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnWifiConnectSubmit.click();
  });

  // -- Init --
  loadSettings();
  connect();

  // Sync display select after initial settings load
  fetch('/api/settings').then(r => r.json()).then(setDisplaySelectFromSettings).catch(() => {});

  // System-info + wifi-status are now pushed over WS every few seconds by
  // server.js (and the server fires an immediate push on each new WS
  // connection). No HTTP polling intervals needed.
})();
