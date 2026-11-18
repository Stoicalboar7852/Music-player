// Pulse Orb: a raymarched ball of liquid metal. Bass makes it swell and
// wobble, the spectrum raises ridges around it, treble roughens its skin and
// every beat sends a shockwave through the space behind it.

import { BloomScene } from '../../gl/bloom';
import { AUDIO_SAMPLING, COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uEye;
uniform float uSwell;
${HASH}
${NOISE}
${COLOR}
${PALETTE}
${AUDIO_SAMPLING}

const float PI = 3.14159265;
const float BOUND = 1.7;

float surfaceRadius(vec3 n) {
  float t = uTime;
  // Slow lobes: the body of the wobble, scaled by bass.
  float lobes = sin(n.x * 2.6 + t * 1.1) * sin(n.y * 2.9 - t * 0.8) * sin(n.z * 2.4 + t * 1.3);
  // Each patch of skin listens to its own frequency band and bulges with it,
  // so the surface behaves like ferrofluid rather than a striped ball.
  float region = vnoise3(n * 2.3 + vec3(0.0, t * 0.06, 0.0));
  float bx = 0.04 + region * 0.88;
  // A wide blur across neighbouring bands keeps the surface smooth instead of terraced.
  float band = (spectrum(bx - 0.08) + spectrum(bx - 0.04) + spectrum(bx) + spectrum(bx + 0.04) + spectrum(bx + 0.08)) * 0.2;
  // Fine grain, driven by treble.
  float grain = vnoise3(n * 8.0 + vec3(0.0, t * 0.9, 0.0)) - 0.5;
  return 1.0 + uSwell + lobes * (0.05 + 0.2 * lowDrive()) + band * band * 0.24 + grain * (0.01 + 0.1 * uTreble);
}

float map(vec3 p) {
  float r = length(p);
  return (r - surfaceRadius(p / max(r, 1e-4))) * 0.5;
}

vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.004, -0.004);
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

// The surroundings the orb reflects: a dark studio with palette-coloured
// lights and a few hard-edged strip lights that give the metal crisp highlights.
vec3 environment(vec3 d) {
  vec3 c = vec3(0.0);
  c += pal(0.0) * pow(max(dot(d, normalize(vec3(0.8, 0.5, 0.3))), 0.0), 8.0) * 1.1;
  c += pal(0.25) * pow(max(dot(d, normalize(vec3(-0.7, 0.2, -0.6))), 0.0), 7.0) * 0.9;
  c += pal(0.5) * pow(max(dot(d, normalize(vec3(0.1, -0.9, 0.4))), 0.0), 6.0) * 0.6;
  c += pal(0.75) * pow(max(dot(d, normalize(vec3(-0.2, 0.9, -0.3))), 0.0), 12.0) * 1.2;
  float az = atan(d.z, d.x);
  float strips = smoothstep(0.035, 0.015, abs(fract(az * 0.9549 + 0.25) - 0.5)) * smoothstep(0.75, 0.35, abs(d.y));
  c += mix(pal(0.6 + 0.15 * colourDrive()), vec3(1.0), 0.5) * strips * (0.5 + 0.6 * uLevel + 0.5 * colourDrive());
  c += vec3(0.9, 0.95, 1.0) * smoothstep(0.03, 0.01, abs(d.y - 0.62)) * 0.5;
  c += vec3(0.025) * (0.5 + 0.5 * d.y);
  return c;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = uEye;
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.7 + rt * p.x + up * p.y);

  // ---- background
  float closest = length(cross(rd, ro));           // how near this ray passes to the centre
  vec3 col = environment(rd) * 0.05;
  // nebula haze
  float haze = fbm(rd.xy * 2.2 + vec2(uTime * 0.03, 0.0)) * fbm(rd.yz * 3.1 - uTime * 0.02);
  col += pal(0.1 + haze) * haze * (0.10 + 0.15 * uMid + 0.2 * colourDrive());
  // halo hugging the orb
  col += pal(0.3) * exp(-max(closest - 1.0, 0.0) * 3.4) * (0.07 + 0.3 * lowDrive() + 0.35 * pulse());
  // beat shockwave: a ring racing outward
  float age = -log(max(uBeat, 1e-3)) / 5.5;
  float ring = 1.15 + age * 3.4;
  col += pal(0.55) * smoothstep(0.10, 0.0, abs(closest - ring)) * uBeat * 1.4;
  // distant sparks that glint with the treble
  vec3 sg = rd * 55.0;
  float spark = step(0.992, hash31(floor(sg))) * smoothstep(0.3, 0.05, length(fract(sg) - 0.5));
  col += vec3(0.9, 0.95, 1.0) * spark * (0.25 + 1.2 * uTreble + 1.6 * sparkle());

  // ---- the orb: only march rays that enter its bounding sphere
  float b = dot(ro, rd);
  float disc = b * b - (dot(ro, ro) - BOUND * BOUND);
  if (disc > 0.0) {
    float sq = sqrt(disc);
    float t = max(-b - sq, 0.0);
    float tFar = -b + sq;
    bool hit = false;
    for (int i = 0; i < 56; i++) {
      float d = map(ro + rd * t);
      if (d < 0.0018 * t) { hit = true; break; }
      t += d;
      if (t > tFar) break;
    }
    if (hit) {
      vec3 pos = ro + rd * t;
      vec3 n = normalAt(pos);
      vec3 refl = reflect(rd, n);
      float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      float height = length(pos) - 1.0;

      // Liquid metal: mostly reflection, tinted by an iridescent film.
      vec3 film = pal(0.15 + fres * 0.5 + height * 1.6 + uTime * 0.02);
      vec3 surf = environment(refl) * mix(vec3(0.5), film, 0.7);
      surf += film * (0.02 + 1.1 * max(height - 0.03, 0.0));      // raised bulges glow from within
      surf += film * fres * fres * (0.5 + 1.3 * pulse());         // rim
      surf += vec3(1.0) * pow(max(dot(refl, normalize(vec3(0.5, 0.8, 0.4))), 0.0), 90.0) * 1.5;
      col = surf;
    }
  }
  o = vec4(col, 1.0);
}`;

export default defineVisualizer({
  id: 'orb',
  name: 'Pulse Orb',
  family: 'modern',
  order: 80,
  description: 'A raymarched liquid-metal sphere that swells with bass and ripples with the spectrum.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    // Raymarching is the most expensive thing here: render below output size and upscale.
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.55 + 0.4 * ctx.quality });
    let orbit = 0;
    let swell = 0;
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        orbit += frame.dt * (0.14 + 0.2 * a.mid + 0.25 * a.vocals);
        // A spring so the swell overshoots a little on each hit.
        swell += (0.06 * Math.max(a.bassline, a.bass * 0.5) + 0.16 * Math.max(a.kick, a.bassHit * 0.6) - swell) * Math.min(1, frame.dt * 14);
        const dist = 5.3 - 0.3 * Math.max(a.kick, a.beatPulse * 0.85);
        const eye = [Math.sin(orbit) * dist, 0.5 * Math.sin(frame.time * 0.21), Math.cos(orbit) * dist];
        scene.begin(false);
        program.use().set({ ...commonUniforms(frame), uRes: [scene.width, scene.height], uEye: eye, uSwell: swell });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.8, knee: 0.5, intensity: 0.55, vignette: 0.5, exposure: 1.05 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
