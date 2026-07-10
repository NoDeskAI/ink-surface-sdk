package com.example.hmpocrpoc

import android.view.MotionEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * 原生层直接判定"这次触摸到底是哪个物理输入设备、哪种笔尖"。
 *
 * 2026-07-01 真机排查确认：`HqHwBridge` 武装厂商快速手写模式(`sys.is.openhw=1`)后，真实 huion
 * 触控笔在到达 WebView 自己合成 PointerEvent 之前，底层会丢失笔尖/橡皮标识位——WebView 最终报给
 * JS 的 `pointerType` 变成 `"touch"`(压感数据还在，只是身份信息被吞了)。真机对照实验证实"降级"
 * 发生在 WebView 内部的 MotionEvent→PointerEvent 转换这一步，不是 Android 原始 MotionEvent 本身
 * 就丢了信息——挂在 WebView 上的 `OnTouchListener`（在 WebView 内部处理之前先触发）看到的
 * `MotionEvent.getDevice()`/`getToolType()` 仍然准确。
 *
 * 这里就是利用这个时序差：原生先一步拿到没被污染的原始分类（设备名分笔/指，tool type 分笔尖/橡皮），
 * 通过一个同步的 `@JavascriptInterface` 暴露给 JS，让 `ink.ts`/`reader.ts` 在 M103 上把它当权威信号，
 * 不再完全依赖会被厂商快速手写模式弄脏的 `pointerType`/`buttons`。用同步接口（不是 postMessage 那种
 * 异步通道）是为了避免"分类还没到、笔画已经在处理"的时序竞争。
 */
object InputSourceBridge {
    private const val TOOL_STYLUS = 320
    private const val TOOL_ERASER = 321
    private val PEN_DEVICE_NAMES = setOf(
        "huion-ts",
        "onyx_emp_wacom i2c digitizer",
    )
    private val FINGER_DEVICE_NAMES = setOf(
        "fts_ts",
        "pt_mt",
    )

    @Volatile private var lastKind: String = "unknown"
    @Volatile private var lastDeviceName: String = ""
    @Volatile private var lastToolType: Int = MotionEvent.TOOL_TYPE_UNKNOWN
    @Volatile private var webViewRef: WeakReference<WebView>? = null
    @Volatile private var strokeSeq = 0L
    @Volatile private var motionPacketCount = 0L
    @Volatile private var touchEventCount = 0L
    @Volatile private var completedStrokeCount = 0L
    @Volatile private var droppedNonPenCount = 0L
    @Volatile private var currentStrokeStartMs = 0L
    private val currentStroke = ArrayList<MotionPt>(512)
    private val completedStrokes = ArrayDeque<MotionStroke>()

    private data class MotionPt(
        val x: Float,
        val y: Float,
        val pressure: Float,
        val t: Long,
        val strokeWidth: Float,
        val flag: Int,
    )
    private data class MotionStroke(val seq: Long, val points: List<MotionPt>)

    @JvmStatic
    fun attach(webView: WebView) {
        webViewRef = WeakReference(webView)
        webView.setOnTouchListener { _, event ->
            classify(event)
            capturePhysicalPen(event)
            false // 不消费事件，只是先看一眼；照常交给 WebView 自己处理
        }
        webView.addJavascriptInterface(JsBridge(), "InkLoopInputSource")
    }

    private fun classify(event: MotionEvent) {
        touchEventCount += 1
        val name = event.device?.name ?: ""
        val tool = toolType(event)
        lastDeviceName = name
        lastToolType = tool
        lastKind = when {
            isPenDevice(name) && tool == MotionEvent.TOOL_TYPE_ERASER -> "eraser"
            isPenDevice(name) && tool == MotionEvent.TOOL_TYPE_STYLUS -> "pen"
            isPenDevice(name) -> "pen"
            isFingerDevice(name) || tool == MotionEvent.TOOL_TYPE_FINGER -> "touch"
            else -> "unknown"
        }
    }

    private fun normalizedDeviceName(event: MotionEvent): String = (event.device?.name ?: "").lowercase()

    private fun isPenDevice(name: String): Boolean {
        val normalized = name.lowercase()
        return PEN_DEVICE_NAMES.any { normalized == it || normalized.contains(it) }
            || normalized.contains("wacom")
            || normalized.contains("digitizer")
            || normalized.contains("stylus")
            || normalized.contains("pen")
    }

    private fun isFingerDevice(name: String): Boolean {
        val normalized = name.lowercase()
        return FINGER_DEVICE_NAMES.any { normalized == it || normalized.contains(it) }
            || normalized.contains("touch")
            || normalized.contains("mt")
    }

    private fun toolType(event: MotionEvent): Int =
        try { event.getToolType(event.actionIndex.coerceIn(0, event.pointerCount - 1)) } catch (_: Throwable) { event.getToolType(0) }

    private fun isPenEvent(event: MotionEvent): Boolean {
        if (!isPenDevice(normalizedDeviceName(event))) return false
        return toolType(event) == MotionEvent.TOOL_TYPE_STYLUS
    }

    private fun isEraserEvent(event: MotionEvent): Boolean {
        if (!isPenDevice(normalizedDeviceName(event))) return false
        return toolType(event) == MotionEvent.TOOL_TYPE_ERASER
    }

