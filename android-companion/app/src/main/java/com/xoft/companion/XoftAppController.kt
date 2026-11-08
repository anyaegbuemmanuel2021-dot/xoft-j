package com.xoft.companion
import android.content.Context
import android.content.Intent
import org.json.JSONObject
object XoftAppController {
 fun open(context:Context,p:JSONObject):JSONObject { val pkg=p.optString("packageName").ifBlank{throw IllegalArgumentException("packageName is required")}; val intent=context.packageManager.getLaunchIntentForPackage(pkg) ?: return JSONObject().put("success",false).put("error","Application not installed: $pkg"); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(intent); return JSONObject().put("success",true).put("data",JSONObject().put("packageName",pkg)) }
}
