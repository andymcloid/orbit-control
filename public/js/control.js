(function () {
  const urlInput = document.getElementById('url-input');
  const btnNavigate = document.getElementById('btn-navigate');
  const btnReload = document.getElementById('btn-reload');
  const btnRestart = document.getElementById('btn-restart');
  const btnReboot = document.getElementById('btn-reboot');
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomValue = document.getElementById('zoom-value');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const sysInfo = document.getElementById('sys-info');
  const toastEl = document.getElementById('toast');
  const previewToggle = document.getElementById('preview-toggle');
  const previewContainer = document.getElementById('preview-container');
  const previewImg = document.getElementById('preview-img');
  const previewPlaceholder = document.getElementById('preview-placeholder');

  let ws;
  let toastTimer;
  let zoomTimer;

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
      if (previewToggle.checked) {
        ws.send(JSON.stringify({ type: 'preview-start' }));
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'status') {
        updateStatus(msg);
      } else if (msg.type === 'frame') {
        previewImg.src = 'data:image/jpeg;base64,' + msg.data;
        previewImg.style.display = 'block';
        previewPlaceholder.style.display = 'none';
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
  }

  // -- Preview toggle --
  previewToggle.addEventListener('change', () => {
    const on = previewToggle.checked;
    previewContainer.style.display = on ? 'block' : 'none';
    previewToggle.nextElementSibling.textContent = on ? 'On' : 'Off';
    wsSend({ type: on ? 'preview-start' : 'preview-stop' });
    if (!on) {
      previewImg.style.display = 'none';
      previewPlaceholder.style.display = 'flex';
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
  previewImg.style.cursor = 'crosshair';

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
        sysInfo.innerHTML =
          row('IP', info.ip) +
          row('Hostname', info.hostname) +
          row('CPU Temp', info.cpuTemp) +
          row('Memory', info.memory.percent + ' (' + info.memory.free + ' free)') +
          row('Disk', info.disk.percent + ' (' + info.disk.free + ' free)') +
          row('Uptime', info.uptime);
      })
      .catch(() => { sysInfo.innerHTML = '<dt>Error</dt><dd>Could not load</dd>'; });
  }

  function row(label, value) {
    return '<dt>' + label + '</dt><dd>' + (value || 'N/A') + '</dd>';
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
    }, 150); // Debounce slider dragging
  }

  zoomSlider.addEventListener('input', () => {
    applyZoom(parseInt(zoomSlider.value));
  });

  btnZoomReset.addEventListener('click', () => {
    zoomSlider.value = 100;
    applyZoom(100);
  });

  // Zoom presets
  document.querySelectorAll('[data-zoom]').forEach(btn => {
    btn.addEventListener('click', () => {
      const z = parseInt(btn.dataset.zoom);
      zoomSlider.value = z;
      applyZoom(z);
    });
  });

  // -- Actions --
  btnNavigate.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    btnNavigate.disabled = true;
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
    fetch('/api/reload', { method: 'POST' })
      .then(() => toast('Reloading page...'))
      .catch(() => toast('Failed'));
  });

  btnRestart.addEventListener('click', () => {
    if (!confirm('Restart the kiosk browser?')) return;
    fetch('/api/restart-kiosk', { method: 'POST' })
      .then(() => toast('Restarting kiosk...'))
      .catch(() => toast('Failed'));
  });

  btnReboot.addEventListener('click', () => {
    if (!confirm('Reboot the entire system? This will take ~30 seconds.')) return;
    fetch('/api/reboot', { method: 'POST' })
      .then(() => toast('Rebooting system...'))
      .catch(() => toast('Failed'));
  });

  // -- Init --
  loadSettings();
  loadSystemInfo();
  setInterval(loadSystemInfo, 10000);
  connect();
})();
