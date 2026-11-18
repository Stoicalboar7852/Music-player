// Owns the canvas, the render loop and the active visualizer(s).
//
// Responsibilities: run the shared analysis once per frame, publish it as
// textures, crossfade between visualizers, auto-cycle, and keep the frame rate
// up by scaling the internal resolution.

import { Analysis, BANDS, FFT_SIZE, WAVE_SIZE, type AudioFrame } from '../audio/analysis';
import type { BeatGrid } from '../audio/rhythm';
import type { AudioEngine } from '../audio/engine';
import { FS_HEADER } from '../gl/glsl';
import {
  bindTexture,
  DataTexture,
  drawFullscreen,
  FULLSCREEN_VS,
  Program,
  resetState,
  Target,
  type GL,
} from '../gl/util';
import { DEFAULT_PALETTE, paletteFromImage, type RGB } from './palette';
import { visualizers } from './registry';
import {
  HISTORY_ROWS,
  UNIT_ARTWORK,
  UNIT_HISTORY,
  UNIT_SPECTRUM,
  UNIT_WAVE,
  type RenderFrame,
  type Visualizer,
  type VisualizerDef,
  type VizContext,
} from './types';

export type Quality = 'auto' | 'high' | 'medium' | 'low';

const HISTORY_STEP = 1 / 60;

