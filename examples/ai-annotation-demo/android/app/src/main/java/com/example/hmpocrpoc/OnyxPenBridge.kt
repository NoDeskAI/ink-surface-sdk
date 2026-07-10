package com.example.hmpocrpoc

import android.graphics.Rect
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.onyx.android.sdk.api.device.eac.SimpleEACManage
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.api.device.epd.UpdateMode
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * ONYX/BOOX 低延迟手写桥。
 *
 * T10C Plus 没有 M103 的 `hq.hw` OSD socket；官方路线是 Pen SDK 的 `TouchHelper`：
 * 原生层负责落笔期间的 scribble 即时显示，同时通过 RawInputCallback 给前端一份原始点，
 * 前端抬笔后再把这份点沉淀成 InkLoop 的 Stroke/MarkEvent。
 */
object OnyxPenBridge {
    private const val TAG = "OnyxPenBridge"
    private const val JS_OBJECT = "InkLoopOnyxPen"
    private const val TOOL_STYLUS = 320
    private const val TOOL_ERASER = 321

    @Volatile private var webViewRef: WeakReference<WebView>? = null
    @Volatile private var touchHelper: TouchHelper? = null
    @Volatile private var attachCount = 0L
    @Volatile private var enterCount = 0L
    @Volatile private var exitCount = 0L
    @Volatile private var rawPointCount = 0L
    @Volatile private var completedStrokeCount = 0L
    @Volatile private var active = false
    @Volatile private var initialized = false
    @Volatile private var lastError = ""

    private val currentStroke = ArrayList<OnyxPt>(512)
    private val completedStrokes = ArrayDeque<OnyxStroke>()
    private var strokeSeq = 0L
    private var strokeStartMs = 0L

    private data class OnyxPt(
        val x: Float,
        val y: Float,
        val pressure: Float,
        val t: Long,
        val strokeWidth: Float,
        val flag: Int,
    )

    private data class OnyxStroke(val seq: Long, val points: List<OnyxPt>)

    @JvmStatic
    fun attach(webView: WebView) {
        webViewRef = WeakReference(webView)
        attachCount += 1
        webView.addJavascriptInterface(JsApi(), JS_OBJECT)
        webView.post { ensureReady() }
        Log.i(TAG, "attached status=${debugStatusJson()}")
    }

    @JvmStatic
    fun onResume() {
        webViewRef?.get()?.post { ensureReady() }
    }

    @JvmStatic
    fun onPause() {
        setRawDrawingEnabled(false)
    }

    @JvmStatic
    fun destroy() {
        setRawDrawingEnabled(false)
        runCatching { touchHelper?.closeRawDrawing() }.onFailure { recordError("closeRawDrawing", it) }
        touchHelper = null
        initialized = false
        active = false
        clearStrokes()
    }

    private fun ensureReady(): Boolean {
        val webView = webViewRef?.get() ?: return false
        if (initialized && touchHelper != null) return true
        return runCatching {
            configureEac(webView)
            EpdController.setWebViewContrastOptimize(webView, false)
            EpdController.setViewDefaultUpdateMode(webView, UpdateMode.HAND_WRITING_REPAINT_MODE)
            val helper = TouchHelper.create(webView, rawInputCallback)
                .debugLog(false)
                .setStrokeWidth(3.0f)
                .setStrokeStyle(TouchHelper.STROKE_STYLE_PENCIL)
                .setLimitRect(currentLimitRect(webView), emptyList())
                .openRawDrawing()
            helper.setRawDrawingRenderEnabled(true)
            helper.setPenUpRefreshEnabled(true)
            helper.setPenUpRefreshTimeMs(80)
            helper.setRawDrawingEnabled(false)
            touchHelper = helper
            initialized = true
            lastError = ""
            true
        }.onFailure { recordError("ensureReady", it) }.getOrDefault(false)
    }

    private fun configureEac(webView: WebView) {
        runCatching {
            val eac = SimpleEACManage.getInstance()
            eac.setSupportEAC(webView.context, true)
            eac.setAppEACEnable(webView.context, true)
            eac.setEACRefreshConfigEnable(webView.context, true)
        }.onFailure { recordError("configureEac", it) }
    }

    private fun currentLimitRect(webView: WebView): Rect {
        val rect = Rect()
        webView.getLocalVisibleRect(rect)
        if (rect.width() <= 0 || rect.height() <= 0) rect.set(0, 0, webView.width.coerceAtLeast(1), webView.height.coerceAtLeast(1))
        return rect
    }

    private fun enterFastInk(): Boolean {
        val webView = webViewRef?.get() ?: return false
        if (!ensureReady()) return false
        return runCatching {
            touchHelper?.setLimitRect(currentLimitRect(webView), emptyList())
            touchHelper?.setRawDrawingRenderEnabled(true)
            EpdController.applyTransientUpdate(UpdateMode.HAND_WRITING_REPAINT_MODE)
            setRawDrawingEnabled(true)
            enterCount += 1
            active = true
            true
        }.onFailure { recordError("enterFastInk", it) }.getOrDefault(false)
    }

    private fun exitFastInk(): Boolean {
        return runCatching {
            setRawDrawingEnabled(false)
            webViewRef?.get()?.let { EpdController.clearTransientUpdate(it, true) }
            exitCount += 1
            active = false
            true
        }.onFailure { recordError("exitFastInk", it) }.getOrDefault(false)
    }

