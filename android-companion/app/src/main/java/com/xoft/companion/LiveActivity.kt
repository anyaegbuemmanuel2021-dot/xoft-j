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
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
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
    private var speechRecognizer: SpeechRecognizer? = null
    @Volatile private var recognitionWanted = false
    private val speechHandler = Handler(Looper.getMainLooper())
    private var recognitionLanguage = "en-NG"

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
        recognitionWanted = false
        speechHandler.removeCallbacksAndMessages(null)
        try { speechRecognizer?.cancel() } catch (_: Exception) { }
        try { speechRecognizer?.destroy() } catch (_: Exception) { }
        speechRecognizer = null
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        super.onDestroy()
    }

    private fun dispatchNativeTranscript(text: String, isFinal: Boolean, error: String? = null) {
        if (!::web.isInitialized) return
        runOnUiThread {
            if (!::web.isInitialized) return@runOnUiThread
            val safeText = JSONObject.quote(text)
            val safeError = JSONObject.quote(error ?: "")
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('xoft:native-transcript',{detail:{text:$safeText,isFinal:$isFinal,error:$safeError}}))", null)
        }
    }

    private fun startRecognitionSession() {
        if (!recognitionWanted || !::web.isInitialized) return
        if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            dispatchNativeTranscript("", true, "On-device speech recognition is unavailable on this device.")
            recognitionWanted = false
            return
        }
        try { speechRecognizer?.destroy() } catch (_: Exception) { }
        speechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { dispatchNativeSpeechState("listening") }
                override fun onBeginningOfSpeech() { dispatchNativeSpeechState("listening") }
                override fun onRmsChanged(rmsdB: Float) { }
                override fun onBufferReceived(buffer: ByteArray?) { }
                override fun onEndOfSpeech() { }
                override fun onError(error: Int) {
                    if (!recognitionWanted) return
                    dispatchNativeTranscript("", true, "Native recognizer error: " + error)
                    speechHandler.postDelayed({ startRecognitionSession() }, 700)
                }
                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    if (text.isNotBlank()) dispatchNativeTranscript(text, true)
                    if (recognitionWanted) speechHandler.postDelayed({ startRecognitionSession() }, 250)
                }
                override fun onPartialResults(partialResults: Bundle?) { }
                override fun onEvent(eventType: Int, params: Bundle?) { }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, recognitionLanguage)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            }
            startListening(intent)
        }
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
        fun canListenOffline(): Boolean {
            return Build.VERSION.SDK_INT >= 31
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(this@LiveActivity)
        }

        @JavascriptInterface
        fun startListening(language: String): Boolean {
            if (!canListenOffline()) return false
            recognitionLanguage = if (language == "ig") "ig-NG" else "en-NG"
            recognitionWanted = true
            runOnUiThread { startRecognitionSession() }
            return true
        }

        @JavascriptInterface
        fun stopListening() {
            recognitionWanted = false
            speechHandler.removeCallbacksAndMessages(null)
            runOnUiThread {
                try { speechRecognizer?.cancel() } catch (_: Exception) { }
                try { speechRecognizer?.destroy() } catch (_: Exception) { }
                speechRecognizer = null
            }
        }

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
