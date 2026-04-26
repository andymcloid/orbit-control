const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(days + (days === 1 ? ' day' : ' days'));
  if (hours > 0) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
  if (mins > 0) parts.push(mins + (mins === 1 ? ' minute' : ' minutes'));
  return 'up ' + (parts.length ? parts.join(', ') : '0 minutes');
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

async function getDiskInfo() {
  if (isLinux) {
    try {
      const diskInfo = await run("df -h / | tail -1 | awk '{print $2, $3, $4, $5}'");
      const [total, used, free, percent] = diskInfo.split(' ');
      return { total, used, free, percent };
    } catch {}
  }
  return { total: 'N/A', used: 'N/A', free: 'N/A', percent: 'N/A' };
}

async function getCpuTemp() {
  if (!isLinux) return 'N/A';
  try {
    const t = await run('cat /sys/class/thermal/thermal_zone0/temp');
    return (parseInt(t) / 1000).toFixed(1) + '°C';
  } catch {
    return 'N/A';
  }
}

let lastCpuStat = null;
function readProcStat() {
  if (!isLinux) return null;
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}

function getCpuUsage() {
  const cur = readProcStat();
  if (!cur) return null;
  if (!lastCpuStat) { lastCpuStat = cur; return null; }
  const idleDiff = cur.idle - lastCpuStat.idle;
  const totalDiff = cur.total - lastCpuStat.total;
  lastCpuStat = cur;
  if (totalDiff <= 0) return null;
  return Math.round((1 - idleDiff / totalDiff) * 100);
}

// Decode RPi vcgencmd get_throttled hex bitmap into human-readable flags.
// Bits 0..3 = currently throttling/under-voltage; bits 16..19 = since boot.
function decodeThrottled(hex) {
  const v = parseInt(hex, 16);
  if (isNaN(v)) return null;
  const now = [];
  if (v & 0x1) now.push('under-voltage');
  if (v & 0x2) now.push('freq-capped');
  if (v & 0x4) now.push('throttled');
  if (v & 0x8) now.push('soft-temp-limit');
  const past = [];
  if (v & 0x10000) past.push('under-voltage');
  if (v & 0x20000) past.push('freq-capped');
  if (v & 0x40000) past.push('throttled');
  if (v & 0x80000) past.push('soft-temp-limit');
  let label;
  if (now.length) label = 'NOW: ' + now.join(', ');
  else if (past.length) label = 'past: ' + past.join(', ');
  else label = 'OK';
  return { ok: now.length === 0, label };
}

async function getThrottled() {
  if (!isLinux) return null;
  try {
    const out = await run('vcgencmd get_throttled');
    const m = out.match(/0x([0-9a-fA-F]+)/);
    if (!m) return null;
    return decodeThrottled(m[1]);
  } catch { return null; }
}

async function getCpuFreq() {
  if (!isLinux) return null;
  try {
    const khz = parseInt(await run('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'), 10);
    if (!khz) return null;
    return Math.round(khz / 1000) + ' MHz';
  } catch { return null; }
}

function getPiModel() {
  if (!isLinux) return null;
  try {
    return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
  } catch { return null; }
}

async function getSystemInfo() {
  const [cpuTemp, disk, throttled, cpuFreq] = await Promise.all([
    getCpuTemp(), getDiskInfo(), getThrottled(), getCpuFreq(),
  ]);
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const cores = os.cpus().length;
  const load = os.loadavg();
  const cpuUsage = getCpuUsage();

  return {
    hostname: os.hostname(),
    model: getPiModel(),
    ip: getLocalIp(),
    uptime: formatUptime(os.uptime()),
    cpuTemp,
    cpuFreq,
    cpuCores: cores,
    cpuUsage,
    load: {
      one: load[0].toFixed(2),
      five: load[1].toFixed(2),
      fifteen: load[2].toFixed(2),
      stressed: load[0] > cores,
    },
    throttled,
    disk,
    memory: {
      total: Math.round(memTotal / 1024 / 1024) + ' MB',
      free: Math.round(memFree / 1024 / 1024) + ' MB',
      percent: Math.round((1 - memFree / memTotal) * 100) + '%',
    },
  };
}

async function restartKiosk() {
  if (isDevMode) {
    console.log('[Dev] Restart kiosk requested (no-op in dev mode)');
    return;
  }
  // Restart getty@tty1 so the entire DietPi-login → chromium-autostart chain
  // is re-evaluated. Using just `pkill chromium-browser` keeps the running
  // autostart bash alive — and after a `git pull` updates the script on
  // disk, that bash still has the old logic in memory, so kiosk changes
  // wouldn't take effect until reboot. Restarting getty is the lightweight
  // way to reload the script too.
  try {
    await run('systemctl restart getty@tty1.service');
  } catch {
    // Fallback if for some reason we can't restart getty (no permission, etc.)
    await run('pkill -f chromium-browser || true');
  }
}

function reboot() {
  if (isDevMode) {
    console.log('[Dev] Reboot requested (no-op in dev mode)');
    return;
  }
  exec('sudo reboot');
}

module.exports = { getSystemInfo, restartKiosk, reboot };
