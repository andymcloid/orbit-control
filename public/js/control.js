(function () {
  const urlInput = document.getElementById('url-input');
  const btnNavigate = document.getElementById('btn-navigate');
  const btnReload = document.getElementById('btn-reload');
  const btnRestart = document.getElementById('btn-restart');
  const btnReboot = document.getElementById('btn-reboot');
  const btnUpdate = document.getElementById('btn-update');
  const btnUpdateClose = document.getElementById('btn-update-close');
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomValue = document.getElementById('zoom-value');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const sysInfo = document.getElementById('sys-info');
  const toastEl = document.getElementById('toast');
  const previewImg = document.getElementById('preview-img');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const previewLed = document.getElementById('preview-led');
  const displayPreset = document.getElementById('display-preset');
  const displayCustom = document.getElementById('display-custom');
  const displayW = document.getElementById('display-w');
  const displayH = document.getElementById('display-h');
  const btnDisplayApply = document.getElementById('btn-display-apply');
  const displayHint = document.getElementById('display-hint');
  const updateModal = document.getElementById('update-modal');
  const updateTitle = document.getElementById('update-title');
  const updateStepText = document.getElementById('update-step-text');
  const updateOutput = document.getElementById('update-output');
  const updateStatusRow = document.getElementById('update-status-row');
  const updateSubstatus = document.getElementById('update-substatus');
  let ws;
  let toastTimer;
  let zoomTimer;
  let previewOn = true;
  let updating = false;
  // State: null = normal, 'wait-disconnect' = action fired, waiting for browser to go offline,
  //        'wait-reconnect' = browser went offline, waiting for it to come back
  let waitingForReconnect = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  // -- WebSocket --
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = () => {
      if (previewOn) {
        ws.send(JSON.stringify({ type: 'preview-start' }));
      }
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
        loadSystemInfo();
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'status') {
        updateStatus(msg);
      } else if (msg.type === 'frame') {
        if (waitingForReconnect) return;
        previewImg.src = 'data:image/jpeg;base64,' + msg.data;
        previewImg.style.display = 'block';
        previewPlaceholder.style.display = 'none';
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
    if (previewOn) previewPlaceholder.style.display = 'flex';
    if (awaitReconnect) waitingForReconnect = 'wait-disconnect';
  }

  // -- Preview LED toggle --
  previewLed.addEventListener('click', () => {
    previewOn = !previewOn;
    previewLed.classList.toggle('active', previewOn);
    wsSend({ type: previewOn ? 'preview-start' : 'preview-stop' });
    if (previewOn) {
      previewPlaceholder.style.display = 'flex';
    } else {
      previewImg.style.display = 'none';
      previewPlaceholder.style.display = 'none';
    }
  });

  // -- Click on preview to interact --
  previewImg.addEventListener('click', (e) => {
    if (!previewImg.naturalWidth) return;
    const rect = previewImg.getBoundingClientRect();
    const scaleX = previewImg.naturalWidth / rect.width;
    const scaleY = previewImg.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    fetch('/api/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }).catch(() => {});
  });

  // -- Load data --
  function loadSettings() {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => {
        urlInput.value = s.url || '';
        const z = Math.round((s.zoom || 1) * 100);
        zoomSlider.value = z;
        zoomValue.textContent = z + '%';
      })
      .catch(() => {});
  }

  function loadSystemInfo() {
    fetch('/api/system-info')
      .then(r => r.json())
      .then(info => {
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
      })
      .catch(() => { sysInfo.innerHTML = '<tr><td>Error</td><td>Could not load</td></tr>'; });
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

  // -- Init --
  loadSettings();
  loadSystemInfo();
  setInterval(loadSystemInfo, 10000);
  connect();

  // Sync display select after initial settings load
  fetch('/api/settings').then(r => r.json()).then(setDisplaySelectFromSettings).catch(() => {});
})();
