package com.xoft.companion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.sqrt
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * Hosts the XOFT live voice screen in a WebView. The page reports its voice state through `window.XoftNative`.
 * When the user leaves the app (Home) during a live conversation, a floating XOFT bubble appears; tapping it
 * returns here.
 */
class LiveActivity : Activity() {
    private lateinit var web: WebView
    @Volatile private var voiceState = "idle"
    @Volatile private var visible = false
    @Volatile private var ttsReady = false
    private var textToSpeech: TextToSpeech? = null
    @Volatile private var audioCaptureWanted = false
    @Volatile private var pendingAudioStart = false
    @Volatile private var audioRecord: AudioRecord? = null
    @Volatile private var audioThread: Thread? = null
    @Volatile private var audioCaptureGeneration = 0L
    private val audioLifecycleLock = Any()
    private val speechHandler = Handler(Looper.getMainLooper())
    private var audioLanguage = "auto"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = XoftConfig.coreUrl(this)
        if (base.isEmpty()) { finish(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
        }
        textToSpeech = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                val languageResult = textToSpeech?.setLanguage(Locale("en", "NG"))
                if (languageResult == TextToSpeech.LANG_MISSING_DATA || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                    textToSpeech?.setLanguage(Locale.US)
                }
                textToSpeech?.setSpeechRate(1.0f)
                textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) { dispatchNativeSpeechState("speaking") }
                    override fun onDone(utteranceId: String?) { dispatchNativeSpeechState("idle") }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) { dispatchNativeSpeechState("error") }
                    override fun onError(utteranceId: String?, errorCode: Int) { dispatchNativeSpeechState("error") }
                })
            }
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            addJavascriptInterface(Bridge(), "XoftNative")
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        val micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        // Only the XOFT origin the user configured may use the microphone.
                        val trusted = request.origin.toString().trimEnd('/') == base
                        if (micGranted && trusted) request.grant(request.resources) else request.deny()
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.toString().startsWith(base)) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
                override fun onPageFinished(view: WebView, url: String) {
                    val key = XoftConfig.apiKey(this@LiveActivity)
                    if (key.isNotEmpty() && url.startsWith(base)) {
                        view.evaluateJavascript("try{localStorage.setItem('xoft_api_key',${JSONObject.quote(key)})}catch(e){}", null)
                    }
                }
            }
        }
        setContentView(web)
        web.loadUrl("$base/#chat")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_MIC) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                if (pendingAudioStart) {
                    pendingAudioStart = false
                    startAudioCapture()
                } else if (::web.isInitialized) web.reload()
            } else {
                pendingAudioStart = false
                dispatchNativeAudioError("Microphone permission was denied.")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        visible = true
        XoftBubbleService.hideBubble(this) // keep the microphone foreground service alive while capture is active
    }

    /** Home / recents pressed while a live conversation is running -> float the XOFT bubble. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        visible = false
        if (voiceState != "idle") XoftBubbleService.show(this, voiceState)
    }

    override fun onDestroy() {
        XoftBubbleService.hide(this)
        if (::web.isInitialized) web.destroy()
        stopAudioCapture()
        XoftBubbleService.stop(this)
        speechHandler.removeCallbacksAndMessages(null)
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        super.onDestroy()
    }

    private fun dispatchNativeAudioError(error: String) {
        if (!::web.isInitialized) return
        runOnUiThread {
            if (!::web.isInitialized) return@runOnUiThread
            val safeError = JSONObject.quote(error)
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('xoft:native-audio-error',{detail:{error:$safeError}}))", null)
        }
    }

    /**
     * Capture 16 kHz mono PCM directly with Android AudioRecord. Local energy VAD opens
     * segments with 500 ms pre-roll and closes after 700 ms of silence. Audio, not a
     * browser recording or Android speech-recognition transcript, is sent to XOFT STT.
     */
    private fun startAudioCapture() {
        if (audioCaptureWanted || !::web.isInitialized) return
        // Never open a second AudioRecord while the previous capture thread is still releasing its recorder.
        if (audioThread?.isAlive == true) {
            dispatchNativeAudioError("The previous microphone session is still closing. Please try listening again.")
            return
        }
        val generation = synchronized(audioLifecycleLock) {
            audioCaptureGeneration += 1
            audioCaptureGeneration
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            dispatchNativeAudioError("Microphone permission is required.")
            return
        }
        // Start the microphone foreground service while the Activity is visible, before AudioRecord.
        // Android 14+ restricts starting microphone foreground services from the background.
        if (!XoftBubbleService.start(this, "listening")) {
            dispatchNativeAudioError("The microphone foreground service could not start. Keep XOFT open and try again.")
            return
        }
        val sampleRate = 16000
        val frameSamples = 480 // 30 ms
        val frameBytes = frameSamples * 2
        val minBytes = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBytes <= 0) {
            dispatchNativeAudioError("Android audio capture is unavailable (buffer configuration failed).")
            return
        }
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBytes, frameBytes * 8)
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            dispatchNativeAudioError("Android microphone could not be initialized.")
            return
        }
        try {
            recorder.startRecording()
        } catch (error: Exception) {
            recorder.release()
            dispatchNativeAudioError("Android microphone could not start: " + (error.message ?: "unknown error"))
            return
        }
        audioRecord = recorder
        audioCaptureWanted = true
        dispatchNativeSpeechState("listening")
        val captureThread = Thread({
            val preRoll = ArrayDeque<ByteArray>()
            var segment = ByteArrayOutputStream()
            var active = false
            var silenceMs = 0
            var segmentMs = 0
            val frame = ByteArray(frameBytes)
            var frameFilled = 0
            try {
                while (isAudioCaptureCurrent(generation) && !Thread.currentThread().isInterrupted) {
                    // AudioRecord may return partial reads. Assemble a full 30 ms PCM frame so
                    // VAD silence and segment timers always reflect real captured duration.
                    val read = recorder.read(frame, frameFilled, frame.size - frameFilled, AudioRecord.READ_BLOCKING)
                    if (read < 0) throw IllegalStateException("AudioRecord.read failed: " + read)
                    if (read == 0) continue
                    frameFilled += read
                    if (frameFilled < frameBytes) continue
                    val exact = frame.copyOf()
                    frameFilled = 0
                    var sum = 0.0
                    var i = 0
                    while (i + 1 < exact.size) {
                        val value = ((exact[i + 1].toInt() shl 8) or (exact[i].toInt() and 0xff)).toShort().toInt()
                        sum += value.toDouble() * value.toDouble()
                        i += 2
                    }
                    val rms = if (i == 0) 0.0 else sqrt(sum / (i / 2))
                    val voiced = rms >= 260.0
                    if (!active) {
                        preRoll.addLast(exact)
                        while (preRoll.size > 17) preRoll.removeFirst() // ~510 ms
                        if (voiced) {
                            active = true
                            segment = ByteArrayOutputStream()
                            for (chunk in preRoll) segment.write(chunk)
                            segmentMs = preRoll.size * 30
                            silenceMs = 0
                            dispatchNativeSpeechState("listening")
                        }
                    } else {
                        segment.write(exact)
                        segmentMs += 30
                        silenceMs = if (voiced) 0 else silenceMs + 30
                        if (silenceMs >= 700 || segmentMs >= 8000) {
                            emitNativeAudio(segment.toByteArray(), sampleRate, generation)
                            active = false
                            silenceMs = 0
                            segmentMs = 0
                            segment = ByteArrayOutputStream()
                            preRoll.clear()
                            dispatchNativeSpeechState("listening")
                        }
                    }
                }
            } catch (error: Exception) {
                if (isAudioCaptureCurrent(generation)) dispatchNativeAudioError("Android audio capture failed: " + (error.message ?: "unknown error"))
            } finally {
                if (isAudioCaptureCurrent(generation) && active && segment.size() > frameBytes * 5) {
                    emitNativeAudio(segment.toByteArray(), sampleRate, generation)
                }
                try { recorder.stop() } catch (_: Exception) { }
                recorder.release()
                synchronized(audioLifecycleLock) {
                    if (audioRecord === recorder) audioRecord = null
                    if (audioThread === Thread.currentThread()) audioThread = null
                    if (audioCaptureGeneration == generation) audioCaptureWanted = false
                }
                if (audioCaptureGeneration == generation) dispatchNativeSpeechState("idle")
            }
        }, "XOFT-AudioRecord").apply { isDaemon = true }
        synchronized(audioLifecycleLock) {
            if (!isAudioCaptureCurrent(generation)) {
                try { recorder.stop() } catch (_: Exception) { }
                recorder.release()
                return
            }
            // Publish the thread reference before starting it. Otherwise an immediate read
            // failure can run finally before audioThread is assigned and leave a dead thread
            // permanently registered as the active capture.
            audioThread = captureThread
            try {
                captureThread.start()
            } catch (error: Exception) {
                if (audioThread === captureThread) audioThread = null
                if (audioRecord === recorder) audioRecord = null
                if (audioCaptureGeneration == generation) audioCaptureWanted = false
                try { recorder.stop() } catch (_: Exception) { }
                recorder.release()
                dispatchNativeAudioError("Android microphone thread could not start: " + (error.message ?: "unknown error"))
            }
        }
    }

    private fun isAudioCaptureCurrent(generation: Long): Boolean =
        audioCaptureWanted && audioCaptureGeneration == generation

    private fun emitNativeAudio(pcm: ByteArray, sampleRate: Int, generation: Long) {
        if (pcm.isEmpty() || !::web.isInitialized || !isAudioCaptureCurrent(generation)) return
        val header = ByteArray(44)
        fun putAscii(offset: Int, value: String) { value.toByteArray(Charsets.US_ASCII).copyInto(header, offset) }
        fun putInt(offset: Int, value: Int) {
            header[offset] = value.toByte()
            header[offset + 1] = (value shr 8).toByte()
            header[offset + 2] = (value shr 16).toByte()
            header[offset + 3] = (value shr 24).toByte()
        }
        putAscii(0, "RIFF"); putInt(4, 36 + pcm.size); putAscii(8, "WAVE")
        putAscii(12, "fmt "); putInt(16, 16)
        header[20] = 1; header[22] = 1
        putInt(24, sampleRate); putInt(28, sampleRate * 2)
        header[32] = 2; header[34] = 16
        putAscii(36, "data"); putInt(40, pcm.size)
        val wav = ByteArray(header.size + pcm.size)
        header.copyInto(wav); pcm.copyInto(wav, header.size)
        val encoded = Base64.encodeToString(wav, Base64.NO_WRAP)
        runOnUiThread {
            if (!::web.isInitialized || !isAudioCaptureCurrent(generation)) return@runOnUiThread
            val safe = JSONObject.quote(encoded)
            val lang = JSONObject.quote(audioLanguage)
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('xoft:native-audio',{detail:{base64:$safe,mime:'audio/wav',language:$lang}}))", null)
        }
    }

    private fun stopAudioCapture() {
        // A permission dialog may still be open; stopping the session must cancel its deferred start.
        pendingAudioStart = false
        val thread: Thread?
        synchronized(audioLifecycleLock) {
            audioCaptureWanted = false
            audioCaptureGeneration += 1 // invalidates queued frames and stale thread cleanup callbacks
            thread = audioThread
            try { audioRecord?.stop() } catch (_: Exception) { }
            thread?.interrupt()
        }
        // Give AudioRecord.read() time to unblock and release the hardware before another session starts.
        if (thread != null && thread !== Thread.currentThread()) {
            try { thread.join(750) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        }
        synchronized(audioLifecycleLock) {
            if (audioThread === thread && thread?.isAlive != true) audioThread = null
            if (audioThread == null) audioRecord = null
        }
        // Stop the FGS only after AudioRecord has been asked to stop and its thread has had time to release it.
        XoftBubbleService.stop(this)
    }

    private fun dispatchNativeSpeechState(state: String) {
        if (!::web.isInitialized) return
        runOnUiThread {
            if (!::web.isInitialized) return@runOnUiThread
            val safe = JSONObject.quote(state)
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('xoft:native-speech-state',{detail:{state:$safe}}))", null)
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun canCaptureAudio(): Boolean {
            // Advertise the native capture capability before the first runtime permission prompt.
            return Build.VERSION.SDK_INT >= 26
        }

        @JavascriptInterface
        fun startAudioListening(language: String): Boolean {
            if (!canCaptureAudio() || audioCaptureWanted || pendingAudioStart) return false
            audioLanguage = when (language.trim().lowercase(Locale.ROOT)) {
                "ig" -> "ig"
                "en" -> "en"
                "pcm", "pidgin" -> "pcm" // preserve Nigerian Pidgin selection through native AudioRecord
                else -> "auto"
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingAudioStart = true
                runOnUiThread { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC) }
                return true
            }
            runOnUiThread { startAudioCapture() }
            return true
        }

        @JavascriptInterface
        fun stopAudioListening() { stopAudioCapture() }

        @JavascriptInterface
        fun speak(text: String): Boolean {
            if (!ttsReady || text.isBlank()) return false
            val clean = text.take(4000)
            val utteranceId = "xoft-" + System.currentTimeMillis().toString()
            return textToSpeech?.speak(clean, TextToSpeech.QUEUE_FLUSH, null, utteranceId) == TextToSpeech.SUCCESS
        }

        @JavascriptInterface
        fun stopSpeaking() {
            textToSpeech?.stop()
            dispatchNativeSpeechState("idle")
        }

        @JavascriptInterface
        fun onVoiceState(state: String) {
            voiceState = if (state == "listening" || state == "thinking" || state == "speaking") state else "idle"
            if (!visible) XoftBubbleService.updateState(voiceState)
        }
    }

    companion object {
        private const val REQUEST_MIC = 7
        fun overlaySettingsIntent(context: android.content.Context): Intent =
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
    }
}
