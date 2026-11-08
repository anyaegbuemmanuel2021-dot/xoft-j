package com.xoft.companion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
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
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        super.onDestroy()
    }

    inner class Bridge {
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
