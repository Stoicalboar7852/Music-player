// Small WebGL2 helpers shared by the renderer and every visualizer.

export type GL = WebGL2RenderingContext;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

type UniformValue = number | boolean | ArrayLike<number>;

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    const numbered = source
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(4)}: ${line}`)
      .join('\n');
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed:\n${log}\n${numbered}`);
  }
  return shader;
}

/** A linked program with name-based, type-aware uniform setting. */
export class Program {
  readonly handle: WebGLProgram;
  private setters = new Map<string, (v: UniformValue) => void>();

  constructor(
    private gl: GL,
    vertex: string,
    fragment: string,
    opts: { feedback?: string[]; attribs?: Record<string, number> } = {},
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertex);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    for (const [name, loc] of Object.entries(opts.attribs ?? {})) gl.bindAttribLocation(program, loc, name);
    if (opts.feedback) gl.transformFeedbackVaryings(program, opts.feedback, gl.SEPARATE_ATTRIBS);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link failed: ${log}`);
    }
    this.handle = program;
    this.introspect();
  }

  private introspect() {
    const gl = this.gl;
    const count = gl.getProgramParameter(this.handle, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.handle, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(this.handle, info.name);
      if (!loc) continue;
      const isArray = info.size > 1;
      let set: (v: UniformValue) => void;
      switch (info.type) {
        case gl.FLOAT:
          set = isArray ? (v) => gl.uniform1fv(loc, v as Float32Array) : (v) => gl.uniform1f(loc, +(v as number));
          break;
        case gl.FLOAT_VEC2:
          set = (v) => gl.uniform2fv(loc, v as Float32Array);
          break;
        case gl.FLOAT_VEC3:
          set = (v) => gl.uniform3fv(loc, v as Float32Array);
          break;
        case gl.FLOAT_VEC4:
          set = (v) => gl.uniform4fv(loc, v as Float32Array);
          break;
        case gl.FLOAT_MAT3:
          set = (v) => gl.uniformMatrix3fv(loc, false, v as Float32Array);
          break;
        case gl.FLOAT_MAT4:
          set = (v) => gl.uniformMatrix4fv(loc, false, v as Float32Array);
          break;
        case gl.INT_VEC2:
          set = (v) => gl.uniform2iv(loc, v as Int32Array);
          break;
        default:
          // int, bool and every sampler type
          set = isArray ? (v) => gl.uniform1iv(loc, v as Int32Array) : (v) => gl.uniform1i(loc, +(v as number));
      }
      this.setters.set(name, set);
    }
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  /** Sets any uniforms the program actually has; unknown names are ignored. */
  set(values: Record<string, UniformValue | undefined>): this {
    for (const name in values) {
      const v = values[name];
      if (v === undefined) continue;
      this.setters.get(name)?.(v);
    }
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.handle);
  }
}

export type TargetFormat = 'rgba8' | 'rgba16f' | 'rg16f' | 'r16f';

export interface TargetOptions {
  format?: TargetFormat;
  filter?: 'linear' | 'nearest';
  wrap?: 'clamp' | 'repeat' | 'mirror';
  depth?: boolean;
}

function formatInfo(gl: GL, format: TargetFormat): [internal: number, fmt: number, type: number] {
  switch (format) {
    case 'rgba16f':
      return [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
    case 'rg16f':
      return [gl.RG16F, gl.RG, gl.HALF_FLOAT];
    case 'r16f':
      return [gl.R16F, gl.RED, gl.HALF_FLOAT];
    default:
      return [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
  }
}

function wrapMode(gl: GL, wrap: TargetOptions['wrap']): number {
  return wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
}

/** A colour texture attached to a framebuffer, optionally with a depth buffer. */
export class Target {
  readonly fbo: WebGLFramebuffer;
  readonly tex: WebGLTexture;
  private depthBuffer: WebGLRenderbuffer | null = null;
  width = 0;
  height = 0;

  constructor(
    private gl: GL,
    width: number,
    height: number,
    private opts: TargetOptions = {},
  ) {
    this.fbo = gl.createFramebuffer()!;
    this.tex = gl.createTexture()!;
    const filter = opts.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrap = wrapMode(gl, opts.wrap);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (opts.depth) this.depthBuffer = gl.createRenderbuffer()!;
    this.resize(width, height);
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    const [internal, fmt, type] = formatInfo(gl, this.opts.format ?? 'rgba8');
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, fmt, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (this.depthBuffer) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  dispose() {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.tex);
    if (this.depthBuffer) this.gl.deleteRenderbuffer(this.depthBuffer);
  }
}

/** Two targets that swap roles, for feedback effects and simulations. */
export class PingPong {
  read: Target;
  write: Target;

  constructor(gl: GL, width: number, height: number, opts: TargetOptions = {}) {
    this.read = new Target(gl, width, height, opts);
    this.write = new Target(gl, width, height, opts);
  }

  swap() {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  resize(width: number, height: number) {
    this.read.resize(width, height);
    this.write.resize(width, height);
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

export interface DataTextureOptions {
  width: number;
  height: number;
  /** Channel count: 1 = R8, 2 = RG8, 4 = RGBA8. */
  channels?: 1 | 2 | 4;
  filter?: 'linear' | 'nearest';
  wrapS?: 'clamp' | 'repeat' | 'mirror';
  wrapT?: 'clamp' | 'repeat' | 'mirror';
}

/** An 8-bit texture that gets re-uploaded from a typed array (audio data, lookup tables). */
export class DataTexture {
  readonly tex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  private internal: number;
  private format: number;

  constructor(
    private gl: GL,
    opts: DataTextureOptions,
  ) {
    this.width = opts.width;
    this.height = opts.height;
    const channels = opts.channels ?? 1;
    this.internal = channels === 1 ? gl.R8 : channels === 2 ? gl.RG8 : gl.RGBA8;
    this.format = channels === 1 ? gl.RED : channels === 2 ? gl.RG : gl.RGBA;
    this.tex = gl.createTexture()!;
    const filter = opts.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.internal, this.width, this.height, 0, this.format, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode(gl, opts.wrapS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode(gl, opts.wrapT));
  }

  /** Uploads `data` to the whole texture, or to a single row when `row` is given. */
  upload(data: Uint8Array, row?: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (row === undefined) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, this.format, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, this.width, 1, this.format, gl.UNSIGNED_BYTE, data);
    }
  }

  dispose() {
    this.gl.deleteTexture(this.tex);
  }
}

let emptyVaos = new WeakMap<GL, WebGLVertexArrayObject>();

/** Draws one triangle covering the viewport. Pair with FULLSCREEN_VS. */
export function drawFullscreen(gl: GL) {
  let vao = emptyVaos.get(gl);
  if (!vao) {
    vao = gl.createVertexArray()!;
    emptyVaos.set(gl, vao);
  }
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function bindTexture(gl: GL, unit: number, tex: WebGLTexture | null) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** Puts GL back into the state every visualizer may assume at the start of a frame. */
export function resetState(gl: GL) {
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.depthMask(true);
  gl.colorMask(true, true, true, true);
  gl.blendEquation(gl.FUNC_ADD);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);
}
