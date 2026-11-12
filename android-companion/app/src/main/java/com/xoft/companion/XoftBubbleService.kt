package com.xoft.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView

/**
 * Microphone foreground service plus floating XOFT bubble. The service is started while LiveActivity is visible,
 * before AudioRecord opens, so Android 14+ background-start restrictions are respected. The bubble itself is only
 * shown after the user leaves the Activity.
 */
class XoftBubbleService : Service() {
    private var windowManager: WindowManager? = null
    private var bubble: FrameLayout? = null
    private var ring: GradientDrawable? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        starting = false
        instance = this
        startAsForeground()
        val action = intent?.action
        if ((action == ACTION_SHOW_BUBBLE || pendingShowBubble) && Settings.canDrawOverlays(this) && bubble == null) {
            addBubble()
            pendingShowBubble = false
        }
        if (action == ACTION_HIDE_BUBBLE) {
            pendingShowBubble = false
            removeBubble()
        }
        applyState(intent?.getStringExtra(EXTRA_STATE) ?: "listening")
        return START_NOT_STICKY
    }

    private fun startAsForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "XOFT live voice", NotificationManager.IMPORTANCE_LOW))
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("XOFT live conversation")
            .setContentText("Tap the floating bubble to return")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(NOTIFICATION_ID, notification)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun addBubble() {
        val manager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        windowManager = manager
        val size = dp(64)
        val border = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.BLACK); setStroke(dp(3), COLOR_IDLE) }
        ring = border
        val image = ImageView(this).apply {
            setImageResource(R.drawable.xoft_core)
            scaleType = ImageView.ScaleType.CENTER_CROP
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
            }
            clipToOutline = true
        }
        val root = FrameLayout(this).apply {
            background = border
            setPadding(dp(3), dp(3), dp(3), dp(3))
            elevation = dp(8).toFloat()
            contentDescription = "Return to XOFT conversation"
            addView(image, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        val params = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - size - dp(12)
            y = resources.displayMetrics.heightPixels / 2
        }
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var startX = 0; var startY = 0; var touchX = 0f; var touchY = 0f; var moved = false
        root.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> { startX = params.x; startY = params.y; touchX = event.rawX; touchY = event.rawY; moved = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt(); val dy = (event.rawY - touchY).toInt()
                    if (!moved && (Math.abs(dx) > slop || Math.abs(dy) > slop)) moved = true
                    if (moved) {
                        params.x = (startX + dx).coerceIn(0, resources.displayMetrics.widthPixels - size)
                        params.y = (startY + dy).coerceIn(0, resources.displayMetrics.heightPixels - size)
                        manager.updateViewLayout(root, params)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!moved) returnToApp(); true }
                else -> false
            }
        }
        manager.addView(root, params)
        bubble = root
    }

    private fun returnToApp() {
        startActivity(Intent(this, LiveActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }

    private fun removeBubble() {
        bubble?.let { view -> try { windowManager?.removeView(view) } catch (_: Exception) { /* already removed */ } }
        bubble = null
        ring = null
    }

    private fun applyState(state: String) {
        val color = when (state) {
            "listening" -> COLOR_LISTENING
            "speaking" -> COLOR_SPEAKING
            "thinking" -> COLOR_THINKING
            else -> COLOR_IDLE
        }
        ring?.setStroke(dp(3), color)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        starting = false
        removeBubble()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "xoft_live"
        private const val NOTIFICATION_ID = 43
        const val EXTRA_STATE = "state"
        private const val ACTION_SHOW_BUBBLE = "com.xoft.companion.action.SHOW_BUBBLE"
        private const val ACTION_HIDE_BUBBLE = "com.xoft.companion.action.HIDE_BUBBLE"
        private const val ACTION_START_CAPTURE = "com.xoft.companion.action.START_CAPTURE"
        private const val COLOR_IDLE = 0xFF5A6B78.toInt()
        private const val COLOR_LISTENING = 0xFF4FFFD0.toInt()
        private const val COLOR_SPEAKING = 0xFF6BE7FF.toInt()
        private const val COLOR_THINKING = 0xFFB7A0FF.toInt()

        @Volatile private var instance: XoftBubbleService? = null
        @Volatile private var starting = false
        @Volatile private var pendingShowBubble = false

        /** Called from the WebView bridge thread: recolour the ring while the bubble is visible. */
        fun updateState(state: String) {
            val service = instance ?: return
            service.main.post { service.applyState(state) }
        }

        /** Start the microphone FGS from the visible Activity before AudioRecord starts. */
        fun start(context: Context, state: String): Boolean {
            if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) return false
            // Once started from the visible Activity, reuse the same FGS for later listen cycles in background.
            val running = instance
            if (running != null || starting) {
                running?.let { service -> service.main.post { service.applyState(state) } }
                return true
            }
            starting = true
            return try {
                context.startForegroundService(
                    Intent(context, XoftBubbleService::class.java)
                        .setAction(ACTION_START_CAPTURE)
                        .putExtra(EXTRA_STATE, state)
                )
                true
            } catch (_: RuntimeException) {
                starting = false
                false
            }
        }

        /** Show the overlay only after the already-running microphone FGS survives Home. */
        fun show(context: Context, state: String) {
            if (!Settings.canDrawOverlays(context)) return
            pendingShowBubble = true
            val service = instance ?: return // onStartCommand consumes this flag if Home wins the startup race
            service.main.post {
                if (pendingShowBubble && service.bubble == null) service.addBubble()
                pendingShowBubble = false
                service.applyState(state)
            }
        }

        /** Returning to the Activity hides the overlay but does not stop microphone capture. */
        fun hideBubble(context: Context) {
            pendingShowBubble = false
            val service = instance ?: return
            service.main.post { service.removeBubble() }
        }

        fun stop(context: Context) {
            pendingShowBubble = false
            starting = false
            context.stopService(Intent(context, XoftBubbleService::class.java))
        }
    }
}
