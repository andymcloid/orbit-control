const { execFile } = require('child_process');
const os = require('os');

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';
const IFACE = process.env.ORBIT_WIFI_IFACE || 'wlan0';
const WPA_CLI = '/sbin/wpa_cli';

function wpaCli(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!isLinux || isDevMode) return resolve('');
    execFile(WPA_CLI, ['-i', IFACE, ...args], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

// Parse key=value lines from `wpa_cli status` etc.
function parseKv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function getStatus() {
  if (!isLinux || isDevMode) return { connected: false, ssid: null, ip: null, state: 'DEV' };
  const status = parseKv(await wpaCli(['status']));
  return {
    connected: status.wpa_state === 'COMPLETED',
    ssid: status.ssid || null,
    bssid: status.bssid || null,
    ip: status.ip_address || null,
    freq: status.freq ? parseInt(status.freq, 10) : null,
    state: status.wpa_state || null,
  };
}

async function listSaved() {
  if (!isLinux || isDevMode) return [];
  const out = await wpaCli(['list_networks']);
  const lines = out.split('\n').slice(1); // skip header
  const result = [];
  for (const line of lines) {
    const [id, ssid, bssid, flags] = line.split('\t');
    if (!id || !ssid) continue;
    result.push({
      id: parseInt(id, 10),
      ssid,
      current: (flags || '').includes('CURRENT'),
      disabled: (flags || '').includes('DISABLED'),
    });
  }
  return result;
}

// Convert dBm signal level to a 0-100 quality score (rough estimate).
// -50 dBm = 100, -100 dBm = 0
function dbmToQuality(dbm) {
  if (dbm >= -50) return 100;
  if (dbm <= -100) return 0;
  return Math.round(2 * (dbm + 100));
}

async function scan() {
  if (!isLinux || isDevMode) {
    return [
      { ssid: 'DevNetwork', level: -50, quality: 100, secured: true, freq: 2412 },
    ];
  }
  await wpaCli(['scan']);
  // wpa_cli scan is async — wait briefly for results
  await new Promise((r) => setTimeout(r, 2500));
  const out = await wpaCli(['scan_results']);
  const lines = out.split('\n').slice(1);
  const networks = new Map();
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [bssid, freq, level, flags, ssid] = parts;
    if (!ssid) continue;
    const dbm = parseInt(level, 10);
    const existing = networks.get(ssid);
    // Dedupe by SSID, keep entry with strongest signal
    if (!existing || dbm > existing.level) {
      networks.set(ssid, {
        ssid,
        bssid,
        freq: parseInt(freq, 10),
        level: dbm,
        quality: dbmToQuality(dbm),
        secured: /WPA|WEP|PSK|EAP|SAE/i.test(flags),
        flags,
      });
    }
  }
  return Array.from(networks.values()).sort((a, b) => b.level - a.level);
}

// Wrap a string for wpa_cli's quoted-value format. Backslashes and quotes are
// escaped per wpa_supplicant.conf syntax.
function quoteValue(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function connect(ssid, password) {
  if (!ssid) throw new Error('ssid required');
  if (!isLinux || isDevMode) return { id: -1, dev: true };

  const saved = await listSaved();
  const existing = saved.find((n) => n.ssid === ssid);
  let id;

  if (existing) {
    id = existing.id;
    // If password given, update it; otherwise keep stored one
    if (password) {
      await wpaCli(['set_network', String(id), 'psk', quoteValue(password)]);
    }
  } else {
    const res = await wpaCli(['add_network']);
    id = parseInt(res, 10);
    if (isNaN(id)) throw new Error('add_network failed: ' + res);
    await wpaCli(['set_network', String(id), 'ssid', quoteValue(ssid)]);
    await wpaCli(['set_network', String(id), 'scan_ssid', '1']);
    if (password) {
      await wpaCli(['set_network', String(id), 'psk', quoteValue(password)]);
    } else {
      await wpaCli(['set_network', String(id), 'key_mgmt', 'NONE']);
    }
  }

  // select_network forces this one and disables others. Then we re-enable
  // the others so they remain available as fallback when out of range.
  await wpaCli(['select_network', String(id)]);
  for (const n of saved) {
    if (n.id !== id) await wpaCli(['enable_network', String(n.id)]).catch(() => {});
  }
  await wpaCli(['save_config']);
  return { id };
}

async function forget(ssid) {
  if (!isLinux || isDevMode) return { ok: true, dev: true };
  const saved = await listSaved();
  const target = saved.find((n) => n.ssid === ssid);
  if (!target) throw new Error('network not saved');
  await wpaCli(['remove_network', String(target.id)]);
  await wpaCli(['save_config']);
  return { ok: true };
}

module.exports = { getStatus, listSaved, scan, connect, forget };
