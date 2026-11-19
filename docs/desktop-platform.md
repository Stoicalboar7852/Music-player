# Desktop platform for version 3: Electron, Tauri, or Electron with a native helper

Version 3 asked whether Phosphor's desktop app should leave Electron for
something built on Rust (Tauri), if that would let it do more. This is what I
checked and what I chose. Short answer: **stay on Electron, switch to
castLabs' build of it (Widevine), and add native code only where a feature
needs it.** Tauri would make Phosphor do *less* on the desktop, not more.

## What the desktop app needs to do in version 3

| Need | Why |
| --- | --- |
| Spotify's own web player inside the app | Play Spotify without the Spotify app (Part 4). Needs Widevine DRM in the app's browser engine. |
| The computer's sound, on Windows and macOS | The visualizers hear streaming services through it. |
| A second, full-screen presenter window on another display | Part 1. |
| Rendered frames out to NDI, Syphon (Mac) and Spout (Windows) | FreeShow and ProPresenter integration (Part 6). |
| WebGL2 at full speed, 43 visualizers unchanged | The app is the same web app as in the browser. |
| Phones | Part 7, only if a native app is the only way to visualize Spotify without the microphone. |

## The candidates

### Tauri 2 (system webview + Rust)

Tauri draws the app in the operating system's own webview: WebView2
(Chromium-based) on Windows, WKWebView (Safari's engine) on macOS, WebKitGTK
on Linux.

- **Spotify's web player can't run on macOS.** WKWebView has no Widevine;
  Apple's engine only offers FairPlay, and even FairPlay EME is missing in
  some WKWebView configurations ([WebKit bug 284841](https://bugs.webkit.org/show_bug.cgi?id=284841)).
  On Windows, WebView2 does include Widevine (it is Edge's runtime;
  [discussion](https://github.com/microsoft/live-share-sdk/issues/14)), so
  Spotify would work there and not on the Mac.
- **No way to get rendered frames out efficiently.** The system webviews only
  offer slow snapshots (PNG captures), nothing like Electron's offscreen
  rendering. NDI, Syphon and Spout output of the visuals would mean
  rewriting every visualizer natively (GLSL to WGSL on wgpu).
- **Three different engines** to test the 43 visualizers, the audio graph and
  the presenter against, instead of one Chromium.
- **What it would add:** a smaller download, and phone apps (Tauri 2 targets
  iOS and Android). The phone side is covered under Part 7.

### Electron, as before

- Same Chromium everywhere, so the app and the browser version behave alike.
- **System audio on both systems**: Windows loopback, and on macOS 14.2+ the
  CoreAudio Tap API, which Chromium uses by default for loopback capture from
  Electron 39 on ([Electron desktopCapturer docs](https://www.electronjs.org/docs/latest/api/desktop-capturer)).
  Version 2 relied on experimental flags for the Mac; on Electron 45 this is
  the supported path.
- **Offscreen rendering with GPU shared textures** (Electron 33+): a hidden
  window's frames can be handed to native code without copying, which is what
  a Syphon or Spout sender needs, and a CPU frame path for NDI
  ([offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)).
- **No Widevine** in the stock build, so no Spotify web player.

### Electron for Content Security (castLabs), plus native code where needed

[castLabs' Electron](https://github.com/castlabs/electron-releases) is
Electron with Google's Widevine module, kept in step with Electron releases
(v45.2.1+wvcus matches our Electron 45). Production VMP signing, which DRM
services can require, is free through their EVS service with an account
([EVS](https://github.com/castlabs/electron-releases/wiki/EVS)); without it
builds carry a development signature.

## The spike

`spike-widevine` (a 40-line Electron app, run on Linux in the build
environment) waits for the Widevine module, then asks a page served from
`http://127.0.0.1` for Widevine the way Spotify's web player does
(`navigator.requestMediaKeySystemAccess('com.widevine.alpha', …)` with
`createMediaKeys()`):

| Build | Widevine module | Result in the page |
| --- | --- | --- |
| Electron 45.3.4 (stock) | none | `NotSupportedError: Unsupported keySystem or supportedConfigurations.` |
| castLabs Electron 45.2.1+wvcus | installed by `components.whenReady()` in about a second (Widevine CDM 4.10.3112.0, downloaded from Google) | `{ keySystem: 'com.widevine.alpha', mediaKeys: true }` |

(A `data:` URL gets no EME at all, since it isn't a secure context; Phosphor
serves itself from `http://127.0.0.1`, which is.)

The desktop smoke test (`desktop/smoke-test.mjs`) now checks the same thing in
the packaged app on macOS and Windows in GitHub Actions.

What the spike can't show: whether Spotify's licence server accepts the
development VMP signature. Reports from castLabs users say production VMP
signing fixed Spotify licence errors
([castlabs/electron-releases issue](https://lightrun.com/answers/castlabs-electron-releases-getting-widevine-license-error-on-the-spotify-web-player)),
so the build workflow signs with EVS whenever an account is configured (see
the README, Desktop app).

## Decision

1. **Electron stays**, as castLabs' Electron for Content Security: Spotify's
   web player inside the app, the same Chromium as the browser version,
   system audio on Windows and macOS, offscreen rendering for video output.
2. **Native code only for what the web platform can't do**, as a native
   module or helper next to Electron rather than a different shell: NDI,
   Syphon and Spout output (Part 6), and the optional librespot playback
   (Part 4).
3. **Phones** are decided separately (Part 7): a desktop shell choice doesn't
   carry over, and Electron has no phone version anyway.

Migration was therefore small: `desktop/package.json` takes Electron from
castLabs' releases (`electronDownload.mirror` for electron-builder), the main
process installs Widevine at startup, and the page lets Spotify play in the
app when Widevine is ready (falling back to the Spotify app when it isn't).
Everything from version 2 (menu bar or tray visualizer, mini player, taskbar
buttons, system audio, presenter placement) carries over unchanged, and the
same smoke test covers it.