const CROSSFADE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uA; uniform sampler2D uB; uniform float uMix;
void main() {
  float m = smoothstep(0.0, 1.0, uMix);
  // Push the outgoing image away and pull the incoming one in, slightly.
  vec2 c = vUv - 0.5;
  vec3 a = texture(uA, 0.5 + c * (1.0 - 0.06 * m)).rgb;
  vec3 b = texture(uB, 0.5 + c * (1.0 + 0.06 * (1.0 - m))).rgb;
  o = vec4(mix(a, b, m), 1.0);
}`;

interface Slot {
  def: VisualizerDef;
  viz: Visualizer;
  width: number;
  height: number;
}

export interface RendererStats {
  fps: number;
  frameMs: number;
  scale: number;
  width: number;
  height: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Renderer {
  readonly gl: GL;
  readonly defs = visualizers;
  readonly stats: RendererStats = { fps: 0, frameMs: 0, scale: 1, width: 0, height: 0 };

  /** Fired whenever the active visualizer changes. */
  onChange: (def: VisualizerDef) => void = () => {};
  /** Fired when a visualizer fails to start. */
  onError: (def: VisualizerDef, error: unknown) => void = () => {};
  /** Fired when a visualizer reports a new variant (e.g. a MilkDrop preset). */
  onVariant: (name: string) => void = () => {};

  crossfadeSeconds = 1.6;

  private ctx: VizContext;
  private analysis: Analysis;
  private left = new Float32Array(FFT_SIZE);
  private right = new Float32Array(FFT_SIZE);

  private spectrumTex: DataTexture;
  private waveTex: DataTexture;
  private historyTex: DataTexture;
  private historyHead = 0;
  private historyAcc = 0;

  private artworkTex: WebGLTexture | null = null;
  private blankTex: WebGLTexture;
  private artworkVersion = 0;
  private palette = new Float32Array(12);
  private paletteTarget = new Float32Array(12);

  private current: Slot | null = null;
  private previous: Slot | null = null;
  private fade = 1;
  private fadeA: Target | null = null;
  private fadeB: Target | null = null;
  private crossfade: Program;

  private raf = 0;
  private lastTime = 0;
  private time = 0;
  private running = false;
  // Live use gets a fresh seed each session (so MilkDrop opens on a different preset);
  // offlineRun() reseeds explicitly, so test renders stay deterministic.
  private random = mulberry32((Math.random() * 2 ** 32) >>> 0);

  private quality: Quality = 'auto';
  private scale = 1;
  private scaleMemory = new Map<string, number>();
  private perfSum = 0;
  private perfFrames = 0;
  private goodWindows = 0;
  private noRaiseUntil = 0;
  private probing = false;

  private cycleEnabled = false;
  private cycleSeconds = 30;
  private cycleElapsed = 0;
  private cycleShuffle = true;
  private cycleBag: string[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private engine: AudioEngine,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    const hdr = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('OES_texture_float_linear');

    this.analysis = new Analysis(engine.context.sampleRate);
    this.spectrumTex = new DataTexture(gl, { width: BANDS, height: 1 });
    this.waveTex = new DataTexture(gl, { width: WAVE_SIZE, height: 1, channels: 4 });
    this.historyTex = new DataTexture(gl, { width: BANDS, height: HISTORY_ROWS, wrapT: 'repeat' });
    this.historyTex.upload(new Uint8Array(BANDS * HISTORY_ROWS));

    this.blankTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.crossfade = new Program(gl, FULLSCREEN_VS, CROSSFADE_FS);
    this.setPalette(null, true);

    this.ctx = {
      gl,
      hdr,
      quality: 0.75,
      random: () => this.random(),
      spectrumTex: this.spectrumTex.tex,
      waveTex: this.waveTex.tex,
      historyTex: this.historyTex.tex,
    };

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stop();
    });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    // A hidden window or tab gets no frames. Keep the analysis going (without
    // drawing), so the levels stay live for the tab icon and, in the desktop
    // app, the menu bar or tray visualizer and the mini player.
    this.listenTimer = window.setInterval(() => {
      const now = performance.now();
      if (!this.running || now - this.lastTime < 250) return;
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.engine.read(this.left, this.right);
      const position = this.analysis.hasBeatGrid && this.engine.analysisInput === 'local' ? this.engine.element.currentTime : undefined;
      this.analysis.process(this.left, this.right, dt, position);
    }, 100);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.listenTimer);
  }

  private listenTimer = 0;

  get currentId(): string | null {
    return this.current?.def.id ?? null;
  }

  get currentDef(): VisualizerDef | null {
    return this.current?.def ?? null;
  }

  /** Beats and bars worked out ahead of time for the playing file; null to track live. */
  setBeatGrid(grid: BeatGrid | null) {
    this.analysis.setBeatGrid(grid);
  }

  /** The most recent analysis frame, for UI that wants to react to audio. */
  get audio(): AudioFrame {
    return this.analysis.frame;
  }

  // ------------------------------------------------------------- visualizers

  /** Switches visualizer with a crossfade. Returns false if it failed to start. */
  setVisualizer(id: string, opts: { immediate?: boolean } = {}): boolean {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return false;
    if (this.current?.def.id === id) return true;

    let viz: Visualizer;
    try {
      viz = def.create(this.ctx);
    } catch (error) {
      console.error(`Visualizer "${def.name}" failed to start`, error);
      this.onError(def, error);
      return false;
    }

    // If a fade is already running, drop the outgoing one and fade from the
    // visualizer that was arriving.
    if (this.previous) {
      this.previous.viz.dispose();
      this.previous = null;
    }
    if (this.current) {
      this.scaleMemory.set(this.current.def.id, this.scale);
      if (opts.immediate || this.crossfadeSeconds <= 0) {
        this.current.viz.dispose();
      } else {
        this.previous = this.current;
        this.fade = 0;
      }
    }
    this.current = { def, viz, width: 0, height: 0 };
    if (!this.previous) this.fade = 1;
    if (this.quality === 'auto') this.scale = this.scaleMemory.get(id) ?? this.initialScale();
    this.goodWindows = 0;
    this.perfSum = 0;
    this.perfFrames = 0;
    this.cycleElapsed = 0;
    this.onChange(def);
    return true;
  }

  /** Steps to the next/previous visualizer in gallery order, skipping broken ones. */
  step(direction: 1 | -1) {
    const n = this.defs.length;
    if (n === 0) return;
    let index = this.defs.findIndex((d) => d.id === this.currentId);
    for (let tries = 0; tries < n; tries++) {
      index = (index + direction + n) % n;
      if (this.setVisualizer(this.defs[index].id)) return;
    }
  }

  nextVariant(direction: 1 | -1) {
    const name = this.current?.viz.nextVariant?.(direction);
    if (name) this.onVariant(name);
  }

  get hasVariants(): boolean {
    return Boolean(this.current?.viz.nextVariant);
  }

  setAutoCycle(enabled: boolean, seconds: number, shuffle = true) {
    this.cycleEnabled = enabled;
    this.cycleSeconds = Math.max(5, seconds);
    this.cycleShuffle = shuffle;
    this.cycleElapsed = 0;
  }

  private cycle() {
    if (!this.cycleShuffle) {
      this.step(1);
      return;
    }
    // Shuffle without repeats: draw from a bag until it is empty.
    for (let tries = 0; tries < this.defs.length; tries++) {
      if (this.cycleBag.length === 0) {
        this.cycleBag = this.defs.map((d) => d.id).filter((id) => id !== this.currentId);
        for (let i = this.cycleBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.cycleBag[i], this.cycleBag[j]] = [this.cycleBag[j], this.cycleBag[i]];
        }
      }
      const id = this.cycleBag.pop();
      if (id && this.setVisualizer(id)) return;
    }
  }

  // ------------------------------------------------------- artwork + palette

  /**
   * Uploads cover art for visualizers and derives the colour palette from it.
   * Returns that palette, or null when there is no usable artwork.
   */
  setArtwork(image: HTMLImageElement | ImageBitmap | HTMLCanvasElement | null): RGB[] | null {
    const gl = this.gl;
    if (this.artworkTex) {
      gl.deleteTexture(this.artworkTex);
      this.artworkTex = null;
    }
    this.artworkVersion++;
    if (!image) {
      this.setPalette(null);
      return null;
    }
    try {
      // Covers can be thousands of pixels wide; 768 is plenty and keeps mipmapping cheap.
      const srcW = 'naturalWidth' in image ? image.naturalWidth : image.width;
      const srcH = 'naturalHeight' in image ? image.naturalHeight : image.height;
      const size = Math.min(768, Math.max(srcW, srcH, 1));
      const square = document.createElement('canvas');
      square.width = square.height = size;
      const c2d = square.getContext('2d')!;
      // Centre-crop to a square so non-square art isn't stretched.
      const side = Math.min(srcW, srcH);
      c2d.drawImage(image, (srcW - side) / 2, (srcH - side) / 2, side, side, 0, 0, size, size);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, square);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.artworkTex = tex;
      const palette = paletteFromImage(square);
      this.setPalette(palette);
      return palette;
    } catch (error) {
      // Tainted (cross-origin, no CORS) images cannot be uploaded.
      console.warn('Artwork could not be used by the visualizers', error);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.setPalette(null);
      return null;
    }
  }

  setPalette(colors: RGB[] | null, immediate = false) {
    const src = colors ?? DEFAULT_PALETTE;
    for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) this.paletteTarget[i * 3 + c] = src[i % src.length][c];
    if (immediate) this.palette.set(this.paletteTarget);
  }

  // ---------------------------------------------------------------- quality

  setQuality(quality: Quality) {
    this.quality = quality;
    this.ctx.quality = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : quality === 'low' ? 0.35 : 0.75;
    this.scaleMemory.clear();
    this.scale = quality === 'auto' ? this.initialScale() : quality === 'high' ? 1 : quality === 'medium' ? 0.75 : 0.5;
  }

  private maxDpr(): number {
    return this.quality === 'low' ? 1 : this.quality === 'medium' ? 1.5 : 2;
  }

  /** Auto mode starts no higher than roughly 1440p worth of pixels. */
  private initialScale(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr());
    const pixels = this.canvas.clientWidth * this.canvas.clientHeight * dpr * dpr;
    return Math.min(1, Math.sqrt(3.7e6 / Math.max(1, pixels)));
  }

  private adaptQuality(dtMs: number, now: number) {
    if (dtMs > 250) return; // tab was hidden or the page stalled
    this.perfSum += dtMs;
    this.perfFrames++;
    this.stats.frameMs += (dtMs - this.stats.frameMs) * 0.05;
    this.stats.fps = 1000 / Math.max(1, this.stats.frameMs);
    if (this.perfFrames < 40) return;
    const avg = this.perfSum / this.perfFrames;
    this.perfSum = 0;
    this.perfFrames = 0;
    if (this.quality !== 'auto' || this.fade < 1) return;

    if (avg > 19.5) {
      // Dropping frames: shed pixels. If we had just tried going up, back off for a while.
      if (this.probing) this.noRaiseUntil = now + 45000;
      this.probing = false;
      this.goodWindows = 0;
      this.scale = Math.max(0.4, this.scale * (avg > 26 ? 0.75 : 0.87));
    } else if (avg < 17.6) {
      this.goodWindows++;
      this.probing = false;
      if (this.goodWindows >= 6 && this.scale < 1 && now > this.noRaiseUntil) {
        this.scale = Math.min(1, this.scale * 1.12);
        this.goodWindows = 0;
        this.probing = true;
      }
    } else {
      this.goodWindows = 0;
    }
  }

  private ensureSize(): boolean {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr());
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr * this.scale));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr * this.scale));
    this.stats.scale = this.scale;
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    this.stats.width = w;
    this.stats.height = h;
    return true;
  }

  // ------------------------------------------------------------------ frames

  private tick = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const dtMs = now - this.lastTime;
    this.lastTime = now;
    const dt = Math.min(0.1, Math.max(0.0005, dtMs / 1000));
    this.adaptQuality(dtMs, now);
    this.ensureSize();

    this.engine.read(this.left, this.right);
    // With a beat grid for the playing file, beats follow its playback position exactly.
    const position = this.analysis.hasBeatGrid && this.engine.analysisInput === 'local' ? this.engine.element.currentTime : undefined;
    const audio = this.analysis.process(this.left, this.right, dt, position);

    if (this.cycleEnabled && this.fade >= 1 && audio.presence > 0.2) {
      this.cycleElapsed += dt;
      if (this.cycleElapsed >= this.cycleSeconds) this.cycle();
    }

    this.time += dt;
    this.draw(audio, this.analysis, dt, this.time, null, this.canvas.width, this.canvas.height);
  };

  private uploadAudio(analysis: Analysis, dt: number) {
    this.spectrumTex.upload(analysis.spectrumBytes);
    this.waveTex.upload(analysis.waveBytes);
    this.historyAcc += dt;
    let rows = 0;
    while (this.historyAcc >= HISTORY_STEP && rows < 6) {
      this.historyTex.upload(analysis.spectrumBytes, this.historyHead);
      this.historyHead = (this.historyHead + 1) % HISTORY_ROWS;
      this.historyAcc -= HISTORY_STEP;
      rows++;
    }
    if (this.historyAcc >= HISTORY_STEP) this.historyAcc = 0;
  }

  private bindShared() {
    const gl = this.gl;
    bindTexture(gl, UNIT_ARTWORK, this.artworkTex ?? this.blankTex);
    bindTexture(gl, UNIT_HISTORY, this.historyTex.tex);
    bindTexture(gl, UNIT_SPECTRUM, this.spectrumTex.tex);
    bindTexture(gl, UNIT_WAVE, this.waveTex.tex);
    gl.activeTexture(gl.TEXTURE0);
  }

  private renderSlot(slot: Slot, frame: RenderFrame) {
    const gl = this.gl;
    if (slot.width !== frame.width || slot.height !== frame.height) {
      slot.width = frame.width;
      slot.height = frame.height;
      slot.viz.resize(frame.width, frame.height);
    }
    resetState(gl);
    this.bindShared();
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.target);
    gl.viewport(0, 0, frame.width, frame.height);
    try {
      slot.viz.render(frame);
    } catch (error) {
      console.error(`Visualizer "${slot.def.name}" failed while rendering`, error);
      this.onError(slot.def, error);
    }
  }

  private draw(
    audio: AudioFrame,
    analysis: Analysis,
    dt: number,
    time: number,
    target: WebGLFramebuffer | null,
    width: number,
    height: number,
  ) {
    const gl = this.gl;
    this.uploadAudio(analysis, dt);

    const k = 1 - Math.exp(-dt / 0.5);
    for (let i = 0; i < 12; i++) this.palette[i] += (this.paletteTarget[i] - this.palette[i]) * k;

    const frame: RenderFrame = {
      audio,
      time,
      dt,
      width,
      height,
      target,
      palette: this.palette,
      artwork: this.artworkTex,
      artworkVersion: this.artworkVersion,
      // Half a row behind the write head so linear filtering never straddles
      // the seam between the newest and the oldest row.
      historyHead: (this.historyHead - 1.5 + this.historyAcc / HISTORY_STEP) / HISTORY_ROWS,
    };

    if (!this.current) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    if (this.previous && this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / Math.max(0.05, this.crossfadeSeconds));
      if (!this.fadeA) this.fadeA = new Target(gl, width, height);
      if (!this.fadeB) this.fadeB = new Target(gl, width, height);
      this.fadeA.resize(width, height);
      this.fadeB.resize(width, height);

      this.renderSlot(this.previous, { ...frame, target: this.fadeA.fbo });
      this.renderSlot(this.current, { ...frame, target: this.fadeB.fbo });

      resetState(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, width, height);
      this.crossfade.use().set({ uA: 0, uB: 1, uMix: this.fade });
      bindTexture(gl, 0, this.fadeA.tex);
      bindTexture(gl, 1, this.fadeB.tex);
      drawFullscreen(gl);

      if (this.fade >= 1) {
        this.previous.viz.dispose();
        this.previous = null;
        this.fadeA.dispose();
        this.fadeB.dispose();
        this.fadeA = this.fadeB = null;
      }
    } else {
      this.renderSlot(this.current, frame);
    }
  }

  // ------------------------------------------------------------ test harness

  /**
   * Renders `frames` frames of a fresh instance of one visualizer, fed by a
   * caller-supplied PCM source at a fixed timestep, and returns the final
   * image plus an earlier one. Used to prove that a visualizer both animates
   * and responds to a given kind of sound.
   */
  async offlineRun(
    id: string,
    fill: (time: number, sampleRate: number, left: Float32Array, right: Float32Array) => void,
    opts: { frames?: number; width?: number; height?: number; seed?: number; suppressBeats?: boolean } = {},
  ): Promise<{ final: Uint8Array; earlier: Uint8Array; width: number; height: number; audio: AudioFrame }> {
    const def = this.defs.find((d) => d.id === id);
    if (!def) throw new Error(`Unknown visualizer ${id}`);
    const gl = this.gl;
    const frames = opts.frames ?? 150;
    const width = opts.width ?? 320;
    const height = opts.height ?? 180;
    const wasRunning = this.running;
    this.stop();

    const savedRandom = this.random;
    const savedHead = this.historyHead;
    const savedAcc = this.historyAcc;
    this.random = mulberry32(opts.seed ?? 1234);
    this.historyHead = 0;
    this.historyAcc = 0;
    this.historyTex.upload(new Uint8Array(BANDS * HISTORY_ROWS));

    const analysis = new Analysis(this.engine.context.sampleRate);
    const left = new Float32Array(FFT_SIZE);
    const right = new Float32Array(FFT_SIZE);
    const target = new Target(gl, width, height);
    const slot: Slot = { def, viz: def.create(this.ctx), width: 0, height: 0 };
    if (slot.viz.ready) await slot.viz.ready;

    const savedCurrent = this.current;
    const savedPrevious = this.previous;
    this.current = slot;
    this.previous = null;

    const dt = 1 / 60;
    const read = () => {
      const px = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    let earlier = new Uint8Array(0);
    let audio = analysis.frame;
    for (let i = 0; i < frames; i++) {
      const time = (i + 1) * dt;
      fill(time, analysis.rate, left, right);
      audio = analysis.process(left, right, dt);
      if (opts.suppressBeats) {
        // Same sound, but the visualizer is never told a beat (or a kick, or a drop) happened.
        audio.beat = false;
        audio.beatPulse = 0;
        audio.beatCount = 0;
        audio.kick = 0;
        audio.kickHit = false;
        audio.snare = 0;
        audio.snareHit = false;
        audio.beatPhase = 0;
        audio.downbeat = false;
        audio.dropPulse = 0;
      }
      this.draw(audio, analysis, dt, time, target.fbo, width, height);
      if (i === frames - 13) earlier = read();
    }
    const final = read();

    slot.viz.dispose();
    target.dispose();
    this.current = savedCurrent;
    this.previous = savedPrevious;
    this.random = savedRandom;
    this.historyHead = savedHead;
    this.historyAcc = savedAcc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (wasRunning) this.start();
    return { final, earlier, width, height, audio: { ...audio } };
  }
}
