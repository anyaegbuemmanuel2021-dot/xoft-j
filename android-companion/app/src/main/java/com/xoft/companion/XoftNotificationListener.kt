package com.xoft.companion
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
object XoftNotificationListener { var instance: XoftNotificationListenerService?=null; val enabled get()=instance!=null; fun snapshot():JSONObject { val s=instance?:return JSONObject().put("success",false).put("error","Notification access is not enabled by the user."); val a=JSONArray(); s.activeNotifications.take(50).forEach{n->a.put(JSONObject().put("packageName",n.packageName).put("title",n.notification.extras.getString("android.title")).put("text",n.notification.extras.getCharSequence("android.text")?.toString()).put("postTime",n.postTime)}; return JSONObject().put("success",true).put("data",JSONObject().put("notifications",a)) } }
class XoftNotificationListenerService:NotificationListenerService(){ override fun onListenerConnected(){XoftNotificationListener.instance=this}; override fun onListenerDisconnected(){XoftNotificationListener.instance=null} }
