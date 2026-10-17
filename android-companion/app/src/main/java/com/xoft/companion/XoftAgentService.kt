package com.xoft.companion

import android.app.*
import android.content.Intent
import android.os.IBinder

class XoftAgentService : Service() {
    override fun onCreate() { super.onCreate(); val channel=NotificationChannel("xoft","XOFT Agent",NotificationManager.IMPORTANCE_LOW); getSystemService(NotificationManager::class.java).createNotificationChannel(channel); startForeground(42,Notification.Builder(this,"xoft").setContentTitle("XOFT Companion").setContentText("Agent is running").setSmallIcon(android.R.drawable.ic_dialog_info).build()); XoftAgent.start(this) }
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int)=START_STICKY
    override fun onDestroy(){XoftAgent.stop();super.onDestroy()}
    override fun onBind(intent:Intent?):IBinder?=null
}
