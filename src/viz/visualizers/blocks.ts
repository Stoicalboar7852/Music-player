// Block Valley: a flight down a river valley made of blocks. The hills on
// either side are a giant equalizer, bass on the left and treble on the
// right, stacking up block by block with their bands. Kicks pop columns up a
// block, beats light the block edges, the bassline sets the flight's bob and
// pace, the vocals warm the sky toward sunset, and hi-hats glint on the water
// and in the night stars. Each drop turns day to night and back.
// An original voxel landscape.

import { COLOR, COMMON_UNIFORMS, FS_HEADER, HASH, PALETTE, RHYTHM } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
${RHYTHM}
uniform float uTravel;
uniform float uBob;
uniform float uBounce;
uniform float uNight;
${HASH}
${COLOR}
${PALETTE}

const float WATER = 1.55;

float spectrumAt(float x) { return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}

// Height of the column of blocks in cell c (whole blocks).
float columnHeight(vec2 c) {
  float n = vn(c * 0.06) * 0.65 + vn(c * 0.15 + 7.3) * 0.35;
  float side = smoothstep(2.5, 9.0, abs(c.x));                    // the river valley
  float h = floor(n * 7.0 * side + side * 1.5);
  // The equalizer: bass on the left bank, treble on the right.
  float band = clamp((c.x + 26.0) / 52.0, 0.0, 1.0);
  h += floor(spectrumAt(0.02 + band * 0.92) * 8.0 * smoothstep(3.0, 9.0, abs(c.x)));
  // A kick pops some columns up a block.
  h += step(hash21(c + 0.5), uBounce * 0.7);
  return h;
}

vec3 skyColor(vec3 rd) {
  vec3 dayTop = vec3(0.25, 0.48, 0.85), dayLow = mix(vec3(0.75, 0.86, 0.95), pal(0.1) * 1.1, 0.35);
  vec3 dusk = mix(vec3(1.0, 0.55, 0.3), pal(0.0), 0.4);
  vec3 nightTop = vec3(0.01, 0.015, 0.05), nightLow = vec3(0.05, 0.06, 0.14) + pal(0.6) * 0.05;
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 day = mix(dayLow, dayTop, smoothstep(0.0, 0.5, y));
  day = mix(day, dusk, (0.15 + 0.7 * colourDrive()) * (1.0 - smoothstep(0.0, 0.35, y)));
  vec3 night = mix(nightLow, nightTop, smoothstep(0.0, 0.5, y));
  night += dusk * 0.25 * colourDrive() * (1.0 - smoothstep(0.0, 0.3, y));
  return mix(day, night, uNight);
}

vec3 sky(vec3 rd) {
  vec3 col = skyColor(rd);
  // A square sun (or moon) low ahead.
  vec3 sunDir = normalize(vec3(0.35, 0.22, 1.0));
  vec3 right = normalize(cross(vec3(0, 1, 0), sunDir));
  vec3 up = cross(sunDir, right);
  vec2 s = vec2(dot(rd, right), dot(rd, up));
  float facing = step(0.0, dot(rd, sunDir));
  float disc = step(max(abs(s.x), abs(s.y)), 0.055) * facing;
  vec3 sunCol = mix(vec3(1.0, 0.95, 0.75), vec3(0.85, 0.9, 1.0), uNight);
  col = mix(col, sunCol, disc);
  col += sunCol * exp(-length(s) * 9.0) * facing * (0.25 + 0.4 * colourDrive());
  // Stars at night, twinkling with the hi-hats.
  if (rd.y > 0.0) {
    vec2 g = floor(rd.xz / max(rd.y, 0.05) * 60.0);
    float star = step(0.993, hash21(g)) * uNight;
    float tw = 0.5 + 1.2 * sparkle() * step(0.5, hash21(g + floor(uTime * 10.0)));
    col += vec3(0.9) * star * tw * smoothstep(0.05, 0.3, rd.y);
    // Blocky clouds on a high plane.
    float t = (38.0 - 9.0) / max(rd.y, 0.02);
    vec2 cp = floor((rd.xz * t + vec2(uTime * 1.2, uTravel * 0.5)) / 6.0);
    float cloud = step(0.72, hash21(cp)) * smoothstep(0.02, 0.15, rd.y);
    col = mix(col, mix(vec3(1.0), vec3(0.3, 0.32, 0.4), uNight), cloud * 0.85);
  }
  return col;
}

