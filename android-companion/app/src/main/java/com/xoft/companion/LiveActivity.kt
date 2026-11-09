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
    @Volatile private var audioRecord: AudioRecord? = null
    @Volatile private var audioThread: Thread? = null
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
        if (requestCode == REQUEST_MIC && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) web.reload()
    }

    override fun onResume() {
        super.onResume()
        visible = true
        XoftBubbleService.hide(this) // back in the app: the bubble is no longer needed
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
        speechHandler.removeCallbacksAndMessages(null)
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        super.onDestroy()
    }

    private fun dispatchNativeTranscript(text: String, isFinal: Boolean, error: String? = null) {
        if (!::web.isInitialized) return
        runOnUiThread {
            if (!::web.isInitialized) return@runOnUiThread
            val safeError = JSONObject.quote(error ?: "")
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
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            dispatchNativeTranscript("", true, "Microphone permission is required.")
            return
        }
        val sampleRate = 16000
        val frameSamples = 480 // 30 ms
        val frameBytes = frameSamples * 2
        val minBytes = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBytes <= 0) {
            dispatchNativeTranscript("", true, "Android audio capture is unavailable (buffer configuration failed).")
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
            dispatchNativeTranscript("", true, "Android microphone could not be initialized.")
            return
        }
        audioRecord = recorder
        audioCaptureWanted = true
        recorder.startRecording()
        dispatchNativeSpeechState("listening")
        audioThread = Thread({
            val preRoll = ArrayDeque<ByteArray>()
            var segment = ByteArrayOutputStream()
            var active = false
            var silenceMs = 0
            var segmentMs = 0
            val frame = ByteArray(frameBytes)
            try {
                while (audioCaptureWanted && !Thread.currentThread().isInterrupted) {
                    val read = recorder.read(frame, 0, frame.size, AudioRecord.READ_BLOCKING)
                    if (read <= 0) continue
                    val exact = if (read == frame.size) frame.copyOf() else frame.copyOf(read - (read % 2))
                    if (exact.isEmpty()) continue
                    var sum = 0.0
                    var i = 0
                    while (i + 1 < exact.size) {
                        val value = ((exact[i + 1].toInt() shl 8) or (exact[i].toInt() and 0xff)).toShort().toInt()
                        sum += value.toDouble() * value.toDouble()
                        i += 2
                    }
                    val rms = if (i == 0) 0.0 else sqrt(sum / (i / 2))
                    val voiced = rms >= 520.0
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
                        if (silenceMs >= 700 || segmentMs >= 15000) {
                            emitNativeAudio(segment.toByteArray(), sampleRate)
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
                if (audioCaptureWanted) dispatchNativeTranscript("", true, "Android audio capture failed: " + (error.message ?: "unknown error"))
            } finally {
                if (active && segment.size() > frameBytes * 5) emitNativeAudio(segment.toByteArray(), sampleRate)
                try { recorder.stop() } catch (_: Exception) { }
                recorder.release()
                if (audioRecord === recorder) audioRecord = null
                dispatchNativeSpeechState("idle")
            }
        }, "XOFT-AudioRecord").apply { isDaemon = true; start() }
    }

    private fun emitNativeAudio(pcm: ByteArray, sampleRate: Int) {
        if (pcm.isEmpty() || !::web.isInitialized) return
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
            if (!::web.isInitialized) return@runOnUiThread
            val safe = JSONObject.quote(encoded)
            val lang = JSONObject.quote(audioLanguage)
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('xoft:native-audio',{detail:{base64:$safe,mime:'audio/wav',language:$lang}}))", null)
        }
    }

    private fun stopAudioCapture() {
        audioCaptureWanted = false
        try { audioRecord?.stop() } catch (_: Exception) { }
        audioThread?.interrupt()
        audioThread = null
        audioRecord = null
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
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                && Build.VERSION.SDK_INT >= 26
        }

        @JavascriptInterface
        fun startAudioListening(language: String): Boolean {
            if (!canCaptureAudio() || audioCaptureWanted) return false
            audioLanguage = if (language == "ig") "ig" else if (language == "en") "en" else "auto"
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
