const { spawn } = require('child_process');

// JPEG → H264 (hardware on Pi 5 via v4l2m2m) → fragmented MP4 → WS clients.
// One ffmpeg subprocess feeds all panel viewers. Each subscriber receives the
// init segment (ftyp + moov) once on subscribe, then live fmp4 fragments
// (moof + mdat) as they're produced.

const listeners = new Set();
let ffmpeg = null;
let initSegment = null;
let headerBuf = Buffer.alloc(0);
let currentOpts = null;

// Build ffmpeg argv. Hardware encoder (h264_v4l2m2m) on Pi 5; fall back to
// libx264 via the second arg list if the first proc exits immediately. The
// MP4 movflags produce a streamable fragmented MP4 with the moov at the
// front so MSE can use the first ~kB as its init segment.
function buildArgs(opts, useHardware) {
  // Profile/level handling diverges between encoders:
  //  - h264_v4l2m2m's option parser doesn't accept "baseline" (it wants a
  //    numeric V4L2 constant). Easiest is to omit the profile and let the
  //    hardware encoder pick its default (high on Pi 5).
  //  - libx264 needs explicit level >= 4.0 for 1080p — level 3.1 hits the
  //    "MB rate > level limit" error.
  // The matching codec string on the client side is avc1.640028 (high@4.0).
  const encoderOpts = useHardware
    ? []
    : ['-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high', '-level', '4.0'];
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-vf', 'format=yuv420p',
    '-c:v', useHardware ? 'h264_v4l2m2m' : 'libx264',
    ...encoderOpts,
    '-pix_fmt', 'yuv420p',
    '-b:v', opts.bitrate || '2M',
    '-g', String(opts.gop || 60),
    '-f', 'mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

function spawnFfmpeg(opts, useHardware) {
  const proc = spawn('ffmpeg', buildArgs(opts, useHardware), { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.warn('[ffmpeg]', s);
  });
  return proc;
}

function start(opts, useHardware) {
  if (ffmpeg) return;
  if (useHardware == null) useHardware = true;
  currentOpts = opts;
  initSegment = null;
  headerBuf = Buffer.alloc(0);

  ffmpeg = spawnFfmpeg(opts, useHardware);

  ffmpeg.on('error', (err) => {
    console.warn('[encoder] ffmpeg spawn error:', err.message);
    ffmpeg = null;
  });

  ffmpeg.stdout.on('data', handleStdout);

  ffmpeg.on('exit', (code, sig) => {
    console.log('[encoder] ffmpeg exit code=' + code + ' signal=' + sig + ' (hw=' + useHardware + ')');
    const wasInitialised = !!initSegment;
    const hadListeners = listeners.size > 0;
    ffmpeg = null;
    initSegment = null;
    // If hardware encoder died before we even got an init segment, try the
    // software fallback once. Pi 5 should normally have v4l2m2m available,
    // but if the device node is missing or busy we don't want preview to
    // silently break.
    if (!wasInitialised && useHardware && hadListeners) {
      console.warn('[encoder] hardware encoder failed before init, retrying with libx264');
      currentOpts && start(currentOpts, false);
    }
  });
}

function handleStdout(chunk) {
  if (initSegment) {
    // Steady-state: forward every chunk to all subscribers.
    for (const l of listeners) {
      try { l.onChunk(chunk); } catch {}
    }
    return;
  }
  // Pre-init: accumulate until ftyp + moov have arrived, then split.
  headerBuf = Buffer.concat([headerBuf, chunk]);
  const split = extractInitSegment(headerBuf);
  if (split) {
    initSegment = split.init;
    console.log('[encoder] init segment ready (' + initSegment.length + ' B)');
    for (const l of listeners) {
      try { l.onInit(initSegment); } catch {}
    }
    if (split.media.length) {
      for (const l of listeners) {
        try { l.onChunk(split.media); } catch {}
      }
    }
    headerBuf = Buffer.alloc(0);
  }
}

// Walk MP4 top-level boxes. Init segment = the contiguous ftyp + moov pair at
// the head; everything after is media fragments (moof + mdat).
function extractInitSegment(buf) {
  let offset = 0;
  let initEnd = 0;
  let foundMoov = false;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size === 0) break;            // box extends to EOF — incomplete
    if (size === 1) break;            // 64-bit size; we don't expect these
    if (offset + size > buf.length) break; // incomplete box
    if (type === 'ftyp' || type === 'moov' || type === 'styp') {
      initEnd = offset + size;
      if (type === 'moov') foundMoov = true;
    } else if (foundMoov) {
      // Hit first non-init box after moov → init segment is everything before.
      return { init: buf.slice(0, initEnd), media: buf.slice(initEnd) };
    } else {
      // Saw a moof/mdat before moov? ffmpeg shouldn't do this with our flags.
      return null;
    }
    offset += size;
  }
  return null;
}

function stop() {
  if (!ffmpeg) return;
  try { ffmpeg.stdin.end(); } catch {}
  try { ffmpeg.kill('SIGTERM'); } catch {}
  ffmpeg = null;
  initSegment = null;
  headerBuf = Buffer.alloc(0);
}

function writeFrame(jpegBuf) {
  if (ffmpeg && ffmpeg.stdin.writable && !ffmpeg.stdin.destroyed) {
    try { ffmpeg.stdin.write(jpegBuf); } catch {}
  }
}

function subscribe(listener) {
  listeners.add(listener);
  if (!ffmpeg) start({ bitrate: '2M', gop: 60 });
  if (initSegment) {
    try { listener.onInit(initSegment); } catch {}
  }
}

function unsubscribe(listener) {
  listeners.delete(listener);
  if (listeners.size === 0) stop();
}

function hasSubscribers() { return listeners.size > 0; }

module.exports = { start, stop, writeFrame, subscribe, unsubscribe, hasSubscribers };