    private fun setRawDrawingEnabled(enabled: Boolean) {
        runCatching { touchHelper?.setRawDrawingEnabled(enabled) }.onFailure { recordError("setRawDrawingEnabled", it) }
    }

    private val rawInputCallback = object : RawInputCallback() {
        override fun onBeginRawDrawing(b: Boolean, touchPoint: TouchPoint) {
            beginStroke(touchPoint, TOOL_STYLUS)
        }

        override fun onEndRawDrawing(b: Boolean, touchPoint: TouchPoint) {
            appendPoint(touchPoint, TOOL_STYLUS)
            finishStroke()
        }

        override fun onRawDrawingTouchPointMoveReceived(touchPoint: TouchPoint) {
            appendPoint(touchPoint, TOOL_STYLUS)
        }

        override fun onRawDrawingTouchPointListReceived(touchPointList: TouchPointList) {
            // Move callbacks already append points; this cumulative callback is intentionally ignored.
        }

        override fun onBeginRawErasing(b: Boolean, touchPoint: TouchPoint) {
            beginStroke(touchPoint, TOOL_ERASER)
        }

        override fun onEndRawErasing(b: Boolean, touchPoint: TouchPoint) {
            appendPoint(touchPoint, TOOL_ERASER)
            finishStroke()
        }

        override fun onRawErasingTouchPointMoveReceived(touchPoint: TouchPoint) {
            appendPoint(touchPoint, TOOL_ERASER)
        }

        override fun onRawErasingTouchPointListReceived(touchPointList: TouchPointList) {
            // Same reason as drawing list callback.
        }
    }

    private fun beginStroke(point: TouchPoint, flag: Int) {
        currentStroke.clear()
        strokeStartMs = point.timestamp.takeIf { it > 0L } ?: android.os.SystemClock.uptimeMillis()
        appendPoint(point, flag)
    }

    private fun appendPoint(point: TouchPoint, flag: Int) {
        val webView = webViewRef?.get()
        val density = webView?.resources?.displayMetrics?.density?.takeIf { it > 0f } ?: 1f
        val eventTime = point.timestamp.takeIf { it > 0L } ?: android.os.SystemClock.uptimeMillis()
        currentStroke.add(OnyxPt(
            x = point.x / density,
            y = point.y / density,
            pressure = point.pressure.coerceIn(0f, 1f),
            t = (eventTime - strokeStartMs).coerceAtLeast(0L),
            strokeWidth = point.size,
            flag = flag,
        ))
        rawPointCount += 1
    }

    private fun finishStroke() {
        if (currentStroke.isEmpty()) return
        completedStrokes.addLast(OnyxStroke(++strokeSeq, ArrayList(currentStroke)))
        while (completedStrokes.size > 8) completedStrokes.removeFirst()
        completedStrokeCount += 1
        currentStroke.clear()
        strokeStartMs = 0L
    }

    private fun takeLastStrokeJson(): String {
        val stroke = completedStrokes.removeLastOrNull() ?: return ""
        val arr = JSONArray()
        for (pt in stroke.points) {
            arr.put(JSONObject()
                .put("x", pt.x.toDouble())
                .put("y", pt.y.toDouble())
                .put("pressure", pt.pressure.toDouble())
                .put("t", pt.t)
                .put("strokeWidth", pt.strokeWidth.toDouble())
                .put("flag", pt.flag))
        }
        return JSONObject()
            .put("seq", stroke.seq)
            .put("source", "onyx_touch_helper")
            .put("points", arr)
            .toString()
    }

    private fun clearStrokes() {
        completedStrokes.clear()
        currentStroke.clear()
        strokeStartMs = 0L
    }

    private fun recordError(op: String, error: Throwable) {
        lastError = "$op:${error.javaClass.simpleName}:${error.message.orEmpty()}"
        Log.w(TAG, lastError, error)
    }

    private fun debugStatusJson(): String = JSONObject()
        .put("initialized", initialized)
        .put("active", active)
        .put("last_error", lastError)
        .put("attach_count", attachCount)
        .put("enter_count", enterCount)
        .put("exit_count", exitCount)
        .put("raw_point_count", rawPointCount)
        .put("completed_stroke_count", completedStrokeCount)
        .put("pending_point_count", currentStroke.size)
        .put("queued_stroke_count", completedStrokes.size)
        .put("raw_created", runCatching { touchHelper?.isRawDrawingCreated ?: false }.getOrDefault(false))
        .put("raw_input_enabled", runCatching { touchHelper?.isRawDrawingInputEnabled ?: false }.getOrDefault(false))
        .put("raw_render_enabled", runCatching { touchHelper?.isRawDrawingRenderEnabled ?: false }.getOrDefault(false))
        .toString()

    private class JsApi {
        @JavascriptInterface
        fun enterFastInk(): Boolean = OnyxPenBridge.enterFastInk()

        @JavascriptInterface
        fun exitFastInk(): Boolean = OnyxPenBridge.exitFastInk()

        @JavascriptInterface
        fun takeLastPhysicalPenStroke(): String = OnyxPenBridge.takeLastStrokeJson()

        @JavascriptInterface
        fun clearPhysicalPenStrokes() { OnyxPenBridge.clearStrokes() }

        @JavascriptInterface
        fun debugStatus(): String = OnyxPenBridge.debugStatusJson()
    }
}
