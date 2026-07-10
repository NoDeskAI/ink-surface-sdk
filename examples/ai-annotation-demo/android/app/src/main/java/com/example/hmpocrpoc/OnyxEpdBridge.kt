package com.example.hmpocrpoc

import android.os.Build
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.Locale

/**
 * ONYX/BOOX 设备专用：尽量启用厂商 EPD 快速刷新模式。
 *
 * T10CPlus 上当前 InkLoop 没有 M103 那种 `hq.hw` 独立硬件墨迹层；这里先接 Onyx SDK 里官方应用
 * 自己使用的 transient update 快速刷新入口。厂商 SDK 不保证对第三方 App 暴露，所以全部走反射和
 * best-effort 诊断：失败只记录原因，不影响阅读/标记主链路。
 */
object OnyxEpdBridge {
    private const val TAG = "OnyxEpdBridge"
    private const val JS_OBJECT = "InkLoopOnyxEpd"
    private const val EPD_CONTROLLER = "com.onyx.android.sdk.api.device.epd.EpdController"
    private const val UPDATE_MODE = "com.onyx.android.sdk.api.device.epd.UpdateMode"
    private val FAST_MODE_NAMES = listOf("ANIMATION_QUALITY", "SPEED", "DU", "A2")

    @Volatile private var webViewRef: WeakReference<WebView>? = null
    @Volatile private var attachCount = 0L
    @Volatile private var enterCount = 0L
    @Volatile private var exitCount = 0L
    @Volatile private var refreshCount = 0L
    @Volatile private var available = false
    @Volatile private var active = false
    @Volatile private var lastMode = ""
    @Volatile private var lastError = ""

    @JvmStatic
    fun attach(webView: WebView) {
        webViewRef = WeakReference(webView)
        attachCount += 1
        webView.addJavascriptInterface(JsApi(), JS_OBJECT)
        warmUp(webView)
        Log.i(TAG, "attached status=${debugStatusJson()}")
    }

    @JvmStatic
    fun onPause() {
        clearTransientUpdate(false)
    }

    @JvmStatic
    fun onResume() {
        webViewRef?.get()?.let { warmUp(it) }
    }

    private fun warmUp(webView: WebView) {
        runCatching {
            available = classOrNull(EPD_CONTROLLER) != null && classOrNull(UPDATE_MODE) != null
            if (!available) {
                lastError = "onyx_epd_classes_unavailable"
                return
            }
            setWebViewContrastOptimize(webView, false)
            // T10C Plus / Kaleido panels are color-capable. Setting the whole WebView to
            // SPEED/DU/A2 makes normal UI updates look grayscale. Keep the system default
            // page refresh for color content; enter transient fast mode only while the pen is down.
            if (!supportsColorDisplay()) setViewDefaultUpdateMode(webView)
            enableScreenUpdate(webView, true)
        }.onFailure { recordError("warmUp", it) }
    }

