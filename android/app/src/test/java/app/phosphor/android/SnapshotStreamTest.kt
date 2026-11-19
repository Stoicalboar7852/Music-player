package app.phosphor.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

class SnapshotStreamTest {
    private fun sine(freq: Double, rate: Int, n: Int = 1024, amplitude: Double = 1.0) =
        ByteArray(n) { i -> (128 + 127 * amplitude * sin(2 * PI * freq * i / rate)).roundToInt().coerceIn(0, 255).toByte() }

    private fun crossings(samples: ShortArray): Int {
        var count = 0
        for (i in 2 until samples.size step 2) if ((samples[i - 2] < 0) != (samples[i] < 0)) count++
        return count
    }

    @Test
    fun firstSnapshotOnlyPrimes() {
        val s = SnapshotStream()
        assertEquals(0, s.push(sine(441.0, 44100), 44_100_000, 0L).size)
    }

    @Test
    fun coversTheTimeBetweenSnapshotsAsStereo() {
        val s = SnapshotStream()
        s.push(sine(441.0, 44100), 44_100_000, 0L)
        val out = s.push(sine(441.0, 44100), 44_100_000, 50_000_000L)
        assertEquals(2205 * 2, out.size)
        for (i in out.indices step 2) assertEquals(out[i], out[i + 1])
    }

    @Test
    fun keepsTheFrequency() {
        val s = SnapshotStream()
        s.push(sine(441.0, 44100), 44_100_000, 0L)
        val out = s.push(sine(441.0, 44100), 44_100_000, 50_000_000L)
        // 441 Hz over 50 ms: about 44 zero crossings.
        val c = crossings(out)
        assertTrue("crossings $c", c in 40..48)
    }

    @Test
    fun resamplesOtherRates() {
        val s = SnapshotStream()
        s.push(sine(480.0, 48000), 48_000_000, 0L)
        val out = s.push(sine(480.0, 48000), 48_000_000, 100_000_000L)
        assertEquals(4410 * 2, out.size)
        val c = crossings(out)
        // 480 Hz over 100 ms: about 96 crossings.
        assertTrue("crossings $c", c in 90..102)
    }

    @Test
    fun keepsTheLoudness() {
        val s = SnapshotStream()
        s.push(sine(441.0, 44100, amplitude = 1.0), 44_100_000, 0L)
        val loud = s.push(sine(441.0, 44100, amplitude = 0.25), 44_100_000, 50_000_000L)
        val quiet = s.push(sine(441.0, 44100), 44_100_000, 100_000_000L)
        val peakLoud = loud.maxOf { abs(it.toInt()) }
        val peakQuiet = quiet.maxOf { abs(it.toInt()) }
        assertTrue("loud peak $peakLoud", peakLoud > 30000)
        assertTrue("quiet peak $peakQuiet", peakQuiet in 7000..9500)
    }

    @Test
    fun silenceStaysSilent() {
        val s = SnapshotStream()
        val silent = ByteArray(1024) { 128.toByte() }
        s.push(silent, 44_100_000, 0L)
        val out = s.push(silent, 44_100_000, 50_000_000L)
        assertTrue(out.all { it.toInt() == 0 })
    }

    @Test
    fun aLongPauseIsCappedAtAQuarterSecond() {
        val s = SnapshotStream()
        s.push(sine(441.0, 44100), 44_100_000, 0L)
        val out = s.push(sine(441.0, 44100), 44_100_000, 3_000_000_000L)
        assertEquals(11025 * 2, out.size)
    }

    @Test
    fun timingDoesNotDriftOverManySnapshots() {
        val s = SnapshotStream()
        var frames = 0
        var t = 0L
        s.push(sine(441.0, 44100), 44_100_000, t)
        repeat(200) {
            t += 48_700_000L
            frames += s.push(sine(441.0, 44100), 44_100_000, t).size / 2
        }
        val expected = (t / 1e9 * 44100).roundToInt()
        assertTrue("frames $frames vs $expected", abs(frames - expected) <= 1)
    }
}
