const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';
const WPCTL = '/usr/bin/wpctl';
const PW_DUMP = '/usr/bin/pw-dump';

// PipeWire runs inside the kiosk user's login session (started by systemd
// --user on the tty1 autologin), NOT as root — but this server runs as a
// root system service. Root can use the user's PipeWire socket directly
// (DAC override); the only thing wpctl/pw-dump need is XDG_RUNTIME_DIR
// pointing at the right /run/user/<uid>. Find it by looking for a live
// pipewire-0 socket instead of hardcoding a uid.
let cachedRuntimeDir = null;
function findRuntimeDir() {
  if (cachedRuntimeDir && fs.existsSync(path.join(cachedRuntimeDir, 'pipewire-0'))) {
    return cachedRuntimeDir;
  }
  cachedRuntimeDir = null;
  try {
    for (const entry of fs.readdirSync('/run/user')) {
      const dir = path.join('/run/user', entry);
      if (fs.existsSync(path.join(dir, 'pipewire-0'))) {
        cachedRuntimeDir = dir;
        break;
      }
    }
  } catch {}
  return cachedRuntimeDir;
}

function runPw(bin, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const rt = findRuntimeDir();
    if (!rt) return reject(new Error('PipeWire is not running (no pipewire-0 socket in /run/user/*)'));
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        // pw-dump emits the full object graph incl. format params — easily
        // past exec's 1MB default with chromium streams attached.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, XDG_RUNTIME_DIR: rt },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.message = (err.message || '') + (stderr ? ' — ' + stderr.trim() : '');
          return reject(err);
        }
        resolve(String(stdout));
      }
    );
  });
}

// "Volume: 0.85" or "Volume: 0.85 [MUTED]"
async function getVolume() {
  try {
    const out = await runPw(WPCTL, ['get-volume', '@DEFAULT_AUDIO_SINK@']);
    const m = out.match(/Volume:\s*([\d.]+)/);
    return {
      volume: m ? parseFloat(m[1]) : null,
      muted: /\[MUTED\]/.test(out),
    };
  } catch {
    return { volume: null, muted: false };
  }
}

async function getStatus() {
  if (!isLinux || isDevMode) {
    return {
      available: true,
      sinks: [
        { id: 51, name: 'alsa_output.platform-hdmi.stereo', description: 'Built-in Audio (HDMI)', isDefault: true },
        { id: 72, name: 'alsa_output.usb-dongle.analog-stereo', description: 'USB-C Audio Adapter', isDefault: false },
      ],
      volume: 0.8,
      muted: false,
    };
  }

  let dump;
  try {
    dump = JSON.parse(await runPw(PW_DUMP, []));
  } catch (err) {
    return { available: false, sinks: [], error: err.message };
  }

  // The session's default sink is recorded (by node.name, not id) in the
  // metadata object named "default". default.audio.sink is the *effective*
  // default — it tracks default.configured.audio.sink when that target
  // exists and falls back when it's unplugged.
  let defaultName = null;
  for (const obj of dump) {
    if (obj.type === 'PipeWire:Interface:Metadata' && obj.props && obj.props['metadata.name'] === 'default') {
      for (const m of obj.metadata || []) {
        if (m.key === 'default.audio.sink' && m.value) defaultName = m.value.name || null;
      }
    }
  }

  const sinks = [];
  for (const obj of dump) {
    if (obj.type !== 'PipeWire:Interface:Node') continue;
    const p = (obj.info && obj.info.props) || {};
    if (p['media.class'] !== 'Audio/Sink') continue;
    sinks.push({
      id: obj.id,
      name: p['node.name'] || String(obj.id),
      description: p['node.description'] || p['node.nick'] || p['node.name'] || 'Unknown device',
      isDefault: defaultName != null && p['node.name'] === defaultName,
    });
  }

  const vol = await getVolume();
  return { available: true, sinks, volume: vol.volume, muted: vol.muted };
}

async function setDefault(id) {
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId < 0) throw new Error('valid sink id required');
  if (!isLinux || isDevMode) return { ok: true, dev: true };
  // WirePlumber persists the choice (~/.local/state/wireplumber/) so it
  // survives reboots, and live streams that follow the default (chromium's
  // pulse streams do) are moved over immediately.
  await runPw(WPCTL, ['set-default', String(numId)]);
  return { ok: true };
}

async function setVolume(volume) {
  const v = Number(volume);
  if (!(v >= 0 && v <= 1)) throw new Error('volume must be 0-1');
  if (!isLinux || isDevMode) return { ok: true, dev: true };
  await runPw(WPCTL, ['set-volume', '@DEFAULT_AUDIO_SINK@', v.toFixed(2)]);
  // A muted sink at 60% is indistinguishable from broken audio in a kiosk —
  // moving the volume slider always unmutes.
  await runPw(WPCTL, ['set-mute', '@DEFAULT_AUDIO_SINK@', '0']);
  return { ok: true };
}

module.exports = { getStatus, setDefault, setVolume };
