package app.phosphor.android

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Playback capture (Android 10 and later): the sound other apps play, as
 * full-quality audio, while the user allows it (Android asks each time).
 * Android requires this to run as a foreground service, with a notification.
 * Apps can opt out of being captured; then their sound doesn't arrive.
 */
class CaptureService : Service() {
    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        private const val CHANNEL = "listening"
        private const val RATE = 44100

        @Volatile
        var sink: ((ShortArray) -> Unit)? = null

        @Volatile
        var onState: ((String, String) -> Unit)? = null
    }

    private var projection: MediaProjection? = null
    private var record: AudioRecord? = null
    private var reader: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_DATA)
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val p = if (data != null) manager.getMediaProjection(code, data) else null
        if (p == null) {
            onState?.invoke("error", "Android didn't start the capture.")
            stopSelf()
            return START_NOT_STICKY
        }
        projection = p
        p.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    stopSelf()
                }
            },
            Handler(Looper.getMainLooper()),
        )
        try {
            startCapture(p)
        } catch (e: Exception) {
            onState?.invoke("error", "Playback capture failed: ${e.message ?: e.javaClass.simpleName}")
            stopSelf()
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission") // checked by MainActivity before the service starts
    private fun startCapture(p: MediaProjection) {
        val config = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(maxOf(minimum, RATE * 4 / 5))
            .setAudioPlaybackCaptureConfig(config)
            .build()
        record = r
        r.startRecording()
        reader = Thread {
            // 40 ms at a time, stereo.
            val buffer = ShortArray(RATE / 25 * 2)
            while (record === r) {
                val n = r.read(buffer, 0, buffer.size)
                if (n > 0) sink?.invoke(buffer.copyOf(n)) else if (n < 0) break
            }
        }.apply {
            name = "phosphor-capture"
            start()
        }
        onState?.invoke("listening", "capture")
    }

    private fun stopCapture() {
        val r = record ?: return
        record = null
        // Stopping first ends a read that is waiting, so the reader can finish.
        try {
            r.stop()
        } catch (_: Exception) {
        }
        reader?.join(500)
        reader = null
        r.release()
    }

    override fun onDestroy() {
        stopCapture()
        projection?.stop()
        projection = null
        onState?.invoke("stopped", "capture")
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.listening_channel), NotificationManager.IMPORTANCE_LOW))
        return Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.listening_title))
            .setContentText(getString(R.string.listening_text))
            .setSmallIcon(R.drawable.ic_stat_listen)
            .setOngoing(true)
            .build()
    }
}
