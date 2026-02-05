const { exec } = require('child_process');
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
    return (parseInt(t) / 1000).toFixed(1) + '\u00B0C';
  } catch {
    return 'N/A';
  }
}

async function getSystemInfo() {
  const [cpuTemp, disk] = await Promise.all([getCpuTemp(), getDiskInfo()]);
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  return {
    hostname: os.hostname(),
    ip: getLocalIp(),
    uptime: formatUptime(os.uptime()),
    cpuTemp,
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
  await run('pkill -f chromium-browser || true');
}

function reboot() {
  if (isDevMode) {
    console.log('[Dev] Reboot requested (no-op in dev mode)');
    return;
  }
  exec('sudo reboot');
}

module.exports = { getSystemInfo, restartKiosk, reboot };
