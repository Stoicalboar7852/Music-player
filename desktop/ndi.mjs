// NDI output: sends the presenter's picture as an NDI source that ProPresenter
// (Mac and Windows), FreeShow, OBS, vMix and others can take as a video input.
//
// Phosphor doesn't include NDI's SDK. It loads the NDI Runtime that NDI's free
// "NDI Tools" installs (https://ndi.video/tools/) and calls its C functions
// through koffi. Only the runtime's stable C entry points are used:
//   NDIlib_initialize, NDIlib_destroy, NDIlib_version,
//   NDIlib_send_create, NDIlib_send_destroy, NDIlib_send_send_video_async_v2,
//   NDIlib_send_get_no_connections
// with BGRA frames (Electron's offscreen bitmaps are BGRA).
//
// Where the runtime lives: the folder in the NDI_RUNTIME_DIR_V6 (or _V5)
// environment variable that its installer sets, then the usual install
// places: /usr/local/lib/libndi.dylib on a Mac, "C:\Program Files\NDI\NDI 6
// Runtime\v6" on Windows. PHOSPHOR_NDI_LIBRARY overrides it (for tests).

import { existsSync } from 'node:fs';
import path from 'node:path';

const FILES = {
  win32: ['Processing.NDI.Lib.x64.dll'],
  darwin: ['libndi.dylib', 'libndi.6.dylib', 'libndi.5.dylib'],
  linux: ['libndi.so.6', 'libndi.so.5', 'libndi.so'],
};