    private fun enterFastInk(): Boolean {
        val webView = webViewRef?.get()
        if (webView != null) warmUp(webView)
        val mode = fastMode() ?: return false
        return runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            val updateModeClass = Class.forName(UPDATE_MODE)
            val ok = controller.getMethod("applyTransientUpdate", updateModeClass).invoke(null, mode).asBooleanResult()
            enterCount += 1
            active = ok
            lastMode = enumName(mode)
            ok
        }.onFailure { recordError("enterFastInk", it) }.getOrDefault(false)
    }

    private fun clearTransientUpdate(force: Boolean): Boolean {
        return runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            val ok = controller.getMethod("clearTransientUpdate", java.lang.Boolean.TYPE).invoke(null, force).asBooleanResult()
            exitCount += 1
            active = false
            ok
        }.onFailure { recordError("clearTransientUpdate", it) }.getOrDefault(false)
    }

    private fun refreshDirtyRect(x: Int, y: Int, width: Int, height: Int): Boolean {
        val webView = webViewRef?.get() ?: return false
        val mode = fastMode() ?: return false
        return runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            val updateModeClass = Class.forName(UPDATE_MODE)
            controller.getMethod(
                "refreshScreenRegion",
                View::class.java,
                Integer.TYPE,
                Integer.TYPE,
                Integer.TYPE,
                Integer.TYPE,
                updateModeClass,
            ).invoke(null, webView, x, y, width.coerceAtLeast(1), height.coerceAtLeast(1), mode)
            refreshCount += 1
            true
        }.onFailure { recordError("refreshDirtyRect", it) }.getOrDefault(false)
    }

    private fun setViewDefaultUpdateMode(webView: WebView): Boolean {
        val mode = fastMode() ?: return false
        return runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            val updateModeClass = Class.forName(UPDATE_MODE)
            controller.getMethod("setViewDefaultUpdateMode", View::class.java, updateModeClass).invoke(null, webView, mode).asBooleanResult()
        }.onFailure { recordError("setViewDefaultUpdateMode", it) }.getOrDefault(false)
    }

    private fun enableScreenUpdate(webView: WebView, enabled: Boolean): Boolean {
        return runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            controller.getMethod("enableScreenUpdate", View::class.java, java.lang.Boolean.TYPE).invoke(null, webView, enabled).asBooleanResult()
        }.onFailure { recordError("enableScreenUpdate", it) }.getOrDefault(false)
    }

    private fun setWebViewContrastOptimize(webView: WebView, enabled: Boolean) {
        runCatching {
            val controller = Class.forName(EPD_CONTROLLER)
            controller.getMethod("setWebViewContrastOptimize", WebView::class.java, java.lang.Boolean.TYPE).invoke(null, webView, enabled)
        }.onFailure { recordError("setWebViewContrastOptimize", it) }
    }

    private fun fastMode(): Any? {
        val updateModeClass = classOrNull(UPDATE_MODE) ?: return null
        val constants = updateModeClass.enumConstants ?: return null
        val constantNames = constants.map { enumName(it) }
        val mode = FAST_MODE_NAMES.firstNotNullOfOrNull { wanted ->
            constants.firstOrNull { enumName(it) == wanted }
        }
        if (mode == null) lastError = "fast_mode_not_found available=${constantNames.joinToString(",")}"
        return mode
    }

    private fun classOrNull(name: String): Class<*>? = try {
        Class.forName(name)
    } catch (_: Throwable) {
        null
    }

    private fun enumName(value: Any): String = (value as? Enum<*>)?.name ?: value.toString()

    private fun Any?.asBooleanResult(): Boolean = when (this) {
        is Boolean -> this
        null -> true
        else -> true
    }

    private fun recordError(op: String, error: Throwable) {
        available = false
        lastError = "$op:${error.javaClass.simpleName}:${error.message.orEmpty()}"
        Log.w(TAG, lastError)
    }

    private fun supportsColorDisplay(): Boolean {
        val fp = arrayOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT, Build.FINGERPRINT)
            .joinToString(" ") { it.orEmpty() }
            .lowercase(Locale.ROOT)
        if (fp.contains("t10c") || fp.contains("cplus") || fp.contains("color")) return true
        return systemProp("ro.surface_flinger.has_wide_color_display").equals("true", ignoreCase = true)
    }

    private fun systemProp(key: String): String = try {
        @Suppress("PrivateApi")
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, key) as? String ?: ""
    } catch (_: Throwable) {
        ""
    }

    private fun debugStatusJson(): String {
        val classes = JSONArray()
        classes.put(JSONObject().put("name", EPD_CONTROLLER).put("available", classOrNull(EPD_CONTROLLER) != null))
        classes.put(JSONObject().put("name", UPDATE_MODE).put("available", classOrNull(UPDATE_MODE) != null))
        return JSONObject()
            .put("available", available)
            .put("active", active)
            .put("supports_color", supportsColorDisplay())
            .put("last_mode", lastMode)
            .put("last_error", lastError)
            .put("attach_count", attachCount)
            .put("enter_count", enterCount)
            .put("exit_count", exitCount)
            .put("refresh_count", refreshCount)
            .put("classes", classes)
            .toString()
    }

    private class JsApi {
        @JavascriptInterface
        fun enterFastInk(): Boolean = OnyxEpdBridge.enterFastInk()

        @JavascriptInterface
        fun exitFastInk(): Boolean = OnyxEpdBridge.clearTransientUpdate(true)

        @JavascriptInterface
        fun refreshDirtyRect(x: Int, y: Int, width: Int, height: Int): Boolean =
            OnyxEpdBridge.refreshDirtyRect(x, y, width, height)

        @JavascriptInterface
        fun supportsColorDisplay(): Boolean = OnyxEpdBridge.supportsColorDisplay()

        @JavascriptInterface
        fun debugStatus(): String = OnyxEpdBridge.debugStatusJson()
    }
}
