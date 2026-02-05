const { exec } = require('child_process');
const os = require('os');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function getSystemInfo() {
  const [hostname, uptime, cpuTemp, diskInfo, ipAddr] = await Promise.all([
    run('hostname'),
    run('uptime -p'),
    run('cat /sys/class/thermal/thermal_zone0/temp')
      .then(t => (parseInt(t) / 1000).toFixed(1) + '°C')
      .catch(() => 'N/A'),
    run("df -h / | tail -1 | awk '{print $2, $3, $4, $5}'"),
    run('hostname -I')
      .then(s => s.trim().split(/\s+/)[0])
      .catch(() => 'N/A'),
  ]);

  const [diskTotal, diskUsed, diskFree, diskPercent] = diskInfo.split(' ');
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  return {
    hostname,
    ip: ipAddr,
    uptime,
    cpuTemp,
    disk: { total: diskTotal, used: diskUsed, free: diskFree, percent: diskPercent },
    memory: {
      total: Math.round(memTotal / 1024 / 1024) + ' MB',
      free: Math.round(memFree / 1024 / 1024) + ' MB',
      percent: Math.round((1 - memFree / memTotal) * 100) + '%',
    },
  };
}

async function restartKiosk() {
  // Kill chromium; the autostart loop will restart it
  await run('pkill -f chromium-browser || true');
}

function reboot() {
  exec('sudo reboot');
}

module.exports = { getSystemInfo, restartKiosk, reboot };
