// Shared bloom + tonemap post-process. A visualizer renders its scene into an
// offscreen target, then calls Bloom.render() to composite it to the output.

import { FS_HEADER } from './glsl';
import { bindTexture, drawFullscreen, FULLSCREEN_VS, Program, Target, type GL } from './util';

const PREFILTER_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv + uTexel * vec2(-1, -1)).rgb + texture(uTex, vUv + uTexel * vec2(1, -1)).rgb;
  c += texture(uTex, vUv + uTexel * vec2(-1, 1)).rgb + texture(uTex, vUv + uTexel * vec2(1, 1)).rgb;
  c /= 8.0;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);
  o = vec4(min(c * contribution, vec3(8.0)), 1.0);
}`;

const DOWN_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv + uTexel * vec2(-1, -1)).rgb + texture(uTex, vUv + uTexel * vec2(1, -1)).rgb;
  c += texture(uTex, vUv + uTexel * vec2(-1, 1)).rgb + texture(uTex, vUv + uTexel * vec2(1, 1)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;

const UP_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-2, 0)).rgb + texture(uTex, vUv + uTexel * vec2(2, 0)).rgb;
  c += texture(uTex, vUv + uTexel * vec2(0, -2)).rgb + texture(uTex, vUv + uTexel * vec2(0, 2)).rgb;
  c += 2.0 * (texture(uTex, vUv + uTexel * vec2(-1, -1)).rgb + texture(uTex, vUv + uTexel * vec2(1, -1)).rgb);
  c += 2.0 * (texture(uTex, vUv + uTexel * vec2(-1, 1)).rgb + texture(uTex, vUv + uTexel * vec2(1, 1)).rgb);
  o = vec4(c / 12.0, 1.0);
}`;

const COMPOSITE_FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uIntensity; uniform float uExposure; uniform float uVignette; uniform float uTonemap;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uIntensity;
  c *= uExposure;
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  c = mix(clamp(c, 0.0, 1.0), aces(c), uTonemap);
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

export interface BloomOptions {
  threshold?: number;
  knee?: number;
  intensity?: number;
  exposure?: number;
  vignette?: number;
  /** 1 = ACES filmic curve, 0 = plain clamp. */
  tonemap?: number;
}

export class Bloom {
  private prefilter: Program;
  private down: Program;
  private up: Program;
  private composite: Program;
  private mips: Target[] = [];

  constructor(
    private gl: GL,
    private hdr: boolean,
    private levels = 5,
  ) {
    this.prefilter = new Program(gl, FULLSCREEN_VS, PREFILTER_FS);
    this.down = new Program(gl, FULLSCREEN_VS, DOWN_FS);
    this.up = new Program(gl, FULLSCREEN_VS, UP_FS);
    this.composite = new Program(gl, FULLSCREEN_VS, COMPOSITE_FS);
  }

  resize(width: number, height: number) {
    const gl = this.gl;
    for (let i = 0; i < this.levels; i++) {
      const w = Math.max(2, width >> (i + 1));
      const h = Math.max(2, height >> (i + 1));
      if (!this.mips[i]) this.mips[i] = new Target(gl, w, h, { format: this.hdr ? 'rgba16f' : 'rgba8' });
      else this.mips[i].resize(w, h);
    }
  }

  /** Composites `scene` plus its bloom into `target` (null = screen). */
  render(
    scene: WebGLTexture,
    sceneWidth: number,
    sceneHeight: number,
    target: WebGLFramebuffer | null,
    width: number,
    height: number,
    opts: BloomOptions = {},
  ) {
    const gl = this.gl;
    const mips = this.mips;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    mips[0].bind();
    this.prefilter.use().set({
      uTex: 0,
      uTexel: [1 / sceneWidth, 1 / sceneHeight],
      uThreshold: opts.threshold ?? 0.6,
      uKnee: opts.knee ?? 0.4,
    });
    bindTexture(gl, 0, scene);
    drawFullscreen(gl);

    this.down.use().set({ uTex: 0 });
    for (let i = 1; i < mips.length; i++) {
      mips[i].bind();
      this.down.set({ uTexel: [1 / mips[i - 1].width, 1 / mips[i - 1].height] });
      bindTexture(gl, 0, mips[i - 1].tex);
      drawFullscreen(gl);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.up.use().set({ uTex: 0 });
    for (let i = mips.length - 1; i > 0; i--) {
      mips[i - 1].bind();
      this.up.set({ uTexel: [0.5 / mips[i].width, 0.5 / mips[i].height] });
      bindTexture(gl, 0, mips[i].tex);
      drawFullscreen(gl);
    }
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    this.composite.use().set({
      uScene: 0,
      uBloom: 1,
      uIntensity: opts.intensity ?? 0.8,
      uExposure: opts.exposure ?? 1,
      uVignette: opts.vignette ?? 0.35,
      uTonemap: opts.tonemap ?? 1,
    });
    bindTexture(gl, 0, scene);
    bindTexture(gl, 1, mips[0].tex);
    drawFullscreen(gl);
  }

  dispose() {
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
    this.composite.dispose();
    for (const m of this.mips) m.dispose();
    this.mips = [];
  }
}

/**
 * The common "draw a scene, then bloom it onto the output" arrangement.
 * The scene can be rendered below output resolution (expensive shaders) and
 * is upscaled by the composite.
 */
export class BloomScene {
  readonly scene: Target;
  private bloom: Bloom;

  constructor(
    private gl: GL,
    hdr: boolean,
    private opts: { depth?: boolean; scale?: number } = {},
  ) {
    this.scene = new Target(gl, 2, 2, { format: hdr ? 'rgba16f' : 'rgba8', depth: opts.depth });
    this.bloom = new Bloom(gl, hdr);
  }

  resize(width: number, height: number) {
    const scale = this.opts.scale ?? 1;
    this.scene.resize(Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale)));
    this.bloom.resize(this.scene.width, this.scene.height);
  }

  /** Binds the scene target; draw the scene after this. */
  begin(clear = true) {
    const gl = this.gl;
    this.scene.bind();
    if (clear) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | (this.opts.depth ? gl.DEPTH_BUFFER_BIT : 0));
    }
  }

  /** Blooms the scene into the frame's output. */
  end(frame: { target: WebGLFramebuffer | null; width: number; height: number }, options?: BloomOptions) {
    this.bloom.render(this.scene.tex, this.scene.width, this.scene.height, frame.target, frame.width, frame.height, options);
  }

  get width() {
    return this.scene.width;
  }

  get height() {
    return this.scene.height;
  }

  dispose() {
    this.scene.dispose();
    this.bloom.dispose();
  }
}
