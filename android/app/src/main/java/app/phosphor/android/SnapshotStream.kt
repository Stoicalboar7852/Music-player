package app.phosphor.android

import kotlin.math.roundToInt

/**
 * Turns the Visualizer API's waveform snapshots (about 1024 samples, 8-bit,
 * at most around 20 a second) into a continuous 16-bit stereo stream at
 * [outRate], by looping each snapshot, with a short crossfade at the loop
 * point, until the next one arrives. The page analyses that stream like any
 * other input: its spectrum and loudness follow the music; timing finer than
 * the gap between snapshots is lost.
 */
class SnapshotStream(private val outRate: Int = 44100, private val fade: Int = 64) {
    private var grain = FloatArray(0)
    private var pos = 0
    private var lastNanos = Long.MIN_VALUE
    private var carry = 0.0

    /**
     * Adds a snapshot taken at [nowNanos]. Returns the samples (interleaved
     * stereo) that cover the time since the previous snapshot, at most a
     * quarter of a second; empty for the first one.
     */
    fun push(waveform: ByteArray, samplingRateMilliHz: Int, nowNanos: Long): ShortArray {
        val out: ShortArray
        if (lastNanos == Long.MIN_VALUE || grain.isEmpty()) {
            out = ShortArray(0)
        } else {
            val elapsed = (nowNanos - lastNanos).coerceIn(0L, MAX_GAP_NANOS)
            val exact = elapsed.toDouble() * outRate / 1e9 + carry
            val frames = exact.toInt()
            carry = exact - frames
            out = ShortArray(frames * 2)
            for (i in 0 until frames) {
                val v = (grain[pos] * 32767f).roundToInt().coerceIn(-32768, 32767).toShort()
                out[i * 2] = v
                out[i * 2 + 1] = v
                pos++
                if (pos >= grain.size) pos = 0
            }
        }
        lastNanos = nowNanos
        val rate = if (samplingRateMilliHz > 0) samplingRateMilliHz / 1000.0 else outRate.toDouble()
        grain = loopable(resample(waveform, rate))
        pos = 0
        return out
    }

    /** 8-bit unsigned samples (128 is silence) to floats at [outRate]. */
    private fun resample(waveform: ByteArray, rate: Double): FloatArray {
        if (waveform.isEmpty()) return FloatArray(0)
        val input = FloatArray(waveform.size) { ((waveform[it].toInt() and 0xff) - 128) / 128f }
        val length = (input.size * outRate / rate).roundToInt().coerceAtLeast(1)
        val step = rate / outRate
        return FloatArray(length) { i ->
            val x = i * step
            val i0 = x.toInt().coerceAtMost(input.size - 1)
            val i1 = (i0 + 1).coerceAtMost(input.size - 1)
            val f = (x - i0).toFloat()
            input[i0] + (input[i1] - input[i0]) * f
        }
    }

    /** The grain shortened by [fade] samples, its end faded into its start, so it loops without a click. */
    private fun loopable(g: FloatArray): FloatArray {
        if (g.size <= fade * 2) return g
        val n = g.size - fade
        return FloatArray(n) { i ->
            if (i < fade) {
                val t = i.toFloat() / fade
                g[i] * t + g[n + i] * (1 - t)
            } else {
                g[i]
            }
        }
    }

    companion object {
        const val MAX_GAP_NANOS = 250_000_000L
    }
}
