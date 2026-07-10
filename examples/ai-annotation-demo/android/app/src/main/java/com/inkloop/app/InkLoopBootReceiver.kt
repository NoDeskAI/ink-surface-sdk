package com.inkloop.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class InkLoopBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED
            && action != Intent.ACTION_LOCKED_BOOT_COMPLETED
            && action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return
        try {
            InkLoopKeepAliveService.start(context)
        } catch (error: Throwable) {
            Log.w("InkLoopBootReceiver", "Unable to start keep-alive service after $action", error)
        }
    }
}
