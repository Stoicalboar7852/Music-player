// GLSL snippets shared between visualizers. Concatenate into a fragment shader
// after the `#version` line and precision statement.

export const FS_HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
`;

/** Uniforms every visualizer gets from `commonUniforms()`. */
export const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform float uDt;
uniform vec2 uRes;
uniform float uLevel;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBassHit;
uniform float uMidHit;
uniform float uTrebleHit;
uniform float uBeat;
uniform float uBeatCount;
uniform vec3 uPal[4];
uniform sampler2D uSpectrum;
uniform sampler2D uWave;
`;

export const HASH = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float hash31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`;

export const NOISE = /* glsl */ `
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.3, -9.1); a *= 0.5; }
  return s;
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash31(i), b = hash31(i + vec3(1, 0, 0)), c = hash31(i + vec3(0, 1, 0)), d = hash31(i + vec3(1, 1, 0));
  float e = hash31(i + vec3(0, 0, 1)), g = hash31(i + vec3(1, 0, 1)), h = hash31(i + vec3(0, 1, 1)), k = hash31(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
`;

export const COLOR = /* glsl */ `
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Cyclic gradient through the four artwork palette colours. Needs COMMON_UNIFORMS. */
export const PALETTE = /* glsl */ `
vec3 pal(float t) {
  t = fract(t) * 4.0;
  int i = int(t);
  float f = smoothstep(0.0, 1.0, fract(t));
  return mix(uPal[i & 3], uPal[(i + 1) & 3], f);
}
`;

/** Spectrum (0..1 across the audible range, log-spaced) and waveform lookups. */
export const AUDIO_SAMPLING = /* glsl */ `
float spectrum(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
float wave(float x) { return texture(uWave, vec2(clamp(x, 0.0, 1.0), 0.5)).r * 2.0 - 1.0; }
vec2 waveLR(float x) { return texture(uWave, vec2(clamp(x, 0.0, 1.0), 0.5)).gb * 2.0 - 1.0; }
`;
