package com.xoft.companion

import android.content.Context

object XoftConfig {
    private const val PREFS = "xoft"
    private const val URL = "coreUrl"
    private const val KEY = "apiKey"
    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun coreUrl(context: Context) = prefs(context).getString(URL, "")!!.trimEnd('/')
    fun apiKey(context: Context) = prefs(context).getString(KEY, "") ?: ""
    fun save(context: Context, url: String, key: String) = prefs(context).edit().putString(URL, url.trimEnd('/')).putString(KEY, key).apply()
}
