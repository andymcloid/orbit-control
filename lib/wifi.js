const { execFile } = require('child_process');
const os = require('os');

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';
const IFACE = process.env.ORBIT_WIFI_IFACE || 'wlan0';
const NMCLI = '/usr/bin/nmcli';

function nmcli(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!isLinux || isDevMode) return resolve('');
    execFile(NMCLI, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.message = (err.message || '') + (stderr ? ' — ' + stderr.trim() : '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

// Unescape nmcli's -t (terse) output: \: → :, \\ → \
function unescape(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

// Split a -t mode row on unescaped colons.
function splitTerse(row) {
  const out = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      cur += row[i + 1];
      i++;
    } else if (ch === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function getStatus() {
  if (!isLinux || isDevMode) return { connected: false, ssid: null, ip: null, state: 'DEV' };

  // nmcli -t -f GENERAL.STATE,IP4.ADDRESS,GENERAL.CONNECTION device show <iface>
  let out = '';
  try {
    out = await nmcli(['-t', '-f', 'GENERAL.STATE,IP4.ADDRESS,GENERAL.CONNECTION', 'device', 'show', IFACE]);
  } catch (err) {
    return { connected: false, ssid: null, ip: null, state: 'ERROR', error: err.message };
  }

  let stateRaw = '';
  let ip = null;
  let connName = null;
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);
    if (key === 'GENERAL.STATE') stateRaw = val;
    else if (key.startsWith('IP4.ADDRESS')) ip = val.split('/')[0] || null;
    else if (key === 'GENERAL.CONNECTION') connName = val && val !== '--' ? val : null;
  }

  // stateRaw is e.g. "100 (connected)" or "30 (disconnected)"
  const connected = /^100/.test(stateRaw);

  // Get SSID, BSSID, freq from the active wifi connection (if any)
  let ssid = connName;
  let bssid = null;
  let freq = null;
  if (connected) {
    try {
      const listOut = await nmcli(['-t', '-f', 'IN-USE,SSID,BSSID,FREQ', 'device', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'no']);
      for (const line of listOut.split('\n')) {
        if (!line) continue;
        const parts = splitTerse(line);
        if (parts[0] === '*') {
          ssid = parts[1] || ssid;
          bssid = parts[2] || null;
          freq = parts[3] ? parseInt(parts[3], 10) : null;
          break;
        }
      }
    } catch {}
  }

  return {
    connected,
    ssid: ssid || null,
    bssid,
    ip,
    freq,
    state: stateRaw.replace(/^\d+\s*\(?|\)?\s*$/g, '').toUpperCase() || null,
  };
}

async function listSaved() {
  if (!isLinux || isDevMode) return [];
  const out = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
  const result = [];
  let activeOut = '';
  try {
    activeOut = await nmcli(['-t', '-f', 'NAME', 'connection', 'show', '--active']);
  } catch {}
  const active = new Set(activeOut.split('\n').map((l) => unescape(l.trim())).filter(Boolean));

  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = splitTerse(line);
    if (parts[1] !== '802-11-wireless') continue;
    const name = parts[0];
    result.push({
      id: name, // nmcli uses connection name as the stable identifier
      ssid: name, // connection name == SSID when created via `nmcli device wifi connect`
      current: active.has(name),
      disabled: false,
    });
  }
  return result;
}

async function scan() {
  if (!isLinux || isDevMode) {
    return [
      { ssid: 'DevNetwork', level: -50, quality: 100, secured: true, freq: 2412 },
    ];
  }
  const out = await nmcli(
    ['-t', '-f', 'SSID,SIGNAL,SECURITY,FREQ,BSSID', 'device', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'yes'],
    15000
  );
  const networks = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = splitTerse(line);
    const ssid = parts[0];
    if (!ssid || ssid === '--') continue;
    const signal = parseInt(parts[1], 10) || 0;
    const security = parts[2] || '';
    const freq = parseInt(parts[3], 10) || null;
    const bssid = parts[4] || null;

    const existing = networks.get(ssid);
    if (!existing || signal > existing.quality) {
      networks.set(ssid, {
        ssid,
        bssid,
        freq,
        // No dBm from nmcli — convert quality back to a rough dBm so frontend keeps working
        level: signal > 0 ? Math.round(-100 + signal / 2) : -100,
        quality: signal,
        secured: security !== '' && security !== '--',
        flags: security,
      });
    }
  }
  return Array.from(networks.values()).sort((a, b) => b.quality - a.quality);
}

async function connect(ssid, password) {
  if (!ssid) throw new Error('ssid required');
  if (!isLinux || isDevMode) return { id: -1, dev: true };

  const saved = await listSaved();
  const existing = saved.find((n) => n.ssid === ssid);

  if (existing && !password) {
    // Already saved, no password change — just bring it up
    await nmcli(['connection', 'up', ssid], 30000);
    return { id: ssid };
  }

  if (existing && password) {
    // Update password on existing connection
    await nmcli(['connection', 'modify', ssid, '802-11-wireless-security.psk', password]);
    await nmcli(['connection', 'up', ssid], 30000);
    return { id: ssid };
  }

  // New network — let nmcli create the connection
  const args = ['device', 'wifi', 'connect', ssid, 'ifname', IFACE];
  if (password) args.push('password', password);
  await nmcli(args, 30000);
  return { id: ssid };
}

async function forget(ssid) {
  if (!isLinux || isDevMode) return { ok: true, dev: true };
  const saved = await listSaved();
  const target = saved.find((n) => n.ssid === ssid);
  if (!target) throw new Error('network not saved');
  await nmcli(['connection', 'delete', ssid]);
  return { ok: true };
}

module.exports = { getStatus, listSaved, scan, connect, forget };
