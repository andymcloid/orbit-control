const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Run a child process as the directory's owner if we're root and the dir is
// owned by a non-root user. Mirrors the pattern in scripts/setup.sh so npm
// install doesn't create root-owned files inside a user-owned repo.
function spawnInDir(cmd, args, dir) {
  const stat = fs.statSync(dir);
  const opts = { cwd: dir };
  if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
    opts.uid = stat.uid;
    opts.gid = stat.gid;
    let home = '/tmp';
    try {
      const passwd = fs.readFileSync('/etc/passwd', 'utf8');
      for (const line of passwd.split('\n')) {
        const parts = line.split(':');
        if (parts.length > 5 && parseInt(parts[2], 10) === stat.uid) { home = parts[5]; break; }
      }
    } catch {}
    opts.env = { ...process.env, HOME: home };
  }
  return spawn(cmd, args, opts);
}

function runStep(cmd, args, dir, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawnInDir(cmd, args, dir);
    const handle = (stream) => (data) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (line.length) onLine(stream, line);
      }
    };
    child.stdout.on('data', handle('stdout'));
    child.stderr.on('data', handle('stderr'));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function runUpdate(dir, { onLine, onStep }) {
  onStep('git pull');
  await runStep('git', ['pull', '--ff-only'], dir, onLine);
  onStep('npm install');
  await runStep('npm', ['install', '--production', '--no-audit', '--no-fund'], dir, onLine);
}

let cachedGitInfo = null;
let cachedAt = 0;

function getGitInfo(dir) {
  // Cache for 30s — git commands are cheap but called every 10s by system-info
  if (cachedGitInfo && Date.now() - cachedAt < 30000) return cachedGitInfo;
  try {
    const stat = fs.statSync(dir);
    const opts = { cwd: dir, encoding: 'utf8', timeout: 2000 };
    if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
      opts.uid = stat.uid;
      opts.gid = stat.gid;
    }
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    cachedGitInfo = { hash, branch };
    cachedAt = Date.now();
    return cachedGitInfo;
  } catch {
    return null;
  }
}

function invalidateGitInfoCache() {
  cachedGitInfo = null;
  cachedAt = 0;
}

module.exports = { runUpdate, getGitInfo, invalidateGitInfoCache };
