package app.phosphor.android

import android.Manifest
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

/**
 * On an emulator (CI): the app opens Phosphor, and when the page asks to
 * listen to the phone, what another player plays (a test signal through
 * AudioTrack here, standing in for the Spotify app) drives the visualizers.
 */
@RunWith(AndroidJUnit4::class)
class SystemAudioTest {
    @get:Rule
    val rule = ActivityScenarioRule(MainActivity::class.java)

    private fun js(script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        rule.scenario.onActivity { activity ->
            activity.web.evaluateJavascript(script) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun waitFor(script: String, seconds: Int, test: (String) -> Boolean): String {
        var last = ""
        repeat(seconds * 4) {
            last = js(script)
            if (test(last)) return last
            Thread.sleep(250)
        }
        return last
    }

    /** Two seconds of a beat: a low thump twice a second and a high tick between, looped. */
    private fun testSignal(): AudioTrack {
        val rate = 44100
        val samples = ShortArray(rate * 2)
        for (i in samples.indices) {
            val t = (i % (rate / 2)).toDouble() / rate
            val thump = if (t < 0.12) sin(2 * PI * 70 * t) * (1 - t / 0.12) else 0.0
            val tick = if (t in 0.25..0.27) sin(2 * PI * 6000 * t) * 0.4 else 0.0
            val pad = sin(2 * PI * 440 * i / rate) * 0.15
            samples[i] = ((thump * 0.8 + tick + pad) * 32767 * 0.8).toInt().toShort()
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(samples.size * 2)
            .build()
        track.write(samples, 0, samples.size)
        track.setLoopPoints(0, samples.size, -1)
        return track
    }

    @Test
    fun theVisualizersHearWhatThePhonePlays() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)

        val ready = waitFor("window.__phosphor ? 'ready' : ''", 60) { it.contains("ready") }
        assertTrue("Phosphor didn't start in the WebView: $ready", ready.contains("ready"))
        val caps = js("window.PhosphorAndroid.capabilities()")
        assertTrue("the bridge reports the permission: $caps", caps.contains("permission\\\":true"))

        val track = testSignal()
        track.play()
        try {
            js("window.__phosphor.app.listenToPhone('visualizer')")
            val state = waitFor("JSON.stringify(window.__phosphor.capture.state)", 20) { it.contains("active\\\":true") }
            assertTrue("listening to the phone: $state", state.contains("active\\\":true"))
            Thread.sleep(4000)
            val level = js("String(window.__phosphor.renderer.audio.level)").trim('"').toDoubleOrNull() ?: 0.0
            val input = js("window.__phosphor.engine.analysisInput")
            assertTrue("the visualizers react (level $level, input $input)", level > 0.01 && input.contains("capture"))
        } finally {
            track.stop()
            track.release()
        }
    }
}
