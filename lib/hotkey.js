const fs = require('fs');
const path = require('path');
const os = require('os');

// Linux evdev input_event struct (24 bytes on 64-bit):
//   struct timeval time;  // 16 bytes (sec + usec, both 8 bytes)
//   __u16 type;
//   __u16 code;
//   __s32 value;
const EVENT_SIZE = 24;
const EV_KEY = 1;

// Linux input event codes (from include/uapi/linux/input-event-codes.h)
const KEY_LEFTCTRL = 29;
const KEY_RIGHTCTRL = 97;
const KEY_LEFTALT = 56;
const KEY_RIGHTALT = 100;
const KEY_A = 30;

const isLinux = os.platform() === 'linux';
const isDevMode = process.env.ORBIT_DEV === '1';

const INPUT_DIR = '/dev/input';
const DEBOUNCE_MS = 500;

function watchDevice(devicePath, onTrigger, state) {
  let stream;
  try {
    stream = fs.createReadStream(devicePath);
  } catch (err) {
    console.warn('[hotkey] cannot open', devicePath, err.message);
    return null;
  }

  let buf = Buffer.alloc(0);

  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= EVENT_SIZE) {
      const event = buf.slice(0, EVENT_SIZE);
      buf = buf.slice(EVENT_SIZE);

      const type = event.readUInt16LE(16);
      const code = event.readUInt16LE(18);
      const value = event.readInt32LE(20);

      if (type !== EV_KEY) continue;

      // value: 0 = key up, 1 = key down, 2 = key repeat
      const down = value === 1 || value === 2;

      if (code === KEY_LEFTCTRL || code === KEY_RIGHTCTRL) {
        state.ctrl = down;
      } else if (code === KEY_LEFTALT || code === KEY_RIGHTALT) {
        state.alt = down;
      } else if (code === KEY_A && value === 1 && state.ctrl && state.alt) {
        const now = Date.now();
        if (now - state.lastTrigger > DEBOUNCE_MS) {
          state.lastTrigger = now;
          try {
            onTrigger();
          } catch (err) {
            console.warn('[hotkey] trigger callback threw:', err.message);
          }
        }
      }
    }
  });

  stream.on('error', (err) => {
    if (err.code !== 'ENODEV') {
      console.warn('[hotkey] stream error on', devicePath, err.message);
    }
  });

  return stream;
}

function scanAndWatch(onTrigger, openStreams) {
  let entries;
  try {
    entries = fs.readdirSync(INPUT_DIR);
  } catch (err) {
    console.warn('[hotkey] cannot read', INPUT_DIR, err.message);
    return;
  }

  for (const name of entries) {
    if (!/^event\d+$/.test(name)) continue;
    const full = path.join(INPUT_DIR, name);
    if (openStreams.has(full)) continue;

    // Per-device modifier state — events from one keyboard don't leak to another
    const state = { ctrl: false, alt: false, lastTrigger: 0 };
    const stream = watchDevice(full, onTrigger, state);
    if (stream) {
      openStreams.set(full, stream);
      stream.on('close', () => openStreams.delete(full));
    }
  }
}

function start(onTrigger) {
  if (!isLinux || isDevMode) {
    console.log('[hotkey] skipping (non-Linux or dev mode)');
    return;
  }

  const openStreams = new Map();
  scanAndWatch(onTrigger, openStreams);

  // Hot-plug: re-scan when /dev/input changes
  try {
    fs.watch(INPUT_DIR, () => {
      // Small delay — udev events come in bursts
      setTimeout(() => scanAndWatch(onTrigger, openStreams), 200);
    });
  } catch (err) {
    console.warn('[hotkey] cannot watch', INPUT_DIR, err.message);
  }

  console.log('[hotkey] listening for Ctrl+Alt+A on', openStreams.size, 'device(s)');
}

module.exports = { start };
