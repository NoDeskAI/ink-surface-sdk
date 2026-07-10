package com.example.hmpocrpoc

import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * JS↔原生桥：window.InkLoopRuntime —— 只读运行时边界声明。
 *
 * 这个桥不承载业务状态，只给 APK 内 mobile.html 暴露当前 V1 演示链路：
 * Web cloud-first 导入 -> 墨水屏本地优先阅读/标记 -> Obsidian 知识投影。
 */
object InkLoopRuntimeBridge {
    fun attach(webView: WebView) {
        webView.addJavascriptInterface(JsApi(), "InkLoopRuntime")
    }

    private class JsApi {
        @JavascriptInterface
        fun getManifest(): String = JSONObject()
            .put("schema_version", "inkloop.android_runtime_manifest.v1")
            .put("host", "android-webview")
            .put("product_loop", "InkLoop Paper")
            .put("sync_loop", "Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection")
            .put("mode", "web-cloud-first-paper-local-first")
            .put("entrypoint", "mobile.html")
            .put("device_model", Build.MODEL.orEmpty())
            .put("sdk_int", Build.VERSION.SDK_INT)
            .toString()
    }
}
