# Phosphor

A music player for the browser whose main attraction is its visualizers. Put music on, press <kbd>F</kbd>, and the interface fades away to leave twenty-five audio-reactive visualizers filling the screen.

![Album Halo, with colours taken from the cover art](docs/screenshots/radial.png)

- **Sources:** local files (MP3, FLAC, WAV, M4A/AAC, OGG/Opus and anything else Chrome or Edge decodes), whatever your computer is playing (system or tab audio capture), Spotify, Apple Music, and YouTube / YouTube Music.
- **Visualizers:** twenty-five in five categories: classic (spectrum bars, oscilloscope, feedback trails, kaleidoscope, real MilkDrop presets, a spectrogram, ridgelines), modern (GPU particles, a radial spectrum around the album art, a laser show, a mandala), 3D (raymarched orb, lattice and crystal cave, a frequency terrain, a ringed planet, light ribbons), retro and arcade (a demoscene tunnel, a pixel-art night drive, a self-playing pixel shooter, vector-monitor wireframes) and simulations (fluid, reaction-diffusion, a cellular automaton, a slime mould). Kicks, the bassline, vocals, hi-hats and drops each drive something different in every one of them.
- **Player:** queue, shuffle, repeat, seek, volume, keyboard shortcuts, media keys, drag and drop, folders, tags and cover art, crossfades between songs (and beat-matched DJ mixes between local files), a visualizer gallery, auto-cycling visualizers.
- **Stack:** Vite + TypeScript, raw WebGL2, Web Audio. No backend and no framework. Runs in Chrome or Edge.

## Version 2 (this branch, in progress)

This is the `v2` branch. The `v1` branch keeps the first version unchanged. V2 is being built in stages; what has landed so far:

