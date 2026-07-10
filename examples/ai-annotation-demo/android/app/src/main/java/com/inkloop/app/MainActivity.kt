package com.inkloop.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.SslErrorHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.graphics.Bitmap
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.Locale

/**
 * InkLoop 安卓壳：用 WebViewAssetLoader 从 APK 的 assets/ 加载 Vite 构建的前端，
 * API 走本地/托管 Cloud Hub（debug 默认 https 本地端口，避免 Mixed Content）。安全侧用 https 风格
 * 的本地 origin、关 file 访问。
 *
 * 前端静态资源来自 `dist/`（见 scripts/sync-android-assets.mjs / INTEGRATION.md），
 * 端侧 OCR 桥见 OcrBridge（Phase 2）。
 */
class MainActivity : ComponentActivity() {

    private enum class DisplayMode { IT8951, DIRECT }

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        // InkLoop Paper V1 demo: load the mobile WebView front end for reading, marking, and local sync.
        // Desktop web still uses index.html; both pages are bundled into assets by the Vite multi-page build.
        private const val APP_URL_HTTPS = "https://appassets.androidplatform.net/assets/mobile.html"
        private const val APP_URL_HTTP = "http://appassets.androidplatform.net/assets/mobile.html"
        private const val META_DISPLAY_MODE = "com.inkloop.DISPLAY_MODE"
        // 2026-07-01 重新打开：画区收窄(InkLoopHqHwArea) + 原生输入分类覆盖(InputSourceBridge) 都已接上。
        private const val HQHW_BRIDGE_ENABLED = true
    }

    private lateinit var webView: WebView
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var hqHwEnabled = false

    // 文件导入：前端 <input type=file accept=...> → 系统 SAF 文档选择器。
    // mobile.html 主要导入 PDF；ai-pen-demo.html 的 bench/QA 路径可导入 RawPenFrame JSON/JSONL。
    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = pendingFileCallback ?: return@registerForActivityResult
        pendingFileCallback = null
        val uris = if (result.resultCode == Activity.RESULT_OK)
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data) else null
        cb.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        InkLoopKeepAliveService.start(this)
        val displayMode = resolveDisplayMode()
        // IT8951 模式：WebView 钉成 3:4 竖框（本板显示固定横向，requestedOrientation=PORTRAIT 会卡死 activity），
        //   前端走窄屏竖屏布局，PixelCopy 抓这块竖框 → EinkBridge TRANSVERSE → 满幅填到 IT8951 电纸屏。
        // DIRECT 模式(BOOX 等普通安卓电纸平板)：WebView 填满 Activity 窗口；系统旋转窗口后随尺寸重排 reflow（支持横屏）。
        // 沉浸式全屏隐藏系统栏，给电纸屏满幅，也为后续 launcher/kiosk 形态铺路。
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .setHttpAllowed(debuggable)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(Color.WHITE)
        webView.clearCache(true)
        if (isRkNativeEinkDevice()) {
            // M103 真机首屏即持续报 Chromium tile memory exceeded，根因是全屏 WebView 被强制软件层后
            // tile cache 极低；硬件层交给 WebView 自己做可见区合成，阅读翻页由前端禁动画/禁滚动层兜住。
            // 若个别设备出现 RenderProcessGone，下面的 WebViewClient 会清 OSD 并重建 Activity。
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        // IT8951=深色底 + 居中 3:4 竖框（剩余区黑边）；DIRECT=白底、WebView 填满窗口（见 webViewLayoutParams）。
        val root = FrameLayout(this).apply {
            setBackgroundColor(if (displayMode == DisplayMode.IT8951) Color.parseColor("#11110f") else Color.WHITE)
        }
        root.addView(webView, webViewLayoutParams(displayMode))
        setContentView(root)
        configureWebView(assetLoader)

        // 端侧印刷区域 OCR 桥：注册 window.InkLoopOcr（ocrRegion=ML Kit text+PP-OCR 兜底）。
        // 注册后前端 ondevice.available()=true → ocrRegion 走端侧；recognizeInk 端侧返回 unavailable → 前端自动降级云端。
        // 要纯套壳（全部走云）只需注释下一行。
        com.example.hmpocrpoc.OcrBridge.attach(webView, this)

        // 电纸屏推帧桥：注册 window.InkLoopEink。前端内容变化发 pageReady → PixelCopy 抓帧 → 灰度 →
        // abstract socket 交 eink-helper(root) 推 IT8951 电纸屏。无 helper/无电纸屏时静默失败、不影响 HDMI 显示。
        // DIRECT(BOOX)模式不 attach：避免无意义抓帧，也让前端 EinkPort 自然 no-op、改用 BOOX 原生刷新。
        // DIRECT(M103 原生 EBC)模式改走 RkEinkBridge：两轮真机排查(含真实笔迹信号注入实测)证实 app 层做不到
        // 精细控制刷新(厂商还有一条独立的 OSD/笔迹叠加层守护进程不受 app 控制)，改为固定原厂默认 mode=7，
        // 不再注入 window.InkLoopEink——前端 eink.ts 在这类设备上自然走 no-op 分支（见该文件头注释）。
        if (displayMode == DisplayMode.IT8951) {
            com.example.hmpocrpoc.EinkBridge.attach(webView, this)
        } else if (isOnyxBooxDevice()) {
            // T10/BOOX：没有 M103 的 hq.hw 独立墨迹层；先接原生 Wacom 输入分类和 Onyx EPD 快刷诊断桥。
            // 前端据 `onyx-t10` 设备身份启用 pen/touch 权威分流，并在落笔期间尝试 transient fast update。
            com.example.hmpocrpoc.InputSourceBridge.attach(webView)
            com.example.hmpocrpoc.OnyxPenBridge.attach(webView)
            com.example.hmpocrpoc.OnyxEpdBridge.attach(webView)
            injectDeviceProfile(webView, onyxDeviceProfile())
        } else if (isRkNativeEinkDevice()) {
            com.example.hmpocrpoc.RkEinkBridge.attach()
            // 2026-07-01：HqHwBridge 武装厂商快速墨迹叠加层(hq.hw)，延迟真机确认大幅改善。曾因两个
            // 问题临时关闭，现已修复：①画区曾是整个 WebView(含 UI chrome)，武装后 OSD 会在整个屏幕
            // 响应笔迹、误伤 UI——现改成前端主动上报画布矩形(InkLoopHqHwArea，见 HqHwBridge.kt 头注释)。
            // ②武装后真实笔到达 WebView 自己合成 PointerEvent 前会在底层丢失笔尖标识位，pointerType
            // 被错报成 touch——现接入 InputSourceBridge，用一条更早的原生 OnTouchListener 拿到没被
            // 污染的原始分类，前端 m103-input-source.ts 据此权威覆盖。
            if (HQHW_BRIDGE_ENABLED) {
                hqHwEnabled = true
                com.example.hmpocrpoc.HqHwBridge.attach(webView)
                com.example.hmpocrpoc.InputSourceBridge.attach(webView)
            }
            // 设备身份标记：只在真机确认为 M103 时注入，前端设备专用组件(如笔橡皮头识别)据此门控，
            // 避免把这台设备的硬件专属细节(huion 笔 buttons 位约定等)泄漏进跨设备共用代码路径。
            injectDeviceProfile(webView, "m103-haoqing")
        }

        // WebView 内文件浏览器桥：注册 window.InkLoopFiles（list/readBase64 /sdcard）。
        // 电纸屏系统 SAF 选择器看不见 → 移动版导入走 #files 浮层，由本桥喂真实文件；无桥则前端降级系统选择器。
        com.example.hmpocrpoc.InkLoopFilesBridge.attach(webView, this)
        ensureAllFilesAccess() // Android 11+ 读 /sdcard 任意文件需「所有文件访问」，启动时尝试请求一次

        // 无线同步链路桥：window.InkLoopNet（dev 页读 WiFi 状态 + 跳系统面板切 WiFi/热点）。
        com.example.hmpocrpoc.InkLoopNetBridge.attach(webView, this)

        // 局域网导入桥：window.InkLoopLanImport。打开移动端「导入文件」时可启动一个临时
        // Wi-Fi 上传页，电脑同网访问 http://设备IP:端口/ 上传 PDF，再从 WebView 收件箱导入。
        com.example.hmpocrpoc.InkLoopLanImportBridge.attach(webView, this)

        // 只读运行时边界桥：window.InkLoopRuntime。让 APK 内 mobile.html 识别当前 V1 小闭环：
        // Web cloud-first 导入 -> Paper 本地优先阅读/标记 -> Obsidian 知识投影。
        com.example.hmpocrpoc.InkLoopRuntimeBridge.attach(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        webView.loadUrl(appUrlForIntent(intent, debuggable))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::webView.isInitialized && isLarkOAuthCallback(intent.data)) {
            val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
            webView.loadUrl(appUrlForIntent(intent, debuggable))
        }
    }

    private fun configureWebView(assetLoader: WebViewAssetLoader) {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        with(webView.settings) {
            javaScriptEnabled = true          // 前端是 Vite/TS 应用，必须开
            domStorageEnabled = true          // localStorage / IndexedDB（标注/账本持久化）
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            // release 仍禁止混合内容；debug 允许本地 HTTP Cloud Hub，避开局域网自签 HTTPS 在 WebView
            // fetch/XHR 中的证书握手问题。debug 的 cleartext 范围由 src/debug/network_security_config.xml 控制。
            mixedContentMode = if (debuggable) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = if (debuggable) WebSettings.LOAD_NO_CACHE else WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = true
            setSupportZoom(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (debuggable && isLocalCloudHubSslError(error)) handler.proceed()
                else handler.cancel()
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (hqHwEnabled) com.example.hmpocrpoc.HqHwBridge.forceResetFastInk()
                super.onPageStarted(view, url, favicon)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == APP_HOST) return false   // 应用内本地资源 → 放行
                if (isLarkOAuthCallback(uri)) {
                    view.loadUrl(appUrlForOAuthCallback(uri, (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0))
                    return true
                }
                if (isFeishuOAuthPage(uri)) return false
                // 任何外链交系统浏览器，不在 App 内打开任意网页。
                return try { startActivity(Intent(Intent.ACTION_VIEW, uri)); true }
                catch (_: ActivityNotFoundException) { true }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Android WebView 默认会在渲染进程崩溃时把宿主进程也杀掉。对电纸屏阅读器来说，
                // 更合理的降级是销毁这次 WebView 并重建 Activity，保留本地 IndexedDB/Cloud Hub 数据。
                if (hqHwEnabled) com.example.hmpocrpoc.HqHwBridge.forceResetFastInk()
                try { view.destroy() } catch (_: Throwable) { /* already gone */ }
                view.postDelayed({ recreate() }, 200)
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                val mimeTypes = acceptedMimeTypes(params)
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (mimeTypes.size == 1) mimeTypes[0] else "*/*"
                    if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
                }
                return try { filePicker.launch(intent); true }
                catch (_: ActivityNotFoundException) {
                    pendingFileCallback = null; filePathCallback.onReceiveValue(null); false
                }
            }
        }
    }

    private fun appUrl(debuggable: Boolean): String = if (debuggable) APP_URL_HTTP else APP_URL_HTTPS

    private fun isLarkOAuthCallback(uri: Uri?): Boolean {
        if (uri == null) return false
        if (uri.scheme == "inkloop" && uri.host == "oauth" && uri.path == "/lark/callback") return true
        val scheme = uri.scheme ?: return false
        val host = uri.host ?: return false
        return (scheme == "http" || scheme == "https")
            && isPrivateOrLoopbackHost(host)
            && (uri.path == "/api/feishu-svc/api/feishu/oauth/callback" || uri.path == "/api/auth/lark/callback")
    }

    private fun isFeishuOAuthPage(uri: Uri): Boolean {
        val host = (uri.host ?: "").lowercase(Locale.ROOT)
        return host == "accounts.feishu.cn"
            || host == "accounts.larksuite.com"
            || host == "open.feishu.cn"
            || host == "open.larksuite.com"
    }

    private fun appUrlForIntent(intent: Intent?, debuggable: Boolean): String {
        val uri = intent?.data
        return if (isLarkOAuthCallback(uri)) appUrlForOAuthCallback(uri!!, debuggable) else appUrl(debuggable)
    }

    private fun appUrlForOAuthCallback(uri: Uri, debuggable: Boolean): String {
        val builder = Uri.parse(appUrl(debuggable)).buildUpon()
            .appendQueryParameter("inkloop_oauth", "lark")
            .appendQueryParameter("redirect_uri", oauthRedirectUri(uri))
        for (name in listOf("code", "state", "error", "error_description")) {
            val value = uri.getQueryParameter(name)
            if (!value.isNullOrBlank()) builder.appendQueryParameter(name, value)
        }
        return builder.build().toString()
    }

    private fun oauthRedirectUri(uri: Uri): String =
        Uri.Builder()
            .scheme(uri.scheme)
            .encodedAuthority(uri.encodedAuthority)
            .encodedPath(uri.encodedPath)
            .build()
            .toString()

    private fun isLocalCloudHubSslError(error: SslError): Boolean {
        val uri = Uri.parse(error.url ?: return false)
        if (uri.scheme != "https") return false
        return uri.port == 8732 && isPrivateOrLoopbackHost(uri.host ?: "")
    }

    private fun isPrivateOrLoopbackHost(host: String): Boolean {
        val h = host.lowercase(Locale.ROOT)
        return h == "localhost" || h == "127.0.0.1" || h == "::1"
            || h.startsWith("10.")
            || h.startsWith("192.168.")
            || Regex("""^172\.(1[6-9]|2\d|3[01])\.""").containsMatchIn(h)
    }

    private fun acceptedMimeTypes(params: WebChromeClient.FileChooserParams): Array<String> {
        val mapped = linkedSetOf<String>()
        for (raw in params.acceptTypes.orEmpty()) {
            for (part in raw.split(",")) {
                when (part.trim().lowercase(Locale.ROOT)) {
                    "", "." -> Unit
                    "*/*" -> mapped.add("*/*")
                    ".pdf", "pdf", "application/pdf" -> mapped.add("application/pdf")
                    ".json", "json", "application/json" -> mapped.add("application/json")
                    ".jsonl", "jsonl", "application/x-ndjson" -> {
                        mapped.add("application/x-ndjson")
                        mapped.add("application/json")
                        mapped.add("text/plain")
                    }
                    "text/plain" -> mapped.add("text/plain")
                    else -> if (part.contains("/")) mapped.add(part.trim()) else mapped.add("*/*")
                }
            }
        }
        return if (mapped.isEmpty()) arrayOf("application/pdf") else mapped.toTypedArray()
    }

    /** WebView 布局参数：IT8951=居中 3:4 竖框；DIRECT(BOOX)=填满窗口（随旋转 reflow）。 */
    private fun webViewLayoutParams(displayMode: DisplayMode): FrameLayout.LayoutParams = when (displayMode) {
        DisplayMode.IT8951 -> {
            // 3:4 竖框，按物理屏高算宽(电纸屏 1404:1872)，居中放在深色底上。
            val screenH = resources.displayMetrics.heightPixels
            val portraitW = screenH * 3 / 4
            FrameLayout.LayoutParams(portraitW, screenH).apply { gravity = Gravity.CENTER }
        }
        DisplayMode.DIRECT -> FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
    }

    /** 显示模式：manifest meta-data com.inkloop.DISPLAY_MODE 优先(it8951/direct)；
     *  auto/缺省时「自带屏直显」设备(ONYX/BOOX、或 ro.vendor.eink=true 的 RK 原生 EBC 电纸屏如 Haoqing M103)→DIRECT，
     *  其余→IT8951(护 RK3588 外接 IT8951 USB 面板)。 */
    private fun resolveDisplayMode(): DisplayMode =
        when (readDisplayModeMetaData()?.trim()?.lowercase(Locale.ROOT)) {
            "it8951", "pixelcopy", "rk3588" -> DisplayMode.IT8951
            "direct", "boox", "onyx", "haoqing", "rkeink" -> DisplayMode.DIRECT
            else -> if (isDirectDisplayDevice()) DisplayMode.DIRECT else DisplayMode.IT8951
        }

    @Suppress("DEPRECATION")
    private fun readDisplayModeMetaData(): String? = try {
        packageManager.getActivityInfo(componentName, PackageManager.GET_META_DATA)
            .metaData?.getString(META_DISPLAY_MODE)
    } catch (_: Throwable) { null }

    /** 自带显示屏(非 IT8951 USB 外接)的设备 → WebView 填满窗口：
     *  ①ONYX/BOOX ②ro.vendor.eink=true 的 RK 原生 EBC 电纸屏(Haoqing M103·board rk3566_eink 等)。 */
    private fun isDirectDisplayDevice(): Boolean {
        val fp = arrayOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT, Build.FINGERPRINT)
            .joinToString(" ") { it.orEmpty() }.lowercase(Locale.ROOT)
        if (fp.contains("onyx") || fp.contains("boox") || fp.contains("haoqing") || fp.contains("_eink")) return true
        return systemProp("ro.vendor.eink").equals("true", ignoreCase = true)
    }

    private fun isOnyxBooxDevice(): Boolean {
        val fp = arrayOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT, Build.FINGERPRINT)
            .joinToString(" ") { it.orEmpty() }.lowercase(Locale.ROOT)
        return fp.contains("onyx") || fp.contains("boox")
    }

    private fun onyxDeviceProfile(): String {
        val model = Build.MODEL.orEmpty().lowercase(Locale.ROOT)
        return if (model.contains("t10")) "onyx-t10" else "onyx-boox"
    }

    /** DIRECT 设备里再细分：排除 ONYX/BOOX(纯直显、无 sys.eink./eink 服务这套)，
     *  只有真正的 RK 原生 EBC 电纸屏(Haoqing M103 等)才走 RkEinkBridge 的 Binder 刷新桥。 */
    private fun isRkNativeEinkDevice(): Boolean {
        val fp = arrayOf(Build.MANUFACTURER, Build.BRAND, Build.MODEL, Build.DEVICE, Build.PRODUCT, Build.FINGERPRINT)
            .joinToString(" ") { it.orEmpty() }.lowercase(Locale.ROOT)
        if (fp.contains("onyx") || fp.contains("boox")) return false
        if (fp.contains("haoqing") || fp.contains("rk3566") || fp.contains("_eink")) return true
        return systemProp("ro.vendor.eink").equals("true", ignoreCase = true)
    }

    /** 读系统属性(hidden android.os.SystemProperties，反射)。 */
    private fun systemProp(key: String): String = try {
        @Suppress("PrivateApi")
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java).invoke(null, key) as? String ?: ""
    } catch (_: Throwable) { "" }

    /** 注入只读设备身份标记 `window.__inkloopDeviceProfile`，供前端设备专用组件门控（不做交互通道，
     *  纯一次性常量，调用方只传硬编码字面量，不需要 JSON 转义）。用 addDocumentStartJavaScript 在页面
     *  脚本跑之前就位，避免竞态；不支持该 WebViewFeature 的旧内核直接跳过——设备专用功能本就该静默
     *  降级，不影响主功能。 */
    private fun injectDeviceProfile(webView: WebView, profile: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            "window.__inkloopDeviceProfile = '$profile';",
            setOf("https://$APP_HOST", "http://$APP_HOST"),
        )
    }

    /** Android 11+ 读 /sdcard 任意文件需「所有文件访问」。未授权则拉一次系统授权页（best-effort，失败静默）。
     *  电纸屏定制板多半可直接授予/已授；授权后 InkLoopFilesBridge.list 才能枚举到 /sdcard/Download 的书。 */
    private fun ensureAllFilesAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // 旧系统走 manifest READ_EXTERNAL_STORAGE
        if (Environment.isExternalStorageManager()) return
        try {
            startActivity(
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
            )
        } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) } catch (_: Throwable) { /* 静默 */ }
        }
    }

    override fun onResume() {
        super.onResume()
        if (hqHwEnabled) com.example.hmpocrpoc.HqHwBridge.onResume()
        if (isOnyxBooxDevice()) {
            com.example.hmpocrpoc.OnyxPenBridge.onResume()
            com.example.hmpocrpoc.OnyxEpdBridge.onResume()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hqHwEnabled) com.example.hmpocrpoc.HqHwBridge.onWindowFocusChanged(hasFocus)
    }

    override fun onPause() {
        if (isOnyxBooxDevice()) {
            com.example.hmpocrpoc.OnyxPenBridge.onPause()
            com.example.hmpocrpoc.OnyxEpdBridge.onPause()
        }
        if (hqHwEnabled) com.example.hmpocrpoc.HqHwBridge.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        if (hqHwEnabled) {
            com.example.hmpocrpoc.HqHwBridge.forceResetFastInk()
            com.example.hmpocrpoc.HqHwBridge.destroy()
        }
        if (isOnyxBooxDevice()) com.example.hmpocrpoc.OnyxPenBridge.destroy()
        com.example.hmpocrpoc.InkLoopLanImportBridge.shutdown()
        if (this::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
