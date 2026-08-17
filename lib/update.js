const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STASH_TAG = 'orbit-autoupdate';

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

function runStep(cmd, args, dir, onLine, { asRoot = false } = {}) {
  return new Promise((resolve, reject) => {
    // asRoot: skip the drop-to-repo-owner logic — needed for steps that
    // require real root (apt-get in postupdate.sh). No-op when the server
    // isn't root anyway.
    const child = asRoot ? spawn(cmd, args, { cwd: dir }) : spawnInDir(cmd, args, dir);
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

// Run a command and return trimmed stdout. Used for quick state probes
// (git status, git stash list) where we don't want to stream output.
function captureStdout(cmd, args, dir) {
  return new Promise((resolve, reject) => {
    const child = spawnInDir(cmd, args, dir);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else resolve(''); // treat non-zero (e.g. not a repo) as "no output"
    });
  });
}

async function runUpdate(dir, { onLine, onStep }) {
  // If the working tree has uncommitted edits (line-ending drift from manual
  // deploys, half-finished hand-edits, etc.), a plain `git pull --ff-only`
  // aborts with "Your local changes would be overwritten." Stash before the
  // pull and drop the stash after — the kiosk repo is a deployment target,
  // not a dev workspace, so any local diff is by definition out-of-band and
  // safe to discard. We tag the stash so we only drop our own.
  // status --porcelain prints '?? file' for untracked entries; we filter those
  // out because pull --ff-only doesn't fail on untracked files, only on
  // modified tracked ones.
  const status = await captureStdout('git', ['status', '--porcelain'], dir);
  const hasTrackedChanges = status.split('\n').some((l) => l && !l.startsWith('??'));
  let stashed = false;
  if (hasTrackedChanges) {
    onStep('git stash (local edits found)');
    // Only tracked changes — untracked files might be legitimate data
    // (logs, backups, ad-hoc tools) that we don't want to silently drop.
    await runStep('git', ['stash', 'push', '-m', STASH_TAG], dir, onLine);
    stashed = true;
  }

  try {
    onStep('git pull');
    await runStep('git', ['pull', '--ff-only'], dir, onLine);
  } finally {
    if (stashed) {
      // Find our tagged stash by message and drop only that one. If we can't
      // find it (race, manual stash juggling), leave it alone rather than
      // dropping a stash we didn't create.
      const list = await captureStdout('git', ['stash', 'list'], dir);
      const match = list.split('\n').find((l) => l.includes(STASH_TAG));
      if (match) {
        const ref = match.split(':')[0]; // e.g. "stash@{0}"
        onStep('git stash drop');
        await runStep('git', ['stash', 'drop', ref], dir, onLine).catch(() => {});
      }
    }
  }

  onStep('npm install');
  await runStep('npm', ['install', '--production', '--no-audit', '--no-fund'], dir, onLine);

  // System-level provisioning (apt packages, systemd presets — see the
  // script). Runs AFTER git pull so the freshly-pulled version executes,
  // which means a version that ADDS a system dependency reaches devices that
  // are only ever updated through the panel (no SSH available on-site).
  // NOTE: on the update that first introduces a dependency, the *running*
  // update.js may be the old version without this step — the step then runs
  // on the NEXT update. Root only; skipped in dev. Non-fatal: a flaky apt
  // mirror must not block a code deploy — features missing their package
  // degrade gracefully and the next update retries.
  const postScript = path.join(dir, 'scripts', 'postupdate.sh');
  if (typeof process.getuid === 'function' && process.getuid() === 0 && fs.existsSync(postScript)) {
    onStep('system packages');
    try {
      await runStep('bash', [postScript], dir, onLine, { asRoot: true });
    } catch (err) {
      onLine('stderr', '[postupdate] WARNING: ' + err.message + ' — continuing without system provisioning');
    }
  }
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