    private fun capturePhysicalPen(event: MotionEvent) {
        val isPen = isPenEvent(event)
        val isEraser = isEraserEvent(event)
        if (!isPen && !isEraser) {
            if (!isFingerDevice(event.device?.name ?: "")) droppedNonPenCount += 1
            return
        }
        val action = event.actionMasked
        val pointerIndex = event.actionIndex.coerceIn(0, event.pointerCount - 1)
        val flag = if (isEraser) TOOL_ERASER else TOOL_STYLUS
        when (action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                resetCurrentStroke()
                currentStrokeStartMs = event.eventTime
                appendHistoricalPoints(event, pointerIndex, flag)
                appendPoint(event, pointerIndex, flag, event.eventTime)
            }
            MotionEvent.ACTION_MOVE -> {
                if (currentStroke.isEmpty()) currentStrokeStartMs = event.eventTime
                appendHistoricalPoints(event, pointerIndex, flag)
                appendPoint(event, pointerIndex, flag, event.eventTime)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                if (currentStroke.isEmpty()) currentStrokeStartMs = event.eventTime
                appendHistoricalPoints(event, pointerIndex, flag)
                appendPoint(event, pointerIndex, flag, event.eventTime)
                finishCurrentStroke()
            }
            MotionEvent.ACTION_CANCEL -> resetCurrentStroke()
        }
    }

    private fun appendHistoricalPoints(event: MotionEvent, pointerIndex: Int, flag: Int) {
        for (h in 0 until event.historySize) appendPoint(event, pointerIndex, flag, event.getHistoricalEventTime(h), h)
    }

    private fun appendPoint(event: MotionEvent, pointerIndex: Int, flag: Int, eventTime: Long, historyIndex: Int? = null) {
        val view = webViewRef?.get()
        val density = view?.resources?.displayMetrics?.density?.takeIf { it > 0f } ?: 1f
        val x = if (historyIndex == null) event.getX(pointerIndex) else event.getHistoricalX(pointerIndex, historyIndex)
        val y = if (historyIndex == null) event.getY(pointerIndex) else event.getHistoricalY(pointerIndex, historyIndex)
        val pressure = if (historyIndex == null) event.getPressure(pointerIndex) else event.getHistoricalPressure(pointerIndex, historyIndex)
        val size = if (historyIndex == null) event.getSize(pointerIndex) else event.getHistoricalSize(pointerIndex, historyIndex)
        currentStroke.add(MotionPt(
            x = x / density,
            y = y / density,
            pressure = pressure.coerceIn(0f, 1f),
            t = (eventTime - currentStrokeStartMs).coerceAtLeast(0L),
            strokeWidth = size,
            flag = flag,
        ))
        motionPacketCount += 1
    }

    private fun finishCurrentStroke() {
        if (currentStroke.isEmpty()) return
        val stroke = MotionStroke(++strokeSeq, ArrayList(currentStroke))
        completedStrokes.addLast(stroke)
        while (completedStrokes.size > 8) completedStrokes.removeFirst()
        completedStrokeCount += 1
        resetCurrentStroke()
    }

    private fun resetCurrentStroke() {
        currentStroke.clear()
        currentStrokeStartMs = 0L
    }

    private fun takeLastPhysicalPenStrokeJson(): String {
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
            .put("source", "motion_event")
            .put("points", arr)
            .toString()
    }

    private fun clearPhysicalPenStrokes() {
        completedStrokes.clear()
        resetCurrentStroke()
    }

    private fun resetDiagnostics() {
        lastKind = "unknown"
        lastDeviceName = ""
        lastToolType = MotionEvent.TOOL_TYPE_UNKNOWN
        motionPacketCount = 0L
        touchEventCount = 0L
        completedStrokeCount = 0L
        droppedNonPenCount = 0L
        completedStrokes.clear()
        resetCurrentStroke()
    }

    private fun debugStatusJson(): String {
        return JSONObject()
            .put("last_kind", lastKind)
            .put("last_device_name", lastDeviceName)
            .put("last_tool_type", lastToolType)
            .put("touch_event_count", touchEventCount)
            .put("motion_packet_count", motionPacketCount)
            .put("completed_stroke_count", completedStrokeCount)
            .put("pending_point_count", currentStroke.size)
            .put("queued_stroke_count", completedStrokes.size)
            .put("dropped_non_pen_count", droppedNonPenCount)
            .toString()
    }

    private class JsBridge {
        @JavascriptInterface
        fun classifyLast(): String = lastKind

        /** OSD 快速墨迹是不是真的武装成功——前端据此决定这一笔要不要信任 OSD 做实时视觉、
         *  自己只在抬笔时补画一次，避免两套渲染叠加显得更卡。 */
        @JavascriptInterface
        fun isOsdArmed(): Boolean = HqHwBridge.isArmed()

        @JavascriptInterface
        fun takeLastPhysicalPenStroke(): String = takeLastPhysicalPenStrokeJson()

        @JavascriptInterface
        fun clearPhysicalPenStrokes() { InputSourceBridge.clearPhysicalPenStrokes() }

        @JavascriptInterface
        fun resetDiagnostics() { InputSourceBridge.resetDiagnostics() }

        @JavascriptInterface
        fun debugStatus(): String = InputSourceBridge.debugStatusJson()
    }
}
