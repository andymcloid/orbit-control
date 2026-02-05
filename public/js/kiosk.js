(function () {
  const frame = document.getElementById('kiosk-frame');
  const loading = document.getElementById('loading');
  let ws;

  function loadInitialUrl() {
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => {
        if (s.url) {
          frame.src = s.url;
          loading.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '?type=kiosk');

    ws.onopen = () => {
      console.log('[Orbit] WebSocket connected');
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'navigate':
          frame.src = msg.url;
          loading.style.display = 'none';
          break;
        case 'reload':
          try { frame.contentWindow.location.reload(); } catch { frame.src = frame.src; }
          break;
      }
    };

    ws.onclose = () => {
      console.log('[Orbit] WebSocket disconnected, reconnecting...');
      setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }

  loadInitialUrl();
  connect();
})();