/** Where the NDI runtime may be, in the order to try. */
export function ndiCandidates({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (env.PHOSPHOR_NDI_LIBRARY) return [env.PHOSPHOR_NDI_LIBRARY];
  const names = platform === 'win32' && arch === 'arm64' ? ['Processing.NDI.Lib.arm64.dll', ...FILES.win32] : (FILES[platform] ?? []);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const folders = [];
  for (const key of ['NDI_RUNTIME_DIR_V6', 'NDI_RUNTIME_DIR_V5']) {
    if (env[key]) folders.push(env[key], join(env[key], 'lib'));
  }
  if (platform === 'win32') {
    const programs = env.ProgramFiles || 'C:\\Program Files';
    folders.push(join(programs, 'NDI', 'NDI 6 Runtime', 'v6'), join(programs, 'NDI', 'NDI 5 Runtime', 'v5'));
  } else if (platform === 'darwin') {
    folders.push('/usr/local/lib', '/Library/NDI SDK for Apple/lib/macOS', '/opt/homebrew/lib');
  } else {
    folders.push('/usr/local/lib', '/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu');
  }
  const seen = new Set();
  const out = [];
  for (const folder of folders) {
    for (const name of names) {
      const file = join(folder, name);
      if (!seen.has(file)) {
        seen.add(file);
        out.push(file);
      }
    }
  }
  return out;
}

export function findNdiRuntime(options = {}) {
  const exists = options.exists ?? existsSync;
  return ndiCandidates(options).find((file) => exists(file)) ?? null;
}

const fourcc = (code) => code.charCodeAt(0) | (code.charCodeAt(1) << 8) | (code.charCodeAt(2) << 16) | (code.charCodeAt(3) << 24);
const BGRA = fourcc('BGRA');
const PROGRESSIVE = 1;
const TIMECODE_SYNTHESIZE = 9223372036854775807n; // INT64_MAX: "make one up"

let shared = null;

/**
 * Loads the runtime (once). Resolves with { library, version } or throws an
 * Error whose message says what to do.
 */
export async function loadNdi(options = {}) {
  if (shared) return shared;
  const library = findNdiRuntime(options);
  if (!library) {
    const error = new Error('The NDI Runtime is not installed. Install NDI Tools (free, from ndi.video), then turn NDI on again.');
    error.code = 'NDI_MISSING';
    throw error;
  }
  const { default: koffi } = await import('koffi');
  let lib;
  try {
    lib = koffi.load(library);
  } catch (cause) {
    const error = new Error(`The NDI Runtime at ${library} could not be loaded (${cause.message}).`);
    error.code = 'NDI_LOAD';
    throw error;
  }

  const SendCreate = koffi.struct('PhosphorNDIlib_send_create_t', {
    p_ndi_name: 'const char *',
    p_groups: 'const char *',
    clock_video: 'bool',
    clock_audio: 'bool',
  });
  const VideoFrame = koffi.struct('PhosphorNDIlib_video_frame_v2_t', {
    xres: 'int',
    yres: 'int',
    FourCC: 'int',
    frame_rate_N: 'int',
    frame_rate_D: 'int',
    picture_aspect_ratio: 'float',
    frame_format_type: 'int',
    timecode: 'int64_t',
    p_data: 'void *',
    line_stride_in_bytes: 'int',
    p_metadata: 'const char *',
    timestamp: 'int64_t',
  });

  const api = {
    initialize: lib.func('bool NDIlib_initialize(void)'),
    destroy: lib.func('void NDIlib_destroy(void)'),
    version: lib.func('const char *NDIlib_version(void)'),
    sendCreate: lib.func('void *NDIlib_send_create(const PhosphorNDIlib_send_create_t *p_create_settings)'),
    sendDestroy: lib.func('void NDIlib_send_destroy(void *p_instance)'),
    sendVideoAsync: lib.func('void NDIlib_send_send_video_async_v2(void *p_instance, const PhosphorNDIlib_video_frame_v2_t *p_video_data)'),
    connections: lib.func('int NDIlib_send_get_no_connections(void *p_instance, uint32_t timeout_in_ms)'),
  };
  if (!api.initialize()) {
    const error = new Error('NDI could not start on this computer (its runtime needs a processor with SSE4.2).');
    error.code = 'NDI_UNSUPPORTED';
    throw error;
  }
  shared = { koffi, api, VideoFrame, SendCreate, library, version: String(api.version() ?? 'NDI') };
  return shared;
}

/**
 * An NDI source. send() takes BGRA pixels (width × height × 4 bytes, rows
 * top to bottom) and returns at once: NDI compresses and sends the frame on
 * its own thread, from memory this sender owns until the frame after next.
 */
export async function createNdiSender({ name = 'Phosphor', groups = null, ...options } = {}) {
  const ndi = await loadNdi(options);
  const { koffi, api } = ndi;
  const instance = api.sendCreate({ p_ndi_name: name, p_groups: groups, clock_video: false, clock_audio: false });
  if (!instance) throw new Error('NDI could not create the source.');

  // Two frames of native memory, used in turn: NDI reads one while the next is filled.
  let buffers = [];
  let bytes = 0;
  let turn = 0;
  let frames = 0;
  let closed = false;

  const ensure = (size) => {
    if (size === bytes) return;
    // Let NDI finish with the old memory before it goes.
    if (bytes) api.sendVideoAsync(instance, null);
    for (const b of buffers) koffi.free(b.pointer);
    // (Copied in with koffi.encode, not through a view of the memory:
    // Electron's V8 sandbox forbids views onto memory outside it.)
    buffers = [0, 1].map(() => ({ pointer: koffi.alloc('uint8_t', size) }));
    bytes = size;
  };

  return {
    name,
    library: ndi.library,
    version: ndi.version,
    get frames() {
      return frames;
    },
    send(pixels, width, height, fps = 30) {
      if (closed) return;
      const size = width * height * 4;
      if (pixels.length < size) throw new Error(`a ${width}×${height} frame needs ${size} bytes, got ${pixels.length}`);
      ensure(size);
      const buffer = buffers[turn];
      turn ^= 1;
      koffi.encode(buffer.pointer, 'uint8_t', pixels.length === size ? pixels : pixels.subarray(0, size), size);
      api.sendVideoAsync(instance, {
        xres: width,
        yres: height,
        FourCC: BGRA,
        frame_rate_N: Math.round(fps * 1000),
        frame_rate_D: 1000,
        picture_aspect_ratio: width / height,
        frame_format_type: PROGRESSIVE,
        timecode: TIMECODE_SYNTHESIZE,
        p_data: buffer.pointer,
        line_stride_in_bytes: width * 4,
        p_metadata: null,
        timestamp: 0n,
      });
      frames++;
    },
    /** How many receivers are watching (0 when none). */
    connections() {
      return closed ? 0 : api.connections(instance, 0);
    },
    close() {
      if (closed) return;
      closed = true;
      api.sendVideoAsync(instance, null);
      api.sendDestroy(instance);
      for (const b of buffers) koffi.free(b.pointer);
      buffers = [];
    },
  };
}
