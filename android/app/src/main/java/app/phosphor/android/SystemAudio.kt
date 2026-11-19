package app.phosphor.android

import android.media.audiofx.Visualizer
import android.os.SystemClock

/**
 * Hears what the phone plays through Android's Visualizer API on the output
 * mix (session 0): waveform snapshots of everything playing, the Spotify app
 * included, turned into a continuous stream for the page (see SnapshotStream).
 * Needs the "record audio" permission once; it never uses the microphone.
 */
class SystemAudio(
    private val deliver: (ShortArray) -> Unit,
    private val onState: (state: String, detail: String) -> Unit,
) {
    private var visualizer: Visualizer? = null
    private val stream = SnapshotStream()

    val running: Boolean
        get() = visualizer != null

    fun start(): Boolean {
        stop()
        return try {
            val v = Visualizer(0)
            v.enabled = false
            v.captureSize = Visualizer.getCaptureSizeRange()[1]
            // Keep the music's own loudness (normalised snapshots would hide its dynamics).
            v.scalingMode = Visualizer.SCALING_MODE_AS_PLAYED
            v.setDataCaptureListener(
                object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(vis: Visualizer?, waveform: ByteArray?, samplingRate: Int) {
                        if (waveform == null || waveform.isEmpty()) return
                        val pcm = stream.push(waveform, samplingRate, SystemClock.elapsedRealtimeNanos())
                        if (pcm.isNotEmpty()) deliver(pcm)
                    }

                    override fun onFftDataCapture(vis: Visualizer?, fft: ByteArray?, samplingRate: Int) {}
                },
                Visualizer.getMaxCaptureRate(),
                true,
                false,
            )
            v.enabled = true
            visualizer = v
            onState("listening", "visualizer")
            true
        } catch (e: Exception) {
            visualizer = null
            onState("error", "This phone doesn't let apps listen to its sound this way (${e.message ?: e.javaClass.simpleName}). Try Settings → Streaming audio → playback capture.")
            false
        }
    }

    fun stop() {
        val v = visualizer ?: return
        visualizer = null
        try {
            v.enabled = false
        } catch (_: Exception) {
        }
        v.release()
        onState("stopped", "visualizer")
    }
}
