package app.phosphor.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Phosphor for Android: the web app, from the app's own files, in a WebView,
 * plus what a phone browser can't do: hear what the phone plays (the Spotify
 * app, YouTube Music, anything) without the microphone. The page asks for it
 * through window.PhosphorAndroid and gets the sound back as PCM through
 * window.__phosphorNative (see src/app/android.ts).
 */
class MainActivity : Activity() {
    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        private const val REQUEST_AUDIO = 1
        private const val REQUEST_PROJECTION = 2
        // Sign-in pages that must open inside the app (their redirect comes back to it).
        private val SIGN_IN = listOf("accounts.spotify.com", "accounts.google.com", "authorize.music.apple.com", "idmsa.apple.com", "appleid.apple.com")
    }

    lateinit var web: WebView
        private set
    private lateinit var audio: SystemAudio
    private var pendingMode: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val files = WebViewAssetLoader.AssetsPathHandler(this)
        val assets = WebViewAssetLoader.Builder()
            // A folder (the root, where sign-ins come back to) means its index.html.
            .addPathHandler("/") { path -> files.handle(if (path.isEmpty() || path.endsWith("/")) "${path}index.html" else path) }
            .build()

        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: return true
                if (request.url.toString().startsWith(ORIGIN) || SIGN_IN.any { host == it || host.endsWith(".$it") }) return false
                // Anything else (an artist page, the README) opens in the browser.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: Exception) {
                }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // The page's own microphone option (getUserMedia), once Android allows it.
            override fun onPermissionRequest(request: PermissionRequest) {
                val audioOnly = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (audioOnly && hasAudioPermission()) request.grant(request.resources) else request.deny()
            }
        }

        audio = SystemAudio(::deliver, ::state)
        CaptureService.sink = ::deliver
        CaptureService.onState = ::state
        web.addJavascriptInterface(Bridge(), "PhosphorAndroid")
        setContentView(web)
        if (savedInstanceState == null) web.loadUrl("$ORIGIN/") else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onDestroy() {
        audio.stop()
        CaptureService.sink = null
        CaptureService.onState = null
        web.destroy()
        super.onDestroy()
    }

    /** What the page can call. (Runs on the WebView's bridge thread.) */
    inner class Bridge {
        @JavascriptInterface
        fun capabilities(): String = JSONObject()
            .put("sdk", Build.VERSION.SDK_INT)
            .put("version", BuildConfig.VERSION_NAME)
            .put("visualizer", true)
            .put("playbackCapture", Build.VERSION.SDK_INT >= 29)
            .put("permission", hasAudioPermission())
            .toString()

        /** "visualizer" (no asking once allowed) or "capture" (full quality, Android asks each time). */
        @JavascriptInterface
        fun start(mode: String) {
            runOnUiThread { begin(if (mode == "capture") "capture" else "visualizer") }
        }

        @JavascriptInterface
        fun stop() {
            runOnUiThread { end() }
        }
    }

    private fun hasAudioPermission() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun begin(mode: String) {
        if (!hasAudioPermission()) {
            pendingMode = mode
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        end()
        if (mode == "capture") {
            val manager = getSystemService(MediaProjectionManager::class.java)
            @Suppress("DEPRECATION")
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_PROJECTION)
        } else {
            audio.start()
        }
    }

    private fun end() {
        audio.stop()
        stopService(Intent(this, CaptureService::class.java))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_AUDIO) return
        val mode = pendingMode
        pendingMode = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && mode != null) begin(mode) else state("denied", "")
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PROJECTION) return
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(
                Intent(this, CaptureService::class.java)
                    .putExtra(CaptureService.EXTRA_CODE, resultCode)
                    .putExtra(CaptureService.EXTRA_DATA, data),
            )
        } else {
            state("dismissed", "capture")
        }
    }

    /** Sound for the page: little-endian 16-bit stereo, base64 (the page's PcmStream plays it into the analysis only). */
    private fun deliver(pcm: ShortArray) {
        val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asShortBuffer().put(pcm)
        val encoded = Base64.encodeToString(bytes.array(), Base64.NO_WRAP)
        web.post { web.evaluateJavascript("window.__phosphorNative&&window.__phosphorNative.audio('$encoded')", null) }
    }

    private fun state(state: String, detail: String) {
        val json = JSONObject().put("state", state).put("detail", detail).toString()
        web.post { web.evaluateJavascript("window.__phosphorNative&&window.__phosphorNative.state($json)", null) }
    }
}
