// Ringed Planet: a world hanging in space, its rings the spectrum, bass on
// the inside, treble at the rim. The bassline lifts the continents, vocals
// tint the sky, kicks send a shockwave out through the rings, hi-hats
// glitter in them, and each drop swings the camera to a new view.

import { BloomScene } from '../../gl/bloom';
import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, NOISE, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform vec3 uEye;
uniform vec3 uTarget;
uniform float uSpinPlanet;
uniform float uShock;
${HASH}
${NOISE}
${COLOR}
${PALETTE}

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float noise3(vec3 p) {
  return vnoise3(p) * 0.5 + vnoise3(p * 2.1 + 3.7) * 0.3 + vnoise3(p * 4.3 - 1.3) * 0.2;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
  vec3 fw = normalize(uTarget - uEye);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.6 + rt * q.x + up * q.y);
  vec3 ro = uEye;

  // Stars.
  vec3 col = vec3(0.0);
  vec2 sp = vec2(atan(rd.z, rd.x), asin(rd.y)) * 140.0;
  float star = step(0.995, hash21(floor(sp)));
  col += vec3(0.8, 0.85, 1.0) * star * (0.4 + 0.6 * hash21(floor(sp) + 9.0)) * (0.6 + 0.8 * sparkle());

  const float R = 1.0;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float h = b * b - c;
  float tPlanet = h > 0.0 ? -b - sqrt(h) : -1.0;

  // Rings in the planet's equator plane (y = 0).
  float tRing = -ro.y / rd.y;
  vec3 ringCol = vec3(0.0);
  float ringAlpha = 0.0;
  if (tRing > 0.0 && (tPlanet < 0.0 || tRing < tPlanet)) {
    vec3 hp = ro + rd * tRing;
    float r = length(hp.xz);
    if (r > 1.35 && r < 2.6) {
      float f = (r - 1.35) / 1.25;                 // 0 inside .. 1 at the rim
      float level = spectrumAt(0.02 + f * 0.85);
      float lanes = 0.55 + 0.45 * sin(r * 90.0) * sin(r * 37.0);
      float shock = exp(-abs(r - (1.35 + uShock * 1.6)) * 18.0) * (1.0 - uShock);
      // In the planet's shadow?
      vec3 sun = normalize(vec3(-0.6, 0.35, -0.4));
      float sb = dot(hp, sun);
      float shadow = (dot(hp, hp) - sb * sb < R * R && sb < 0.0) ? 0.25 : 1.0;
      ringCol = pal(0.55 + f * 0.5 + 0.2 * colourDrive()) * (0.15 + 1.4 * level * level) * lanes * shadow;
      ringCol += pal(0.1) * shock * 2.5;
      float glitter = step(0.985, hash21(floor(hp.xz * 160.0) + floor(uTime * 20.0))) * sparkle();
      ringCol += vec3(1.0) * glitter * 1.5;
      ringAlpha = clamp((0.25 + 0.7 * level) * lanes, 0.0, 0.95) * smoothstep(1.35, 1.45, r) * smoothstep(2.6, 2.45, r);
    }
  }

  if (tPlanet > 0.0) {
    vec3 hp = ro + rd * tPlanet;
    vec3 n = normalize(hp);
    // Turn the surface.
    float s = sin(uSpinPlanet), cs = cos(uSpinPlanet);
    vec3 pn = vec3(cs * n.x - s * n.z, n.y, s * n.x + cs * n.z);
    float land = noise3(pn * 2.4);
    float lift = 0.48 - 0.12 * lowDrive();
    float isLand = smoothstep(lift, lift + 0.03, land);
    vec3 sea = mix(uPal[2] * 0.25, uPal[3] * 0.35, noise3(pn * 6.0));
    vec3 ground = mix(pal(0.1), pal(0.35), noise3(pn * 9.0)) * (0.55 + 0.45 * land);
    vec3 surf = mix(sea, ground, isLand);
    vec3 sun = normalize(vec3(-0.6, 0.35, -0.4));
    float diff = max(dot(n, -sun), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 sky = pal(0.75 + 0.25 * colourDrive());
    col = surf * (0.05 + 1.1 * diff) + sky * rim * (0.6 + 0.6 * pulse());
    // City lights on the night side, twinkling with the hats.
    float lights = step(0.86, hash31(floor(pn * 60.0))) * isLand * smoothstep(0.1, -0.2, dot(n, -sun));
    col += pal(0.2) * lights * (0.4 + 0.6 * sparkle());
  } else {
    // Atmosphere glow around the limb.
    float miss = sqrt(max(dot(ro, ro) - b * b, 0.0));
    col += pal(0.75 + 0.25 * colourDrive()) * exp(-(miss - R) * 9.0) * step(R, miss) * (0.3 + 0.5 * pulse());
  }
  col = mix(col, ringCol, ringAlpha);
  o = vec4(col, 1.0);
}`;

const VIEWS: [number, number, number][] = [
  [0.35, 0.28, 4.6],
  [-0.9, 0.12, 4.2],
  [2.2, 0.5, 5.2],
  [-2.6, -0.18, 4.8],
];

export default defineVisualizer({
  id: 'planet',
  name: 'Ringed Planet',
  family: '3d',
  order: 140,
  description: 'A world whose rings are the spectrum; kicks send shockwaves through them and drops swing the view.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    const scene = new BloomScene(gl, ctx.hdr, { scale: 0.8 });
    let spin = 0;
    let shock = 1;
    let angle = VIEWS[0][0];
    let height = VIEWS[0][1];
    let dist = VIEWS[0][2];
    return {
      resize(width, height) {
        scene.resize(width, height);
      },
      render(frame) {
        const a = frame.audio;
        spin += frame.dt * (0.05 + 0.08 * a.vocals);
        // A kick starts a new shockwave from the inner ring.
        if (a.kickHit || (a.beat && a.beatSource !== 'onsets')) shock = 0;
        shock = Math.min(1, shock + frame.dt * 1.4);
        const view = VIEWS[a.dropCount % VIEWS.length];
        const ease = Math.min(1, frame.dt * 0.8);
        angle += (view[0] + frame.time * 0.03 - angle) * ease;
        height += (view[1] - height) * ease;
        dist += (view[2] - 0.25 * a.beatPulse - dist) * ease;
        const eye = [Math.sin(angle) * dist, height * dist, Math.cos(angle) * dist];
        scene.begin();
        program.use().set({
          ...commonUniforms(frame),
          uRes: [scene.scene.width, scene.scene.height],
          uEye: eye,
          uTarget: [0, 0, 0],
          uSpinPlanet: spin,
          uShock: shock,
        });
        drawFullscreen(gl);
        scene.end(frame, { threshold: 0.6, knee: 0.5, intensity: 0.8, vignette: 0.3, exposure: 1.1 });
      },
      dispose() {
        program.dispose();
        scene.dispose();
      },
    };
  },
});
