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
    @Volatile private var armed = false
    @Volatile private var lastArea = ""
    @Volatile private var lastExclude = ""
    @Volatile private var initialized = false
    @Volatile private var lastError = ""

    // 前端上报的「当前书写画布 + 浮动控件排除区」(WebView host-local 物理 px)；null=非书写面→disarm。
    private data class WritingArea(val limit: Rect, val excludes: List<Rect>)
    private var requestedArea: WritingArea? = null

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
        webViewRef?.get()?.post { if (ensureReady()) applyRequestedArea() } // 恢复后按上次画区重 arm，不等前端偶发再报
    }

    @JvmStatic
    fun onPause() {
        setRawDrawingEnabled(false)
        armed = false
        webViewRef?.get()?.let { wv -> runCatching { EpdController.clearTransientUpdate(wv, true) } }
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
                .setLimitRect(Rect(0, 0, 1, 1), emptyList()) // 占位·真画区等前端 updateWritingArea 上报
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

    // 落笔时前端调（@JavascriptInterface → bridge 线程）。arm 与 limitRect 由 updateWritingArea（前端画区
    // 上报）驱动；这里只在已 arm 时触发 EPD handwriting transient 快刷，不再自己设 limitRect/enable（否则回到整屏）。
    private fun enterFastInk(): Boolean {
        webViewRef?.get()?.post {
            runCatching {
                if (!armed) return@runCatching
                EpdController.applyTransientUpdate(UpdateMode.HAND_WRITING_REPAINT_MODE)
                enterCount += 1
                active = true
            }.onFailure { recordError("enterFastInk", it) }
        }
        return armed
    }

    private fun exitFastInk(): Boolean {
        webViewRef?.get()?.let { wv ->
            wv.post {
                runCatching {
                    EpdController.clearTransientUpdate(wv, true)
                    exitCount += 1
                    active = false
                }.onFailure { recordError("exitFastInk", it) }
            }
        }
        return true
    }

    /** 前端上报「当前书写画布矩形」（{x,y,w,h,dpr} host-local 物理 px，见 onyx-pen-area.ts）：收窄 raw drawing
     *  到这块画布并 arm；null/空/零面积 → disarm（书架/按钮/浮层等非书写面不再是原生画线区）。 */
    @JvmStatic
    fun updateWritingArea(rectJson: String?) {
        val webView = webViewRef?.get() ?: return
        webView.post {
            if (!ensureReady()) return@post
            requestedArea = parseWritingRect(rectJson)
            applyRequestedArea()
        }
    }

    // 把当前 requestedArea 应用到 TouchHelper（有画区→limitRect+enable+armed；null→disable）。onResume 也调它恢复。
    private fun applyRequestedArea() {
        runCatching {
            val area = requestedArea
            if (area != null) {
                // onyxsdk-pen 1.5.4 实签名：setLimitRect(Rect, List<Rect>)；exclude 会下沉到
                // nativeSetExcludeRegion / setScreenHandWritingRegionExclude，在浮动笔触栏处给 raw 区挖洞。
                touchHelper?.setLimitRect(area.limit, area.excludes)
                touchHelper?.setRawDrawingRenderEnabled(true)
                setRawDrawingEnabled(true)
                armed = true
                lastArea = "${area.limit.left},${area.limit.top},${area.limit.right},${area.limit.bottom}"
                lastExclude = area.excludes.joinToString(";") { "${it.left},${it.top},${it.right},${it.bottom}" }
            } else {
                setRawDrawingEnabled(false)
                armed = false
                lastArea = "null"
                lastExclude = ""
            }
        }.onFailure { recordError("applyRequestedArea", it) }
    }

    private fun parseWritingRect(rectJson: String?): WritingArea? {
        val raw = rectJson?.trim().orEmpty()
        if (raw.isEmpty() || raw == "null") return null
        return runCatching {
            val o = JSONObject(raw)
            val limit = parseRect(o) ?: return@runCatching null
            val excludes = ArrayList<Rect>()
            o.optJSONArray("exclude")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val candidate = arr.optJSONObject(i)?.let(::parseRect) ?: continue
                    val clipped = Rect(candidate)
                    if (clipped.intersect(limit)) excludes.add(clipped)
                }
            }
            WritingArea(limit, excludes)
        }.getOrNull()
    }

    private fun parseRect(o: JSONObject): Rect? {
        val x = o.optDouble("x", Double.NaN)
        val y = o.optDouble("y", Double.NaN)
        val w = o.optDouble("w", Double.NaN)
        val h = o.optDouble("h", Double.NaN)
        if (!x.isFinite() || !y.isFinite() || !w.isFinite() || !h.isFinite() || w <= 0.0 || h <= 0.0) return null
        return Rect(x.toInt(), y.toInt(), (x + w).toInt(), (y + h).toInt())
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
        .put("armed", armed)
        .put("last_area", lastArea)
        .put("last_exclude", lastExclude)
        .put("exclude_count", requestedArea?.excludes?.size ?: 0)
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

        /** 前端画区上报：{x,y,w,h,dpr} host-local 物理 px → 收窄 raw drawing 并 arm；null → disarm。 */
        @JavascriptInterface
        fun updateWritingArea(rectJson: String?) = OnyxPenBridge.updateWritingArea(rectJson)

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
