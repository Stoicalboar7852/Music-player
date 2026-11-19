# Phones: why there's an Android app, and why iOS waits

The plan for version 3 said: a native phone app only if it's the only way to visualize Spotify without the microphone. This is how that came out.

## In a phone browser it can't be done

- **Where Spotify plays on a phone, the page can't hear it.** Spotify's [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) officially supports mobile browsers ([since 2021](https://developer.spotify.com/blog/2021-09-13-web-playback-sdk-out-of-beta), with limits on autoplay and background play; developers report it failing on some phones). Even where it works, its audio is DRM-protected, so a page can't analyse it, exactly as on a computer. Otherwise Phosphor plays Spotify through the Spotify app (Spotify Connect), and the sound comes from another app.
- **A phone browser can't capture sound.** On a computer, Chrome's tab or system audio capture gets around the DRM. Phone browsers have no `getDisplayMedia` audio and no other way to capture a tab's, another app's or the system's sound. The only input a page gets is the microphone (which Phosphor already offers on phones).
- So without the microphone, a phone browser can't visualize Spotify, or Apple Music, or the YouTube Music app. A native app is the only way.

## Android: possible, built as an experimental app

Android has two ways for an app to hear what the phone plays:

| | The Visualizer API on the output mix | Playback capture (Android 10+) |
| --- | --- | --- |
| What it gives | Waveform snapshots of everything playing (up to 1024 samples, about 20 a second on most phones) | The actual sound of other apps, at full quality |
| Asking | Android's "record audio" permission, once | The same permission, plus Android's capture prompt every time |
| Limits | Snapshots, not a continuous signal: Phosphor loops each one until the next (`SnapshotStream.kt`), so the spectrum and loudness follow the music but timing finer than ~50 ms is lost. Deprecated for effects but still documented for visualizers; some phone makers may restrict it. | Apps can opt out of being captured. A recent Spotify Community report says Android screen recordings do pick up Spotify's audio, which suggests Spotify allows it. Runs as a foreground service with a notification. |
| Sources | [Visualizer reference](https://developer.android.com/reference/android/media/audiofx/Visualizer) | [Capturing audio and video](https://developer.android.com/media/platform/av-capture), [Android Developers Blog: capturing audio in Android Q](https://android-developers.googleblog.com/2019/07/capturing-audio-in-android-q.html), [Spotify Community thread](https://community.spotify.com/t5/Android/Spotify-audio-is-being-captured-by-Android-screen-recordings/td-p/7555778) |

Neither uses the microphone, although Android files both under "record audio".

**What was built** (`android/`): Phosphor for Android, the same web app served from the app's own files in a WebView (`https://appassets.androidplatform.net`, a secure origin, so Web Audio worklets and WebGL2 work), with a small native bridge:

- `window.PhosphorAndroid.start('visualizer' | 'capture')` and `stop()` (`MainActivity.kt`). The Visualizer way is the default: once Android allows it, Phosphor listens by itself whenever a streaming song plays. Playback capture is in Settings, Streaming audio.
- The app hands the sound to the page as 16-bit stereo PCM; the page plays it into the analysis only (`src/app/android.ts`, the same `PcmStream` the desktop app's librespot path uses). It's never played back: it's already audible from the app that plays it.
- Spotify plays in the app with its web player where Android's WebView has Widevine, like the desktop app, or through the Spotify app (Settings, Spotify). The app hears the phone's sound either way. YouTube plays in the page as usual.

**How it's tested:** `SnapshotStream` has JVM unit tests (frequency, loudness, timing, resampling, silence). The page side is tested in Chromium with a simulated bridge that streams PCM the way the app does (`scripts/verify.cjs`, android section): listening starts by itself when allowed, the sound drives the visualizers including beats, stopping in the page stops the app's listening, and nothing is asked out of the blue when it isn't allowed. GitHub Actions builds the APK and runs the unit tests ([android.yml](../.github/workflows/android.yml)). An emulator test plays a test signal through another `AudioTrack` and checks the visualizers react. It needs an Android system image, and downloading one means accepting Google's Android SDK license, which isn't mine to accept for you, so it only runs once you set the repository variable `ANDROID_EMULATOR_TESTS` to `true`.

**Not done yet:** it hasn't run on a real phone, or with the Spotify app, which needs a phone with a Spotify account. It's signed with a debug key (fine for installing it yourself; the Play Store would need a release key and a developer account).

## iOS: on hold

- iOS has no API for an app to hear other apps. A ReplayKit broadcast extension receives a screen recording's app audio, but it needs the user to start a broadcast from Control Center each time, and whether Spotify's audio arrives there is untested.
- The other way, playing Spotify inside the app with librespot, is the unofficial client the desktop app offers as an off-by-default option; the App Store wouldn't accept it.
- Either needs a paid Apple Developer Program membership to install on a phone beyond seven days, which you said would come later. So iOS waits: in Safari, Phosphor installs as a web app and listens through the microphone.