vec3 blockColor(float h, vec2 cell, float face) {
  vec3 sand = vec3(0.86, 0.78, 0.55), grass = mix(vec3(0.36, 0.62, 0.3), pal(0.3), 0.35);
  vec3 stone = vec3(0.5, 0.5, 0.54), snow = vec3(0.95, 0.97, 1.0);
  vec3 c = h < 2.5 ? sand : h < 6.5 ? grass : h < 9.5 ? stone : snow;
  // Sides of grass blocks are earthier.
  if (face > 0.5 && h >= 2.5 && h < 6.5) c = mix(c, vec3(0.45, 0.33, 0.22), 0.55);
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = vec3(sin(uTravel * 0.031) * 2.5, 10.5 + uBob, uTravel);
  vec3 fw = normalize(vec3(sin(uTravel * 0.02) * 0.15, -0.36, 1.0));
  vec3 rt = normalize(cross(vec3(0, 1, 0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x * rt * 1.1 + uv.y * up * 1.1);

  vec3 col = sky(rd);
  float tWater = rd.y < 0.0 ? (WATER - ro.y) / rd.y : 1e9;

  // Walk the grid of columns (a 2D DDA), checking each column's top and sides.
  vec2 cell = floor(ro.xz);
  vec2 stepDir = sign(rd.xz);
  vec2 safe = vec2(abs(rd.x) < 1e-5 ? 1e-5 : rd.x, abs(rd.z) < 1e-5 ? 1e-5 : rd.z);
  vec2 tDelta = abs(1.0 / safe);
  vec2 tMax = (cell + max(stepDir, 0.0) - ro.xz) / safe;
  float t = 0.0;
  float hitT = -1.0;
  vec3 normal = vec3(0.0);
  float hitH = 0.0;
  vec2 hitCell = vec2(0.0);
  float axis = 0.0;
  for (int i = 0; i < 110; i++) {
    float h = columnHeight(cell);
    float tExit = min(tMax.x, tMax.y);
    float yIn = ro.y + rd.y * t;
    float yOut = ro.y + rd.y * tExit;
    if (yIn < h && t > 0.0) {
      hitT = t; hitH = h; hitCell = cell;
      normal = axis < 0.5 ? vec3(-stepDir.x, 0.0, 0.0) : vec3(0.0, 0.0, -stepDir.y);
      break;
    }
    if (yOut < h && rd.y < 0.0) {
      hitT = (h - ro.y) / rd.y; hitH = h; hitCell = cell;
      normal = vec3(0.0, 1.0, 0.0);
      break;
    }
    if (t > 140.0 || tWater < t) break;
    if (tMax.x < tMax.y) { t = tMax.x; tMax.x += tDelta.x; cell.x += stepDir.x; axis = 0.0; }
    else { t = tMax.y; tMax.y += tDelta.y; cell.y += stepDir.y; axis = 1.0; }
  }

  vec3 sunDir = normalize(vec3(0.35, 0.6, 0.7));
  float dayLight = mix(1.0, 0.35, uNight);
  if (hitT > 0.0 && hitT < tWater) {
    vec3 pos = ro + rd * hitT;
    float side = normal.y > 0.5 ? 0.0 : 1.0;
    // Which block of the column, and where on its face.
    float level = normal.y > 0.5 ? hitH - 1.0 : floor(pos.y);
    vec3 base = blockColor(normal.y > 0.5 ? hitH : level + 1.0, hitCell, side);
    vec2 faceUv = normal.y > 0.5 ? fract(pos.xz) : (abs(normal.x) > 0.5 ? vec2(fract(pos.z), fract(pos.y)) : vec2(fract(pos.x), fract(pos.y)));
    // Coarse texture: 8x8 speckle per face.
    float speck = hash31(vec3(floor(faceUv * 8.0), level + hitCell.x * 13.0 + hitCell.y * 7.0));
    base *= 0.9 + 0.16 * speck;
    float shade = normal.y > 0.5 ? 1.0 : abs(normal.x) > 0.5 ? 0.72 : 0.58;
    float diffuse = max(dot(normal, sunDir), 0.0) * 0.5 + 0.55;
    col = base * shade * diffuse * dayLight;
    // Block edges, lit up on the beat.
    vec2 e = min(faceUv, 1.0 - faceUv);
    float edge = 1.0 - smoothstep(0.0, 0.06, min(e.x, e.y));
    col = mix(col, col * 0.55, edge * 0.6);
    col += pal(0.5 + 0.2 * colourDrive()) * edge * (0.08 + 0.9 * onBeat(0.3) * pulse());
    // Distance haze.
    col = mix(col, skyColor(rd), smoothstep(35.0, 120.0, hitT));
  } else if (tWater < 1e8) {
    // Water: sky reflected, deeper away from the banks, glinting with the hi-hats.
    vec3 pos = ro + rd * tWater;
    vec3 refl = sky(reflect(rd, vec3(0.0, 1.0, 0.0)));
    vec3 deep = mix(vec3(0.05, 0.25, 0.45), pal(0.65) * 0.5, 0.3) * dayLight;
    float fres = 0.2 + 0.8 * pow(1.0 - abs(rd.y), 4.0);
    col = mix(deep, refl, fres);
    vec2 g = floor(pos.xz * 3.0 + vec2(0.0, uTime * 2.0));
    col += vec3(1.0) * step(0.985, hash21(g + floor(uTime * 8.0))) * (0.2 + 1.5 * sparkle());
    col = mix(col, skyColor(rd), smoothstep(40.0, 130.0, tWater));
  }

  col *= 0.95 + 0.25 * pulse() * (1.0 - uNight * 0.5);
  vec2 c = vUv - 0.5;
  col *= 1.0 - 0.6 * dot(c, c);
  o = vec4(aces(col * 1.05), 1.0);
}`;

export default defineVisualizer({
  id: 'blocks',
  name: 'Block Valley',
  family: 'games',
  order: 305,
  description: 'A flight down a valley built of blocks: the hills are a giant equalizer, kicks pop columns up, each drop turns day to night.',
  create(ctx) {
    const { gl } = ctx;
    const program = new Program(gl, FULLSCREEN_VS, FS);
    let travel = 0;
    let bob = 0;
    let bounce = 0;
    let night = 0;
    return {
      resize() {},
      render(frame) {
        const a = frame.audio;
        const dt = Math.min(frame.dt, 0.05);
        const low = Math.max(a.bassline, a.bass * 0.5);
        travel += dt * (3 + 5 * a.energy + 4 * low);
        bob += ((Math.sin(frame.time * 1.3) * 0.6 + low * 1.4) - bob) * Math.min(1, dt * 2);
        bounce = Math.max(bounce * Math.exp(-dt * 4), Math.max(a.kick, a.beatPulse * 0.8));
        const targetNight = a.dropCount % 2;
        night += (targetNight - night) * Math.min(1, dt * 0.8);
        bindOutput(gl, frame);
        program.use().set({ ...commonUniforms(frame), uTravel: travel, uBob: bob, uBounce: bounce, uNight: night });
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
