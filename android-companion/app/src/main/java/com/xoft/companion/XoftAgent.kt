package com.xoft.companion

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

object XoftAgent {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var deviceId: String? = null
    fun start(context: Context) {
        if (running) return
        if (XoftConfig.coreUrl(context).isBlank()) return
        running = true
        val prefs = XoftConfig.prefs(context)
        deviceId = prefs.getString("deviceId", null)
        handler.post(object: Runnable { override fun run() { executor.execute { tick(context.applicationContext) }; if (running) handler.postDelayed(this, 5000) } })
    }
    fun stop() { running=false; handler.removeCallbacksAndMessages(null) }
    private fun tick(context: Context) {
        try {
            val id = deviceId ?: register(context).also { deviceId=it; XoftConfig.prefs(context).edit().putString("deviceId",it).apply() }
            api(context,"POST","/api/devices/$id/heartbeat", "{}")
            val caps = mutableListOf("system","applications","screen")
            if (XoftNotificationListener.enabled) caps.add("notifications")
            api(context,"POST","/api/devices/$id/capabilities",JSONObject().put("capabilities",JSONArray(caps)).toString())
            val battery=(context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            api(context,"POST","/api/devices/$id/state",JSONObject().put("state",JSONObject().put("battery",battery).put("model",Build.MODEL).put("androidVersion",Build.VERSION.RELEASE).put("locked",false)).toString())
            val commands=api(context,"GET","/api/devices/$id/commands/pending",null).optJSONArray("commands") ?: JSONArray()
            for(i in 0 until commands.length()) dispatch(context,id,commands.getJSONObject(i))
        } catch (_: Exception) { }
    }
    private fun register(context: Context): String = api(context,"POST","/api/devices",JSONObject().put("name","Android - ${Build.MODEL}").put("platform","android").toString()).getString("id")
    private fun dispatch(context: Context,id:String,c:JSONObject) {
        val cap=c.getString("capability"); val action=c.getString("action"); val p=c.optJSONObject("parameters") ?: JSONObject()
        val result=try { when("$cap.$action") {
            "system.read_system_info" -> JSONObject().put("success",true).put("data",JSONObject().put("battery",(context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)).put("model",Build.MODEL))
            "applications.open_application" -> XoftAppController.open(context,p)
            "notifications.list" -> XoftNotificationListener.snapshot()
            "screen.click","screen.type","screen.scroll" -> XoftAccessibilityService.execute(action,p)
            else -> JSONObject().put("success",false).put("error","Unsupported Android command: $cap.$action")
        }} catch(e:Exception){ JSONObject().put("success",false).put("error",e.message ?: "Command failed") }
        api(context,"POST","/api/devices/$id/commands/${c.getString("id")}/result",result.toString())
    }
    fun api(context:Context,method:String,path:String,body:String?):JSONObject {
        val base=XoftConfig.coreUrl(context); require(base.isNotBlank())
        val conn=URL(base+path).openConnection() as HttpURLConnection
        conn.requestMethod=method; conn.connectTimeout=5000; conn.readTimeout=10000; conn.setRequestProperty("Content-Type","application/json")
        XoftConfig.apiKey(context).takeIf{it.isNotBlank()}?.let{conn.setRequestProperty("Authorization","Bearer $it")}
        conn.doInput=true; conn.doOutput=body!=null
        if(body!=null) conn.outputStream.use{it.write(body.toByteArray(Charsets.UTF_8))}
        val code=conn.responseCode; val stream=if(code in 200..299) conn.inputStream else conn.errorStream
        val text=stream?.bufferedReader()?.use{it.readText()} ?: "{}"; conn.disconnect()
        if(code !in 200..299) throw IllegalStateException("XOFT API $code: $text")
        return if(text.isBlank()) JSONObject() else JSONObject(text)
    }
}
