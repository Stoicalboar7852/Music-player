// Event Horizon: a black hole with a glowing accretion disk, its light bent
// round the hole so the far side of the disk shows above and below it. The
// disk's radius is the spectrum (bass on the inside, treble at the edge),
// kicks flare it, the beat lights the thin ring of light circling the hole,
// the bassline churns the disk, the vocals shift its colour and hi-hats make
// the stars behind it twinkle.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uSwirl;
uniform float uYaw;
uniform float uFlare;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

const float RS = 0.32;
const float DISK_IN = 0.62;
const float DISK_OUT = 2.1;

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

vec3 stars(vec3 d) {
  vec2 sph = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0)));
  vec2 g = floor(sph * vec2(140.0, 140.0));
  float s = step(0.995, hash21(g)) * (0.3 + 0.7 * hash21(g + 2.0));
  float tw = 0.5 + 1.5 * sparkle() * step(0.5, hash21(g + floor(uTime * 10.0)));
  vec3 neb = mix(pal(0.6), pal(0.85), fbm(sph * 3.0)) * 0.03 * fbm(sph * 2.0 + 4.0);
  return vec3(0.85, 0.9, 1.0) * s * tw + neb;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 ro = vec3(sy * 4.2, 0.55, -cy * 4.2);
  vec3 fw = normalize(-ro + vec3(0.0, 0.05, 0.0));
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 v = normalize(fw + uv.x * rt * 0.9 + uv.y * up * 0.9);

  vec3 p = ro;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float minR = 100.0;
  bool captured = false;
  for (int i = 0; i < 110; i++) {
    float r = length(p);
    minR = min(minR, r);
    if (r < RS) { captured = true; break; }
    float h = 0.03 + 0.05 * r;
    // Light falls toward the hole: bend the ray (a simple stand-in for relativity).
    vec3 acc = -p / (r * r * r) * RS * 1.15;
    vec3 np = p + v * h;
    v = normalize(v + acc * h);
    if (p.y * np.y < 0.0) {
      vec3 hp = mix(p, np, p.y / (p.y - np.y));
      float hr = length(hp.xz);
      if (hr > DISK_IN && hr < DISK_OUT) {
        float band = (hr - DISK_IN) / (DISK_OUT - DISK_IN);
        float ang = atan(hp.z, hp.x);
        float turn = uSwirl / (hr * hr);
        float swirl = fbm(vec2(ang * 2.5 + turn, hr * 5.0));
        float streaks = fbm(vec2(ang * 9.0 + turn * 2.0, hr * 18.0));
        float density = (0.3 + 0.7 * swirl) * (0.7 + 0.3 * streaks);
        density *= smoothstep(DISK_IN, DISK_IN + 0.12, hr) * smoothstep(DISK_OUT, DISK_OUT - 0.5, hr);
        vec3 tangent = normalize(vec3(-hp.z, 0.0, hp.x));
        float doppler = clamp(1.0 + 0.7 * dot(tangent, -v), 0.3, 1.8);
        vec3 hot = mix(vec3(1.0, 0.92, 0.8), mix(vec3(1.0, 0.45, 0.15), pal(0.05 + 0.3 * colourDrive()), 0.5), band);
        float level = spectrumAt(0.02 + band * 0.92);
        vec3 c = hot * density * doppler * doppler * (0.35 + 1.8 * level + 1.2 * uFlare);
        // Hot spots in the disk glint with the hi-hats.
        c += vec3(1.0, 0.95, 0.85) * step(0.9, hash21(floor(vec2(ang * 30.0 + turn * 3.0, hr * 30.0)) + floor(uTime * 12.0))) * sparkle() * density * 1.5;
        col += c * (1.0 - alpha);
        alpha += density * 0.6 * (1.0 - alpha);
      }
    }
    p = np;
    if (r > 9.0) break;
  }
  if (!captured) col += stars(v) * (1.0 - alpha);
  // The photon ring, lit on the beat.
  col += mix(vec3(1.0, 0.85, 0.6), pal(0.1), 0.3) * exp(-pow((minR - RS * 1.5) * 18.0, 2.0)) * (0.25 + 1.6 * onBeat(0.3) * pulse()) * (captured ? 0.0 : 1.0);

  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.5 * dot(c, c);
  o = vec4(aces(col * 1.1), 1.0);
}`;

export default defineVisualizer({
  id: 'blackhole',
  name: 'Event Horizon',
  family: '3d',
  order: 235,
  description: "A black hole bending its accretion disk's light: the disk is the spectrum, kicks flare it, beats light the photon ring.",
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let swirl = 0;
    let yaw = 0.6;
    let flare = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        swirl += dt * (0.6 + 2.5 * Math.max(a.bassline, a.bass * 0.5));
        yaw += dt * 0.03 + (a.drop ? 0.8 : 0);
        flare = Math.max(flare * Math.exp(-dt * 5), Math.max(a.kick, a.beatPulse * 0.85));
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uSwirl: swirl, uYaw: yaw, uFlare: flare });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
