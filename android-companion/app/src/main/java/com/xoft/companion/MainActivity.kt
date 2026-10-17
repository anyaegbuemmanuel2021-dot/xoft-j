package com.xoft.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.widget.*

class MainActivity : Activity() {
    private lateinit var status: TextView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = EditText(this).apply { hint = "https://your-xoft-core.example.com"; setText(XoftConfig.coreUrl(this@MainActivity)); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }
        val key = EditText(this).apply { hint = "API key"; setText(XoftConfig.apiKey(this@MainActivity)); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        status = TextView(this).apply { text = "Not configured"; gravity = Gravity.CENTER }
        val save = Button(this).apply { text = "Save & Start Agent"; setOnClickListener {
            XoftConfig.save(this@MainActivity, url.text.toString(), key.text.toString())
            startForegroundService(Intent(this@MainActivity, XoftAgentService::class.java)); status.text = "Agent started. Enable permissions below."
        }}
        val accessibility = Button(this).apply { text = "Enable Accessibility"; setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) } }
        val notifications = Button(this).apply { text = "Enable Notification Access"; setOnClickListener { startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")) } }
        setContentView(LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(32,32,32,32); addView(TextView(this@MainActivity).apply { text="XOFT Companion"; textSize=28f }); addView(url); addView(key); addView(save); addView(accessibility); addView(notifications); addView(status) })
    }
}