- **Songs move on by themselves.** When a Spotify song finished, the next one in the queue didn't start until you pressed skip. Spotify's player only reports when something changes, so a song that played through untouched never gave Phosphor the end signal it was waiting for. Phosphor now recognises the end in several independent ways (including Spotify's own autoplay taking over, Spotify swapping in another copy of a song, and Spotify saying nothing at all). A safety net moves any source on if it sits at the very end without reporting it.
- **Now Playing shows the track.** On macOS, Phosphor's Now Playing entry showed the tab title (e.g. "Rise · Lynnic — Phosphor") with no artist or artwork while Spotify or YouTube played. Their players live in embedded frames that claim the media keys without setting any track info, and Chrome was showing that frame's empty entry. Phosphor now keeps its own page in charge, so Now Playing shows the title, artist and artwork, and media keys control Phosphor's queue. In the browser the entry still carries Chrome's icon; the desktop app planned for later will show Phosphor's own.
- **Diagnostics.** Open **http://127.0.0.1:5173/?debug** to log playback events to the browser console (see [Troubleshooting](#troubleshooting)).
- **Streaming on the first screen.** Spotify, Apple Music and YouTube sit on the welcome screen with their live state (set up, connect, connected as …), one click from their home view.
- **Less fiddling to share audio.** Starting a streaming song with a click opens Chrome's share dialog straight away; pick this tab and click Allow, once per session (Settings can turn this off). A browser extension can't remove that step: Chrome only lets an extension capture a tab after a click on its toolbar button, every time. The desktop app planned for later captures without asking.
- **Phosphor playlists** (<kbd>B</kbd>, or the library button). Mix songs from every source in one playlist; link a Spotify, Apple Music or YouTube playlist so it's fetched fresh each time it plays; put playlists inside playlists (loops are refused); play in order, shuffled, or alternating between sources; export and import as JSON. Local files are reopened from disk after a restart, where Chrome allows it.
- **Browse each service.** Each service's tab in **Add music** opens on a home view built from what its API offers for your account, with album and playlist pages, and a heart to save to your library. See [Streaming services](#streaming-services) for what each one can and can't show.

- **Thirteen new visualizers, five gallery categories.** Spectrogram and Ridgelines (classic), Laser Show and Petals (modern), Ringed Planet, Crystal Cavern and Ribbons (3D), Neon Racer, Starfighter and Vector Arcade (retro and arcade: original takes on arcade genres, not copies of any game), and Reaction-Diffusion, Life and Slime Mold (simulations). The gallery filters by category. See [Visualizers](#visualizers).
- **Beat tracking that follows the drums.** The analysis now separates what is percussive from what is held (singing, chords, the bassline), finds kicks, snares and hi-hats in the percussive part, and locks onto the tempo, the beat and the bar. Local files get their beats worked out ahead of time in the background, so beats land exactly. It also follows the bassline, the vocals and leads, brightness and energy, and spots build-ups and drops. Every visualizer was rewired so big pulses come from kicks and beats, continuous motion from the bassline, colour and detail from the vocals, sparkle from the hi-hats, and scene changes from drops. A singer or a pad on its own no longer makes anything pulse. See [How the visuals follow the music](#how-the-visuals-follow-the-music).
- **Crossfades and DJ-style mixes.** Settings, Between songs: crossfade from off to 12 seconds, with the loudness held steady, between any two sources (a local file into Spotify, YouTube into Apple Music...). Two songs on the same streaming service can't play at once, so they fade out and in. Local files can instead be mixed like a DJ would: tempo matched without changing pitch, beats and bars lined up, clashing keys kept short, in three styles (fade, blend with a bass swap, or a filter rise). See [Between songs](#between-songs-crossfades-and-mixes).

Still to come: crossfade and mix transitions, and desktop and phone apps.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open **http://127.0.0.1:5173** (use `127.0.0.1`, not `localhost`: Spotify only accepts that form of local address for sign-in, and `localhost` redirects there anyway). Drop some audio files on the window, or click **Play demo** for a built-in synthesised track.

To build static files for hosting anywhere: `npm run build`, then serve `dist/`. If you host it somewhere other than `http://127.0.0.1:5173`, it must be served over **https** for Spotify sign-in, and the redirect URI in your Spotify app has to match the new address.

Local files, system audio capture and YouTube links work without any setup. Spotify and Apple Music need credentials from you; see [Streaming services](#streaming-services).

## Using it

<table>
<tr><td><img src="docs/screenshots/ui-playing.png" alt="Playing a local file"></td><td><img src="docs/screenshots/ui-gallery.png" alt="Visualizer gallery"></td></tr>
<tr><td><img src="docs/screenshots/ui-queue.png" alt="Queue"></td><td><img src="docs/screenshots/ui-capture.png" alt="System audio capture, with advice for this OS"></td></tr>
</table>

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next visualizer |
| <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> | Previous / next MilkDrop preset |
| <kbd>1</kbd>…<kbd>0</kbd> | Jump to a visualizer |
| <kbd>A</kbd> | Auto-cycle visualizers on / off |
| <kbd>G</kbd> | Visualizer gallery |
| <kbd>↑</kbd> <kbd>↓</kbd> | Volume |
| <kbd>M</kbd> | Mute |
| <kbd>N</kbd> / <kbd>P</kbd> | Next / previous track (previous restarts the track if you are more than 3 s in) |
| <kbd>J</kbd> / <kbd>L</kbd> | Seek back / forward 10 seconds |
| <kbd>S</kbd> / <kbd>R</kbd> | Shuffle / repeat (off, all, one) |
| <kbd>Q</kbd> | Queue (click to play, drag to reorder) |
| <kbd>O</kbd> | Add music |
| <kbd>C</kbd> | Capture system or tab audio |
| <kbd>F</kbd> | Fullscreen (or double-click the visuals) |
| <kbd>,</kbd> / <kbd>?</kbd> | Settings / list of shortcuts |
| <kbd>Esc</kbd> | Close whatever is open |

Media keys, headset buttons and the OS "now playing" widget control playback too.

In fullscreen the controls fade out a few seconds after the mouse stops (Settings can make that happen always, or never). They stay while the pointer is over them. Auto-cycle picks a new visualizer every 15 seconds to 5 minutes, shuffled or in order, crossfading between them; it pauses while nothing is playing. Quality defaults to **Auto**, which lowers the internal render resolution when frames start dropping and raises it again when there is headroom, so the frame rate holds on slower GPUs.

Settings, the last visualizer, volume, shuffle and repeat are remembered in the browser.

### Between songs: crossfades and mixes

**Settings → Between songs** sets how one song gives way to the next.

- **Crossfade** (off, or 2 to 12 seconds). The end of one song overlaps the start of the next, with equal-power curves so the loudness holds steady through the change. It works between any two sources:
  - **Local file to local file**: two players overlap on Phosphor's own audio graph.
  - **Different services** (a local file into Spotify, YouTube into Apple Music, and so on): both players run at once, one fading down while the other fades up.
  - **Two songs on the same streaming service** can't overlap: a Spotify account plays one song at a time, MusicKit gives a page a single Apple Music player, and Phosphor runs a single YouTube player. So the first song fades out over its last few seconds and the next one fades in. The services don't let a page preload the next song, so there may be a short gap while it starts.
  - **A whole album or playlist the service plays itself** (a Spotify or Apple Music list added as one item): the service moves from song to song inside it, so Phosphor doesn't fade between those.
- **Mix, like a DJ** (local files). When both songs have a beat grid (worked out in the background, ahead of time), Phosphor plans a DJ transition:
  - It picks the last phrase of the outgoing song (a downbeat at a 16-beat boundary, falling back to 8 or 4) that leaves room for the overlap, and starts the incoming song on its first downbeat, so bars line up with bars.
  - It matches the tempo by time-stretching the incoming song (its pitch doesn't change), within ±8%, also trying double and half time. While the two overlap, it keeps the beats locked the way a DJ rides the pitch fader. Afterwards the new song glides back to its own tempo over a few seconds.
  - It estimates each song's key (Krumhansl-Kessler key profiles on the song's chroma) and places it on the Camelot wheel. Songs whose keys clash get half the overlap, so their harmonies don't sit on top of each other for long.
  - Three styles: **Fade** (an equal-power crossfade across 16 beats), **Blend** (32 beats: the incoming song comes in without its bass, the basslines swap on a downbeat halfway, then the outgoing song fades out) and **Rise** (16 beats: the outgoing song is filtered upward into a build, then the incoming one drops in on the new phrase).
  - If a grid isn't ready, or a song has no steady beat, it crossfades instead (at least 6 seconds).
  - Turn on `?debug` to see each plan in the console, e.g. `mixing into "…": blend over 32 beats from beat 35 (17.4 s), tempo ×1.051, keys compatible`.

Streaming songs can't be mixed this way. The services' web players don't give a page their audio (Phosphor only hears it through tab capture, as it plays), so it can't be filtered or analysed ahead of time, and Spotify's and Apple's players have no way to change a song's tempo. For streaming, Phosphor crossfades or fades, as above.

## Visualizers

| | Visualizer | Bassline and low end | Vocals and mids | Hi-hats and treble | Kicks, beats and drops |
| --- | --- | --- | --- | --- | --- |
| 1 | **Spectrum** – LED bars with gravity-driven peak caps and a floor reflection | left-hand bars, floor glow | middle bars | right-hand bars | bars and floor flare |
| 2 | **Oscilloscope** – left and right waveforms as a beam on a phosphor tube | beam thickens | waveform shape | beam brightens on hits | beam and graticule flash |
| 3 | **Feedback Trails** – waveform rings leave swirling, colour-cycling trails | outward zoom | swirl strength and spin | hue rotation speed, comets | zoom kick; the swirl reverses every 8 beats and on drops |
| 4 | **Tunnel** – tiled demoscene tunnel; past sound flies toward you as lit tiles | glow at the far end | bend and roll | neon tubes fizz | walls lurch, steel ribs flash |
| 5 | **Kaleidoscope** – mirrored stained glass, each shard tied to one frequency | zoom | spin and tumble | bevel glints, sparkles | flash; the pattern changes on a drop (or every 32 beats) |
| 6 | **MilkDrop** – genuine MilkDrop presets via butterchurn, a curated set of 24 | per preset | per preset | per preset | preset changes on a drop, or on a beat every ~30 s |
| 7 | **Particle Field** – ~190,000 GPU particles forming shapes | shape swells | flow-field turbulence, orbit speed | glitter flashes | explosion outward on kicks; a new shape on a drop (or every 32 beats) |
| 8 | **Pulse Orb** – raymarched liquid-metal sphere | swell and wobble | regions of skin bulge with their band | skin roughens, sparks | shockwave ring |
| 9 | **Lattice Flight** – raymarched flight through a grid of cubes, one band each | flight speed | roll | edges spark | light wave races down the corridor; the roll turns on a drop |
| 0 | **Frequency Terrain** – a landscape built from the last few seconds of spectrum | height, sun size, horizon glow | ridges | aurora, wire shimmer, stars | sun pulse, grid flash |
| | **Fluid** – Navier–Stokes ink simulation | fountain from the bottom | jets from the sides | circling nozzles, finer swirls | ink bursts; a drop blasts from the centre |
| | **Album Halo** – cover art ringed by a radial spectrum and waveform halo | disc swells, rim light | spectrum bars | sparks | ripples leave the disc |
| | **Spectrogram** (classic) – the scrolling waterfall: pitch up the screen, time across it | low rows heat up | middle rows; colour | top rows glint | the newest column flares; every beat leaves a grid line that scrolls away (bar lines brighter) |
| | **Ridgelines** (classic) – recent sound stacked into a range of glowing lines, newest at the front | ridges rise | line colour | peaks glint | the front ridge flashes |
| | **Laser Show** (modern) – beams sweep through stage haze across the bar | stage glow | beam colours | glitter along the beams | beams flash and widen; a new pattern on each drop |
| | **Petals** (modern) – a mandala of polar roses, each petal one band | the flower swells | tint, petal curl | petal tips glint | bloom; the petal count changes on drops |
| | **Ringed Planet** (3D) – a world whose rings are the spectrum, bass inside, treble outside | continents rise | sky tint | ring glitter, city lights | a shockwave through the rings; drops swing the camera |
| | **Crystal Cavern** (3D) – a flight through a cave of crystals, each one a band | glow | crystal tint | facet glints | lantern flash and speed; drops take a new passage |
| | **Ribbons** (3D) – ribbons of light winding through space, each one a band | how far they roam | twist and tint | sparks run along them | thrown outward; drops retie the knot |
| | **Neon Racer** (retro) – a pixel-art night drive on an endless road | the road bends | skyline colours | windows twinkle | speed surges, kerbs flash, snares strobe the posts; drops change the time of night |
| | **Starfighter** (retro) – a pixel shooter that plays itself against a formation made of the spectrum | the ship weaves | crystal tint | stars twinkle, the engine flickers | the ship fires on kicks, snares burst crystals; a new wave on drops |
| | **Vector Arcade** (retro) – glowing wireframes on a vector monitor, with afterglow | | spin and tint | single edges flash | shapes punch out; the floor rolls one cell per beat; new shapes on drops |
| | **Reaction-Diffusion** (simulation) – two chemicals growing coral, cells, worms or mazes | reaction rate | reaction rate, tint | edges glint | new seeds grow; drops change the kind of growth |
| | **Life** (simulation) – a cellular automaton stepping four generations a beat | trail glow | tint | sparkles | kicks plant patterns, snares launch gliders; drops change the rules |
| | **Slime Mold** (simulation) – 65,000 agents weaving trail networks like a slime mould | how strongly paths are marked | how widely they look; tint | glitter on busy paths | scattered outward; drops start a new colony |

The gallery (<kbd>G</kbd>) filters by category: Classic, Modern, 3D, Retro & arcade, Simulations. Most visualizers take their colours from the current track's artwork; the interface accent colour follows it too. With no artwork, Album Halo shows a spinning record instead. Number keys reach the first ten; the arrow keys, the gallery and auto-cycle reach them all.

<table>
<tr><td><img src="docs/screenshots/bars.png" alt="Spectrum"></td><td><img src="docs/screenshots/scope.png" alt="Oscilloscope"></td><td><img src="docs/screenshots/trails.png" alt="Feedback Trails"></td></tr>
<tr><td><img src="docs/screenshots/tunnel.png" alt="Tunnel"></td><td><img src="docs/screenshots/kaleido.png" alt="Kaleidoscope"></td><td><img src="docs/screenshots/milkdrop.png" alt="MilkDrop"></td></tr>
<tr><td><img src="docs/screenshots/particles.png" alt="Particle Field"></td><td><img src="docs/screenshots/orb.png" alt="Pulse Orb"></td><td><img src="docs/screenshots/lattice.png" alt="Lattice Flight"></td></tr>
<tr><td><img src="docs/screenshots/terrain.png" alt="Frequency Terrain"></td><td><img src="docs/screenshots/fluid.png" alt="Fluid"></td><td><img src="docs/screenshots/radial.png" alt="Album Halo"></td></tr>
<tr><td><img src="docs/screenshots/spectrogram.png" alt="Spectrogram"></td><td><img src="docs/screenshots/ridgelines.png" alt="Ridgelines"></td><td><img src="docs/screenshots/lasers.png" alt="Laser Show"></td></tr>
<tr><td><img src="docs/screenshots/petals.png" alt="Petals"></td><td><img src="docs/screenshots/planet.png" alt="Ringed Planet"></td><td><img src="docs/screenshots/cavern.png" alt="Crystal Cavern"></td></tr>
<tr><td><img src="docs/screenshots/ribbons.png" alt="Ribbons"></td><td><img src="docs/screenshots/racer.png" alt="Neon Racer"></td><td><img src="docs/screenshots/starfighter.png" alt="Starfighter"></td></tr>
<tr><td><img src="docs/screenshots/vectors.png" alt="Vector Arcade"></td><td><img src="docs/screenshots/reaction.png" alt="Reaction-Diffusion"></td><td><img src="docs/screenshots/life.png" alt="Life"></td></tr>
<tr><td><img src="docs/screenshots/slime.png" alt="Slime Mold"></td><td></td><td></td></tr>
</table>

### Adding a visualizer

Add one file to `src/viz/visualizers/`. It is registered automatically and appears in the gallery, the arrow-key rotation and auto-cycle.

```ts
import { COMMON_UNIFORMS, FS_HEADER } from '../../gl/glsl';
import { drawFullscreen, FULLSCREEN_VS, Program } from '../../gl/util';
import { bindOutput, commonUniforms, defineVisualizer } from '../types';

const FS = /* glsl */ `${FS_HEADER}
in vec2 vUv; out vec4 o;
${COMMON_UNIFORMS}
void main() {
  float s = texture(uSpectrum, vec2(vUv.x, 0.5)).r;              // log-spaced spectrum, 0..1
  float bar = step(vUv.y, s);
  o = vec4(mix(uPal[0], uPal[1], vUv.y) * bar * (0.6 + uBeat) + uBass * 0.1, 1.0);
}`;

export default defineVisualizer({
  id: 'hello',
  name: 'Hello Bars',
  family: 'classic',
  order: 200,
  description: 'The smallest possible example.',
  create({ gl }) {
    const program = new Program(gl, FULLSCREEN_VS, FS);
    return {
      resize() {},
      render(frame) {
        bindOutput(gl, frame);
        program.use().set(commonUniforms(frame));
        drawFullscreen(gl);
      },
      dispose() {
        program.dispose();
      },
    };
  },
});
```

Every visualizer receives the same analysis each frame (`frame.audio` in TypeScript, uniforms and textures in GLSL):

- `spectrum`: 128 log-spaced bands from 32 Hz to 16 kHz, 0..1, auto-gained with a treble tilt so quiet captures and loud masters both fill the range; also uploaded as the `uSpectrum` texture, plus a 256-row scrolling history texture (`uHistory`).
- `waveform`, `waveL`, `waveR`: 1024 trigger-aligned samples, gain-normalised (`uWave`).
- `bass`, `mid`, `treble`, `level`: smoothed band energies; `bassHit`, `midHit`, `trebleHit`: transient emphasis.
- `beat` (true on the beat frame), `beatPulse` (1 decaying to 0), `beatCount`, `beatPhase` (0..1 through the beat), `barPhase`, `beatInBar`, `downbeat`, `bpm`, `tempoConfidence`: the tracked beat (see below).
- `kick`, `snare`, `hat` (1 on a hit, decaying) and `kickHit`, `snareHit`, `hatHit` (true on the frame): drum onsets.
- `bassline`, `vocals`, `brightness`, `energy`: continuous, from the held (harmonic) part of the sound.
- `build` (tension of a build-up), `drop` (true on the frame a drop lands), `dropPulse`, `dropCount`.
- `palette`: four colours from the current artwork (`uPal`), and the artwork itself (`uArtwork`).

In GLSL these are uniforms (`uKick`, `uSnare`, `uHat`, `uBassline`, `uVocals`, `uBright`, `uEnergy`, `uBeatPhase`, `uBarPhase`, `uBuild`, `uDrop`, `uDropCount`, alongside `uBass`, `uBeat` and the rest). Include `RHYTHM` from `src/gl/glsl.ts` to get the same mapping the built-in visualizers use: `pulse()` for big hits (kick or beat), `lowDrive()` for continuous low-end motion (the bassline), `colourDrive()` for colour and detail (vocals and leads), `sparkle()` for glints (hi-hats) and `onBeat(w)`. Change scenes when `frame.audio.drop` is true.

`src/gl` has the small WebGL2 toolkit the built-in ones use (programs with named uniforms, render targets, ping-pong buffers, bloom).

## How the visuals follow the music

Each frame, the analysis (`src/audio/rhythm.ts`) works out more than how loud each band is:

- **What is a hit and what is held.** A median-filter separation (made causal, so it adds no delay) splits each frame's spectrum into a percussive part (broadband, sudden) and a harmonic part (steady partials). Drums come from the first, the bassline and vocals from the second, so a singer or a held chord can't fire a beat.
- **Kicks, snares and hi-hats.** A kick is a rise of percussive energy below 150 Hz with little above it (a bass note brings its overtones along); a snare is noise across 1-5 kHz with a body, loud next to the kick (a beater click isn't); a hi-hat is noise above 7 kHz.
- **Tempo, beat and bar.** Kicks and snares (snares counting double, since they almost always fall on a beat) build an onset curve; its autocorrelation gives the tempo (preferring 90-180 BPM), a comb template gives where the beats fall, and a phase-locked loop keeps them on time, carrying the beat through a breakdown. Bars start where the chords change (12-tone chroma compared two beats either side), with a kick rather than a backbeat snare.
- **Ahead of time, for local files.** While a file plays, a worker decodes and analyses the whole thing (`src/audio/beatgrid.ts`, dynamic-programming beat tracking after Ellis 2007). When the grid arrives, beats and bars follow the playback position exactly. Files without drums get no grid.
- **Bassline, vocals, brightness, energy.** Harmonic energy at 35-160 Hz, harmonic energy at 300 Hz-3.5 kHz, the spectral centroid, and loudness against the loudest recent part of the track.
- **Builds and drops.** A build is more snares and hats, a brighter sound, and less low end. A drop is the first kick after the low end has been gone for a couple of seconds.

The ground-truth tests (`npm run test-rhythm`, also part of `npm run verify`) run the real analysis frame by frame, at about 60 frames a second with uneven frame times, over synthesised music with exactly known beats. Current results:

| Signal | Live beats (F, ±70 ms) | Grid beats | Other |
| --- | --- | --- | --- |
| Four-on-the-floor, 105, 120 BPM | 1.00 | 0.99-1.00 | |
| Backbeat with an off-beat kick, 95 BPM | 1.00 | 1.00 | |
| Four-on-the-floor with a singer over it, 128 BPM | 1.00 | 1.00 | |
| 140 BPM with a four-bar breakdown | 1.00 | | drop found within 20 ms; downbeats 0.97 |
| The demo track (intro, build, breakdown, return) | 1.00 | 0.99 | drop found within 10 ms; grid downbeats 1.00 |
| A singer alone; held chords alone | no beats | no grid | no kicks or snares |

Across the loops, kicks score 0.86 precision / 0.83 recall and snares 0.93 / 0.80 (±50 ms).

What these can't promise: the test music is synthesised, so real recordings will score lower, and how much lower is untested here. Known weak spots: downbeats under a prominent melody that wanders off the chords; very slow or very fast songs may be tracked at double or half tempo (the visuals then pulse on eighth notes or every other beat); the live tracker takes a few seconds to lock at the start of a song. Streaming services and captured audio can only be tracked live: their audio can't be decoded ahead of time.

## System audio

This is the universal source: anything playing on your computer, or in another tab, can drive the visualizers. Open **Add music → System audio** (or press <kbd>C</kbd>) and the browser's share dialog appears. The captured sound is only analysed and never played back, so you won't hear it twice. Only the audio track is kept; the picture is discarded at once.

What the share dialog can capture depends on your OS (the app shows the right advice for yours):

| | One browser tab | Everything the computer plays |
| --- | --- | --- |
| **Windows** | Choose the tab, switch on *Also share tab audio* | Choose *Entire screen*, switch on *Also share system audio* |
| **macOS** | Choose the tab, switch on *Also share tab audio* | *Entire screen* + *Also share system audio*, on macOS 14.2 or later with a recent Chrome or Edge (about version 141 on). On older versions use a loopback driver such as BlackHole with **Audio input device**. |
| **Linux** | Choose the tab, switch on *Also share tab audio* | Not offered by Chrome. Use **Audio input device** and pick your sound server's "Monitor of …" source. |
| **ChromeOS** | As Windows | As Windows |

Sharing a single *window* never includes sound. **Audio input device** listens to any input (a loopback device, a monitor source, a mixer, or a microphone near the speakers) as an alternative.

On a Mac, the first system-audio share makes macOS ask whether Chrome may record the screen and system audio. If you declined, or the capture starts but hears nothing, open **System Settings → Privacy & Security → Screen & System Audio Recording**, switch Chrome on, then quit Chrome completely (Cmd+Q) and reopen it. The app warns you if a capture stays silent for about eight seconds.

## Troubleshooting

- **The visuals move but there's no sound.** Use Chrome or Edge. Safari and Firefox block sound more strictly, and can't capture audio at all. The app now unlocks sound on your first click or key press and tells you if the browser is still holding it back; clicking anywhere on the page fixes that. Also check the volume slider and the mute key (<kbd>M</kbd>).
- **System audio on a Mac picks up nothing.** See the macOS permission note above. "Also share system audio" only appears on macOS 14.2+ with Chrome or Edge 141+; on older versions, share the Chrome tab that is playing instead.
- **"Also share … audio" was off.** Share again and switch it on; the app explains what was missing when a share arrives without sound.
- **A streaming service misbehaves** (a song doesn't move on, playback stops, something looks wrong). Open **http://127.0.0.1:5173/?debug** (it's remembered; `?debug=0` turns it off), make the problem happen again, then open the browser console (**View → Developer → JavaScript Console** in Chrome on a Mac, or **Ctrl+Shift+J** on Windows) and copy the lines starting with `[phosphor:`. They show what each player reported and what Phosphor made of it.

## Streaming services

Spotify, Apple Music and YouTube all play through their **official** web players. None of them lets a web page read the audio: Spotify and Apple Music stream it with DRM, and YouTube plays inside its own cross-origin iframe. So the design is:

1. The service's own player handles sign-in, playback, track info and artwork, driven by Phosphor's queue and controls.
2. The visualizers listen to **this tab's audio**, shared once per session through the same capture as above. When a streaming track is playing and nothing is shared yet, a banner offers **Share this tab's audio**; in the dialog, pick the Phosphor tab itself (Chrome offers it first) with tab audio switched on.

Because the audio is captured after the service has applied its volume, turning Phosphor's volume very low also gives the visuals less to work with, and muting silences them. To listen quietly, turn your system volume down instead. Local files don't have this limitation.

All three go in one shared queue alongside local files, with the same shortcuts and media keys. Credentials are pasted into **Settings** and stored only in this browser's localStorage; they are sent nowhere except to the service they belong to.

### Spotify

Needs: a **Spotify Premium** account (Spotify does not allow browser playback for free accounts, and since February 2026 the app owner must have Premium for a development-mode app to work at all).

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard), sign in, and click **Create app**.
2. Give it any name and description. Under **Redirect URIs** add exactly `http://127.0.0.1:5173/` (the trailing slash matters; `localhost` is rejected by Spotify). After saving, check the dashboard didn't rewrite it.
3. Under *Which API/SDKs are you planning to use?* tick **Web API** and **Web Playback SDK**. Save.
4. Open the app's **Settings** and copy the **Client ID**. You don't need the client secret: Phosphor uses the PKCE flow, which is designed for apps without a backend.
5. In Phosphor: **Settings → Spotify → Client ID**, paste it. Then **Add music → Spotify → Connect Spotify** and approve in the popup.
6. Optional: to let other people use your copy, add them under **User Management** in the dashboard (development mode allows five).

Then the Spotify tab opens on your Spotify home: **recently played**, **jump back in** (the albums and playlists those songs came from), **your top songs this month**, **your playlists** (with Liked Songs), **saved albums**, and the **Spotify-made playlists** you've opened. Search, or paste `open.spotify.com` / `spotify:` links for tracks, albums and playlists. Albums and playlists open as pages; the heart saves a song, album or playlist to your Spotify library, and the heart next to the song in the player saves whatever is playing.

<img src="docs/screenshots/ui-spotify-home.png" alt="The Spotify home inside Phosphor">

**Spotify-made playlists** (Discover Weekly, Daily Mixes, Release Radar, editorial playlists like Today's Top Hits): since November 2024 Spotify doesn't let apps like this one list their songs, and it no longer offers recommendations, new releases or charts to them either. It does still play them. Paste a link to one (Share → Copy link in Spotify) and Phosphor has Spotify play it as a whole: each song shows in the player as it comes up, Next and Previous move through it, and when it ends Phosphor carries on with its own queue. It's kept on your Spotify home for next time, can go in Phosphor playlists, and appears under *jump back in* when you've been playing it.

Limits:

- Search returns at most 10 results per type (Spotify's cap for development-mode apps).
- Saving to your library may be refused with a 403: since 2026 Spotify blocks changes from many personal (development-mode) apps. Phosphor says so when it happens; playback is unaffected.
- Phosphor 2 asks for a few more permissions than version 1 (recently played, top songs, saving to your library). If you signed in with version 1, the shelves that need them show **Reconnect Spotify**; one click and an approval in Spotify's window.
- Sign-in lasts until you disconnect; tokens refresh automatically.

### Apple Music

Needs: a paid **Apple Developer Program** membership (to create a MusicKit key), and an **Apple Music subscription** for full tracks (without one, Apple plays 30-second previews).

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), click **+**, choose **Media IDs**, give it a description (people see this when signing in) and a reverse-domain identifier such as `media.com.yourname.phosphor`, tick **MusicKit**, and register it.
2. Go to **Keys**, click **+**, name the key, tick **Media Services (MusicKit, ShazamKit)**, click **Configure** and pick the Media ID from step 1. Continue and register.
3. **Download** the `AuthKey_XXXXXXXXXX.p8` file (Apple only lets you download it once) and note the **Key ID**. Your **Team ID** is under *Membership details* on your account page. Keep the `.p8` file private; it is git-ignored here.
4. Generate a developer token (valid up to six months):

   ```bash
   npm run apple-token -- --team-id ABCDE12345 --key-id 1A2B3C4D5E --key ./AuthKey_1A2B3C4D5E.p8
   ```

   Add `--origin http://127.0.0.1:5173` to lock the token to your copy of the app.
5. In Phosphor: **Settings → Apple Music**, paste the token. Then **Add music → Apple Music → Connect Apple Music** and sign in with your Apple ID in Apple's window.

Then the Apple Music tab opens on your Apple Music home: the **For You** groups Apple recommends, **recently played** (albums, playlists, stations) and recently played songs, **heavy rotation**, Apple's **top songs, albums and playlists** charts for your country, and **your playlists and albums**. Search the catalog, or paste `music.apple.com` song, album and playlist links. The heart adds a song, album or playlist to your library. Stations play as a whole, the way Apple runs them: each song shows as it comes up and Next moves on within the station.

<img src="docs/screenshots/ui-apple-home.png" alt="The Apple Music home inside Phosphor">

When the token expires, generate a new one and reload the page. If sign-in fails with an authorization error, check that the Team ID and Key ID match the key you downloaded.

### YouTube and YouTube Music

Needs: nothing for links. Paste any `youtube.com`, `youtu.be`, `shorts` or `music.youtube.com` video or playlist link in **Add music → YouTube**. For a YouTube Music album, use **Share** on the album page: it gives a playlist link, which works.

Optional, for search, popular music and named playlist tracks: a **YouTube Data API key**.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library**, find **YouTube Data API v3**, and **Enable** it.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Edit the key: under *API restrictions* choose **Restrict key → YouTube Data API v3**; under *Application restrictions* choose **Websites** and add `http://127.0.0.1:5173/*` (and your hosted address, if any).
5. In Phosphor: **Settings → YouTube → Data API key**, paste it.

With a key, the YouTube tab opens on **popular music**: the most popular music videos in your country right now (YouTube's "most popular" chart, Music category).

Optional, to see **your own playlists** (including the ones you made in YouTube Music) and **liked videos**: sign in with Google. This is read-only; Phosphor never changes anything on your account. It needs an OAuth client ID from the same Google Cloud project:

1. **Google Auth Platform** (formerly *OAuth consent screen*): fill in **Branding** (an app name and your email), choose **Audience → External**, and add your own Google account under **Test users**. The app can stay in *Testing*; Google shows an "unverified app" warning during sign-in, which you can continue past for your own app.
2. **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/youtube.readonly`.
3. **Clients → Create client → Web application**. Under **Authorised JavaScript origins** add `http://127.0.0.1:5173` (and your hosted https address, if any). No redirect URI is needed.
4. In Phosphor: **Settings → YouTube → Google client ID**, paste the client ID (it ends in `.apps.googleusercontent.com`). Then **Add music → YouTube → Sign in with Google**.

Signed in, search also works without an API key.

<img src="docs/screenshots/ui-youtube-home.png" alt="The YouTube home inside Phosphor, signed in">

Limits:

- YouTube has no official API for the rest of a YouTube Music library (saved albums, artists, history), so those can't be shown. Public and unlisted playlists work by link.
- Phosphor doesn't like or save videos: that needs permission to manage your YouTube account, which it doesn't ask for.
- Google ends browser sign-ins after an hour; your playlists then ask you to sign in again (one click). While the Google app is in *Testing*, Google also asks for consent again after seven days.
- Each search costs about 200 of the daily 10,000 free quota units, so roughly 50 searches a day. Popular music and playing links cost a few units.
- Some videos (often official label music videos) are blocked by their owners from playing outside YouTube. They are skipped with a message.
- YouTube's terms require the player to remain visible while it plays, so a small video frame stays in the bottom-left corner, even in fullscreen.

## How it was tested

`scripts/verify.cjs` drives a real Chromium with real audio playing, using a test track synthesised by `scripts/make-test-audio.mjs` (the same original composition the app ships as its demo) and encoded to MP3, FLAC, OGG, WAV and M4A with tags and cover art.

```bash
npm run test-audio
```

```bash
npm run dev
```

```bash
xvfb-run -a dbus-run-session -- npm run verify
```

(`xvfb-run` is only needed on a machine without a display. `dbus-run-session` gives Chromium a D-Bus session on Linux, where it publishes its media session the same way macOS Now Playing receives it; with it, the Now Playing and media-key checks run, and without it they're skipped. The script needs [Playwright](https://playwright.dev) with Chromium and ffmpeg on the PATH.)

It checks:

- **Visualizers:** each one renders and animates with the track playing, and gets a screenshot (`docs/screenshots`, also used for the gallery thumbnails).
- **Reaction:** deterministic A/B renders of every visualizer, with silence versus an isolated kick drum, a midrange chord and a hi-hat, and with beat detection withheld versus not. Each must change its image for bass, mids, treble and beats separately. The analysis layer is checked first, to show each stimulus lands only in its own band.
  Measured on the last run (mean change per colour channel, 0–255, after 2.5 s; "motion" is how much the picture changes in 0.2 s with the full mix playing):

  | Visualizer | Bass | Mids | Treble | Beats | Motion |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Spectrum | 2.4 | 1.7 | 1.8 | 0.9 | 4.5 |
  | Oscilloscope | 9.7 | 22.7 | 52.6 | 6.0 | 22.8 |
  | Feedback Trails | 53.0 | 13.0 | 32.5 | 40.4 | 30.1 |
  | Tunnel | 30.6 | 36.0 | 10.9 | 3.2 | 35.4 |
  | Kaleidoscope | 21.1 | 32.5 | 39.6 | 11.9 | 56.2 |
  | MilkDrop | 52.9 | 119.6 | 67.3 | n/a* | 18.6 |
  | Particle Field | 24.5 | 28.1 | 19.0 | 18.9 | 17.5 |
  | Pulse Orb | 8.7 | 18.3 | 8.7 | 4.2 | 20.4 |
  | Lattice Flight | 8.9 | 9.9 | 12.9 | 9.7 | 26.1 |
  | Frequency Terrain | 28.9 | 12.7 | 14.6 | 3.5 | 31.1 |
  | Fluid | 53.5 | 36.7 | 76.9 | 13.0 | 20.4 |
  | Album Halo | 6.4 | 3.4 | 3.3 | 4.1 | 11.8 |
  | Spectrogram | 16.9 | 11.6 | 10.6 | 1.3 | 23.4 |
  | Ridgelines | 12.3 | 14.4 | 3.5 | 2.3 | 16.6 |
  | Laser Show | 3.1 | 3.4 | 1.1 | 4.9 | 14.0 |
  | Petals | 4.4 | 5.5 | 2.6 | 2.4 | 7.7 |
  | Ringed Planet | 5.0 | 6.0 | 2.4 | 4.9 | 9.1 |
  | Crystal Cavern | 74.0 | 52.5 | 51.1 | 50.9 | 43.6 |
  | Ribbons | 9.5 | 9.2 | 1.6 | 11.0 | 18.2 |
  | Neon Racer | 5.7 | 6.2 | 4.2 | 5.1 | 9.5 |
  | Starfighter | 3.6 | 3.4 | 2.8 | 2.7 | 4.6 |
  | Vector Arcade | 10.0 | 7.6 | 7.2 | 5.3 | 22.4 |
  | Reaction-Diffusion | 23.7 | 29.0 | 22.4 | 11.1 | 26.8 |
  | Life | 11.0 | 2.3 | 19.5 | 10.9 | 22.3 |
  | Slime Mold | 65.1 | 108.1 | 50.1 | 82.8 | 29.3 |

  Small numbers mean a localised change (one group of bars, a ring), not a weak one. \*MilkDrop presets detect beats from the waveform themselves, so withholding Phosphor's beat signal changes nothing; their bass response covers it.
- **Rhythm and mixing:** see [How the visuals follow the music](#how-the-visuals-follow-the-music) for the beat-tracking ground truth. The same script checks the mix planner on two copies of the demo track (124 and 118 BPM): keys on the Camelot wheel, each style starting on a phrase of the outgoing song and a downbeat of the incoming one, every beat of the overlap meeting a beat of the other song, the tempo ratio, half-length overlaps for clashing keys, and the fallbacks.
- **Between songs:** a 3-second crossfade between two local files (the next one starts before the first ends, the summed power stays at 1, the queue moves on once); a blend mix from the 118 BPM version into the 124 BPM one (both grids and keys ready first, several bars of overlap, the incoming song time-stretched to the outgoing tempo with its pitch kept, beats within a tenth of a beat 90% of the time, the bass swap); a rise (the outgoing song filtered upward); a local file crossfading into YouTube (both players sounding at once); and two YouTube songs in a row (fade out, then in).
- **Player and interface:** tags and art from each format, decoding each format, every keyboard shortcut, visualizer crossfades, the gallery, auto-cycle, queue editing, drag and drop, folders with cover images, an undecodable file, the idle fade, fullscreen, the demo track, settings persistence.
- **Capture:** real `getDisplayMedia` capture of another tab and of the app's own tab, including that the captured audio has no path to the speakers.
- **Spotify, Apple Music, YouTube:** each against a local simulation of the service (in `scripts/mocks`) that follows the documented behaviour: OAuth with real PKCE verification, the Web API's 2026 response shapes, the playback SDK's events, MusicKit's queue and events, the IFrame API's states and errors, the Data API with quotas and pagination. Like the real players, the simulated Spotify and YouTube players run inside cross-origin frames, and Spotify's reports state only when something changes. Songs are played all the way to their end on each service, including Spotify's quirks (autoplay, relinked songs, a silent end). These prove Phosphor's side of each integration. They cannot prove the real services behave as documented; see below.
- **Now Playing and media keys:** what Chromium tells the operating system is playing (title, artist, artwork, playing or paused) for local files, Spotify and YouTube, and the Next, Pause and Play media keys, read and pressed through Chromium's MPRIS interface on Linux.

## Status

**Working and verified in a real browser with audio:** local files (all formats listed, tags, embedded and folder cover art, drag and drop, folders), the queue and every control and shortcut, media keys, fullscreen with idle fade, all twelve visualizers with crossfades, gallery and auto-cycle, system and tab audio capture.

**Needs your credentials before it can be tested against the real service:**

- Spotify (Client ID + Premium)
- Apple Music (developer token from a paid developer account + subscription)
- YouTube links work without anything, but could not be tried against real YouTube from the build environment; search additionally needs an API key.

**Not verifiable here, and worth knowing:**

- The build environment had no network access to Spotify, Apple or YouTube and no GPU (rendering used a software rasteriser), so the integrations were tested against simulations, and frame rates here say nothing about real hardware. I expect a typical laptop GPU to hold 60 fps at 1080p, but I could not measure that. The heaviest visualizers are the raymarched Pulse Orb and Lattice Flight and the Particle Field; Auto quality lowers the internal resolution when frames drop (verified to work, under software rendering), and **Settings → Quality → Low** goes further. Turn on **Settings → Show frame rate** to see what yours does.
- Whole-system audio on macOS depends on your macOS and Chrome versions (see the table above); tab audio works everywhere.
- M4A/AAC playback relies on Chrome's or Edge's AAC decoder (plain Chromium builds lack it).
