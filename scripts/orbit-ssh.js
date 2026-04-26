#!/usr/bin/env node
// OrbitControl SSH wrapper (Node, cross-platform)
// Reads ../.orbit.local for credentials and runs a command on the Pi via ssh2.
//
// Usage:
//   node scripts/orbit-ssh.js "uptime"
//   node scripts/orbit-ssh.js "sudo -S systemctl status orbit-control --no-pager"
//   ./scripts/orbit-ssh.sh "..."   (thin bash wrapper that calls this)

const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, '.orbit.local');

if (!fs.existsSync(CONFIG)) {
  console.error(`Error: ${CONFIG} not found.`);
  console.error(`Copy ${path.join(ROOT, '.orbit.local.example')} to .orbit.local and edit.`);
  process.exit(2);
}

const env = parseEnvFile(fs.readFileSync(CONFIG, 'utf8'));
const HOST = env.ORBIT_HOST;
const USER = env.ORBIT_USER;
const KEY = env.ORBIT_KEY;
const PASS = env.ORBIT_PASS;
const SUDO_PASS = env.ORBIT_SUDO_PASS;

if (!HOST) die('ORBIT_HOST not set in .orbit.local');
if (!USER) die('ORBIT_USER not set in .orbit.local');
if (!KEY && !PASS) die('Set either ORBIT_KEY or ORBIT_PASS in .orbit.local');

const cmd = process.argv.slice(2).join(' ');
if (!cmd) die('Usage: node scripts/orbit-ssh.js "<command>"');

let Client;
try {
  ({ Client } = require('ssh2'));
} catch {
  console.error('Error: ssh2 package not installed. Run `npm install` first.');
  process.exit(2);
}

const conn = new Client();

const connectOpts = {
  host: HOST,
  port: 22,
  username: USER,
  readyTimeout: 30000,
  keepaliveInterval: 15000,
  algorithms: {
    serverHostKey: ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
  },
};

// Resolve host to IPv4. Node's dns.lookup on Windows doesn't use the mDNS resolver
// that ping uses, so .local hostnames fail with ENOTFOUND. Try dns.lookup first,
// then fall back to parsing `ping -4` output (which DOES use Windows mDNS).
function resolveIPv4(host, cb) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return cb(null, host);
  dns.lookup(host, { all: true }, (err, addresses) => {
    if (!err && addresses && addresses.length) {
      const v4 = addresses.find((a) => a.family === 4);
      if (v4) return cb(null, v4.address);
    }
    // dns.lookup didn't return an IPv4 (or failed) — try parsing `ping -4` which
    // does hit Windows mDNS for .local hostnames.
    try {
      const isWin = process.platform === 'win32';
      const args = isWin ? ['-4', '-n', '1', '-w', '2000', host] : ['-4', '-c', '1', '-W', '2', host];
      const out = execFileSync('ping', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) return cb(null, m[1]);
      cb(new Error('ping returned no IPv4'));
    } catch (e) {
      cb(err || e);
    }
  });
}

if (KEY) {
  const keyPath = expandHome(KEY);
  if (!fs.existsSync(keyPath)) die(`ORBIT_KEY file not found: ${keyPath}`);
  connectOpts.privateKey = fs.readFileSync(keyPath);
  if (env.ORBIT_KEY_PASSPHRASE) connectOpts.passphrase = env.ORBIT_KEY_PASSPHRASE;
} else {
  connectOpts.password = PASS;
  // Some Pi sshd configs disable password auth via PAM; allow keyboard-interactive too
  connectOpts.tryKeyboard = true;
}

let exitCode = 0;

conn.on('ready', () => {
  // No PTY — sudo -S reads from stdin without one, and PTY mode echoes the
  // password back into stdout which we definitely don't want.
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('exec error:', err.message);
      conn.end();
      process.exit(1);
    }

    if (SUDO_PASS) {
      // Pipe sudo password to stdin so `sudo -S ...` works without prompting
      stream.write(SUDO_PASS + '\n');
    }

    stream.on('close', (code) => {
      exitCode = code || 0;
      conn.end();
    });
    stream.stdout.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
  });
});

conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
  finish(prompts.map(() => PASS || ''));
});

conn.on('error', (err) => {
  console.error('ssh error:', err.message);
  process.exit(1);
});

conn.on('end', () => process.exit(exitCode));
conn.on('close', () => process.exit(exitCode));

resolveIPv4(HOST, (err, ip) => {
  if (err) {
    console.error(`Error: could not resolve ${HOST} to IPv4: ${err.message}`);
    process.exit(2);
  }
  connectOpts.host = ip;
  conn.connect(connectOpts);
});

// ── helpers ──

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function expandHome(p) {
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return p;
}

function die(msg) {
  console.error('Error: ' + msg);
  process.exit(2);
}
