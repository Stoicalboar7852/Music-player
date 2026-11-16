// MilkDrop presets via butterchurn. butterchurn renders into its own WebGL
// canvas, which is copied into a texture here so it takes part in crossfades
// like any other visualizer. Both libraries are loaded on first use.

import { WAVE_SIZE } from '../../audio/analysis';
import { FS_HEADER } from '../../gl/glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, defineVisualizer } from '../types';

const BLIT_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uReady; uniform float uTime;
void main() {
  vec3 c = texture(uTex, vUv).rgb * uReady;
  // While the presets load, show a quiet pulse instead of a dead screen.
  float r = length(vUv - 0.5);
  c += (1.0 - uReady) * vec3(0.10, 0.07, 0.16) * (0.6 + 0.4 * sin(uTime * 3.0 - r * 14.0)) * smoothstep(0.6, 0.0, r);
  o = vec4(c, 1.0);
}`;

/** A hand-picked set from the stock pack that look good and react clearly. */
const FAVOURITES = [
  'Flexi - mindblob [shiny mix]',
  'Geiss - Cauldron - painterly 2 (saturation remix)',
  'martin - castle in the air',
  'Flexi, martin + geiss - dedicated to the sherwin maxawow',
  'Rovastar + Loadus + Geiss - FractalDrop (Triple Mix)',
  'martin - witchcraft reloaded',
  'Zylot - Star Ornament',
  'Flexi + Martin - astral projection',
  'Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)',
  'Geiss - Reaction Diffusion 2',
  'martin - frosty caves 2',
  'flexi - bouncing balls [double mindblob neon mix]',
  'Eo.S. + Zylot - skylight (Stained Glass Majesty mix)',
  'Aderrasi - Potion of Spirits',
  'martin - angel flight',
  'Flexi - predator-prey-spirals',
  'cope + martin - mother-of-pearl',
  'Zylot - True Visionary (Final Mix)',
  'martin - reflections on black tiles',
  'Krash + Illusion - Spiral Movement',
  'Phat+fiShbRaiN+Eo.S_Mandala_Chasers_remix',
  'Geiss - Spiral Artifact',
  'martin - mandelbox explorer - high speed demo version',
  'Flexi - smashing fractals [acid etching mix]',
];

/** Seconds a preset plays before blending into the next. */
const PRESET_SECONDS = 28;
const BLEND_SECONDS = 2.7;

interface Butterchurn {
  loadPreset(preset: unknown, blendTime: number): void;
  setRendererSize(width: number, height: number): void;
  render(opts: {
    audioLevels: { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array };
    elapsedTime: number;
  }): void;
}

export default defineVisualizer({
  id: 'milkdrop',
  name: 'MilkDrop',
  family: 'classic',
  order: 60,
  description: 'Genuine MilkDrop presets (via butterchurn). Shift+arrow keys change preset.',
  create(ctx) {
    const { gl } = ctx;
    const blit = new Program(gl, FULLSCREEN_VS, BLIT_FS);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;

    // butterchurn wants 1024 unsigned bytes per channel, 128 = silence.
    const mono = new Uint8Array(WAVE_SIZE).fill(128);
    const left = new Uint8Array(WAVE_SIZE).fill(128);
    const right = new Uint8Array(WAVE_SIZE).fill(128);

    let engine: Butterchurn | null = null;
    let presets: Record<string, unknown> = {};
    let names: string[] = [];
    let index = 0;
    let presetAge = 0;
    let disposed = false;
    let size: [number, number] = [640, 360];

    const load = (i: number, blend: number): string => {
      index = (i + names.length) % names.length;
      presetAge = 0;
      engine?.loadPreset(presets[names[index]], blend);
      return names[index];
    };

    const ready = (async () => {
      const [core, pack] = await Promise.all([import('butterchurn'), import('butterchurn-presets')]);
      if (disposed) return;
      // Both packages are UMD bundles; depending on bundler interop the API can
      // sit one or two `.default`s deep.
      const unwrap = <T>(mod: unknown, method: string): T => {
        let m = mod as Record<string, unknown> | undefined;
        for (let depth = 0; depth < 3 && m && typeof m[method] !== 'function'; depth++) {
          m = m.default as Record<string, unknown> | undefined;
        }
        if (!m || typeof m[method] !== 'function') throw new Error(`butterchurn: ${method} not found`);
        return m as T;
      };
      const butterchurn = unwrap<{
        createVisualizer(context: BaseAudioContext, canvas: HTMLCanvasElement, opts: object): Butterchurn;
      }>(core, 'createVisualizer');
      const presetPack = unwrap<{ getPresets(): Record<string, unknown> }>(pack, 'getPresets');
      presets = presetPack.getPresets();
      names = FAVOURITES.filter((n) => n in presets);
      if (names.length === 0) names = Object.keys(presets);

      // butterchurn only uses the context to build analysers we never feed; audio
      // arrives through render() instead, so a throwaway offline context is enough.
      const context = new OfflineAudioContext(2, 1024, 44100);
      engine = butterchurn.createVisualizer(context, canvas, {
        width: size[0],
        height: size[1],
        pixelRatio: 1,
        textureRatio: 1,
      });
      load(Math.floor(ctx.random() * names.length), 0);
    })();
    ready.catch((error) => console.error('MilkDrop failed to load', error));

    return {
      ready,
      resize(width, height) {
        // Presets are heavy; cap the internal resolution and let the blit upscale.
        const scale = Math.min(1, 1600 / Math.max(width, height));
        size = [Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale))];
        canvas.width = size[0];
        canvas.height = size[1];
        engine?.setRendererSize(size[0], size[1]);
      },
      render(frame) {
        const a = frame.audio;
        if (engine) {
          for (let i = 0; i < WAVE_SIZE; i++) {
            mono[i] = 128 + a.waveform[i] * 110;
            left[i] = 128 + a.waveL[i] * 110;
            right[i] = 128 + a.waveR[i] * 110;
          }
          presetAge += frame.dt;
          // Change preset on a beat once the current one has had its time.
          if (presetAge > PRESET_SECONDS && (a.beat || presetAge > PRESET_SECONDS + 4)) load(index + 1, BLEND_SECONDS);
          engine.render({
            audioLevels: { timeByteArray: mono, timeByteArrayL: left, timeByteArrayR: right },
            elapsedTime: frame.dt,
          });
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
        bindOutput(gl, frame);
        blit.use().set({ uTex: 0, uReady: engine ? 1 : 0, uTime: frame.time });
        bindTexture(gl, 0, texture);
        drawFullscreen(gl);
      },
      nextVariant(direction) {
        if (!engine || names.length === 0) return;
        return load(index + direction, 1.2);
      },
      dispose() {
        disposed = true;
        blit.dispose();
        gl.deleteTexture(texture);
        engine = null;
        // Release butterchurn's GL context promptly rather than waiting for GC.
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  },
});
