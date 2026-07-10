package com.example.hmpocrpoc

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.Charset
import java.security.SecureRandom
import java.util.Locale
import kotlin.concurrent.thread

/**
 * JS bridge: window.InkLoopLanImport.
 *
 * Starts a tiny local HTTP upload server on the e-paper device so a desktop on the
 * same Wi-Fi can push PDFs into the app-specific LAN inbox. The WebView then reads
 * those uploaded files through readBase64(...) and imports them into the local
 * Library automatically.
 */
object InkLoopLanImportBridge {
    private const val JS_OBJECT = "InkLoopLanImport"
    private const val LAN_UPLOAD_PORT = 8787
    private var server: LanUploadServer? = null

    @JvmStatic
    fun attach(webView: WebView, context: Context) {
        webView.addJavascriptInterface(JsApi(context.applicationContext), JS_OBJECT)
    }

    @JvmStatic
    fun shutdown() {
        synchronized(this) {
            server?.stop()
            server = null
        }
    }

    private class JsApi(private val ctx: Context) {
        @JavascriptInterface
        fun start(): String = synchronized(InkLoopLanImportBridge) {
            val s = server ?: LanUploadServer(ctx).also { server = it }
            s.start()
            s.state().toString()
        }

        @JavascriptInterface
        fun stop(): String = synchronized(InkLoopLanImportBridge) {
            server?.stop()
            server = null
            LanUploadServer.emptyState(ctx).toString()
        }

        @JavascriptInterface
        fun getState(): String = synchronized(InkLoopLanImportBridge) {
            (server?.state() ?: LanUploadServer.emptyState(ctx)).toString()
        }

        @JavascriptInterface
        fun list(): String = synchronized(InkLoopLanImportBridge) {
            (server ?: LanUploadServer(ctx)).listInbox().toString()
        }

        @JavascriptInterface
        fun readBase64(path: String): String = try {
            val s = server ?: LanUploadServer(ctx)
            val f = s.safeInboxFile(path) ?: return ""
            Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            ""
        }

        @JavascriptInterface
        fun delete(path: String): Boolean = try {
            val s = server ?: LanUploadServer(ctx)
            s.safeInboxFile(path)?.delete() == true
        } catch (_: Throwable) {
            false
        }
    }

    private class LanUploadServer(private val ctx: Context) {
        @Volatile private var socket: ServerSocket? = null
        @Volatile private var worker: Thread? = null
        @Volatile private var bindPort: Int = 0
        @Volatile private var lastError: String? = null
        @Volatile private var uploadToken: String = randomToken()
        @Volatile private var wifiLock: WifiManager.WifiLock? = null
        @Volatile private var lastUploadName: String? = null
        @Volatile private var lastUploadSize: Long = 0
        @Volatile private var lastUploadAt: Long = 0

        private val inboxDir: File = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "lan-inbox").apply { mkdirs() }

        fun start() {
            if (socket?.isClosed == false) return
            lastError = null
            uploadToken = randomToken()
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress("0.0.0.0", LAN_UPLOAD_PORT))
                socket = ss
                bindPort = LAN_UPLOAD_PORT
                acquireWifiLock()
                worker = thread(name = "InkLoopLanImport-$LAN_UPLOAD_PORT", isDaemon = true) { acceptLoop(ss) }
            } catch (e: Throwable) {
                lastError = "port_$LAN_UPLOAD_PORT:${e.message ?: e.javaClass.simpleName}"
            }
        }

        fun stop() {
            try { socket?.close() } catch (_: Throwable) { /* no-op */ }
            socket = null
            worker = null
            bindPort = 0
            releaseWifiLock()
        }

        fun state(): JSONObject {
            val running = socket?.isClosed == false
            val ip = deviceIp()
            val o = JSONObject()
                .put("running", running)
                .put("port", if (running) bindPort else LAN_UPLOAD_PORT)
                .put("ip", ip ?: JSONObject.NULL)
                .put("url", if (running && ip != null) "http://$ip:$bindPort/?token=$uploadToken" else JSONObject.NULL)
                .put("token", if (running) uploadToken else JSONObject.NULL)
                .put("wifi_lock_held", wifiLock?.isHeld == true)
                .put("ip_candidates", ipCandidates())
                .put("inbox", listInbox())
                .put("last_upload", lastUploadState())
            lastError?.let { o.put("error", it) }
            return o
        }

        private fun lastUploadState(): JSONObject? {
            val name = lastUploadName ?: return null
            return JSONObject()
                .put("name", name)
                .put("size", lastUploadSize)
                .put("uploadedAt", lastUploadAt)
                .put("status", "saved")
        }

        fun listInbox(): JSONArray {
            inboxDir.mkdirs()
            val arr = JSONArray()
            inboxDir.listFiles()?.filter { it.isFile && !it.name.startsWith(".") }
                ?.sortedByDescending { it.lastModified() }
                ?.forEach { f ->
                    arr.put(
                        JSONObject()
                            .put("name", f.name)
                            .put("path", f.absolutePath)
                            .put("dir", false)
                            .put("size", f.length())
                            .put("uploadedAt", f.lastModified())
                    )
                }
            return arr
        }

        fun safeInboxFile(path: String): File? = try {
            val f = File(path)
            val inbox = inboxDir.canonicalFile
            val target = f.canonicalFile
            if (target.isFile && target.path.startsWith(inbox.path + File.separator)) target else null
        } catch (_: Throwable) {
            null
        }

        private fun acquireWifiLock() {
            try {
                val manager = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
                val lock = wifiLock ?: manager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "InkLoop:LanImport").also {
                    it.setReferenceCounted(false)
                    wifiLock = it
                }
                if (!lock.isHeld) lock.acquire()
            } catch (e: Throwable) {
                lastError = "wifi_lock:${e.message ?: e.javaClass.simpleName}"
            }
        }

        private fun releaseWifiLock() {
            try {
                val lock = wifiLock
                if (lock?.isHeld == true) lock.release()
            } catch (_: Throwable) {
                // Releasing a best-effort lock must not block server shutdown.
            } finally {
                wifiLock = null
            }
        }

        private fun acceptLoop(ss: ServerSocket) {
            while (!ss.isClosed) {
                try {
                    val client = ss.accept()
                    thread(name = "InkLoopLanImportRequest", isDaemon = true) { handle(client) }
                } catch (_: Throwable) {
                    if (!ss.isClosed) lastError = "accept_failed"
                }
            }
        }

        private fun handle(client: Socket) {
            client.use { sock ->
                try {
                    val input = BufferedInputStream(sock.getInputStream())
                    val request = readLine(input) ?: return
                    val parts = request.split(" ")
                    if (parts.size < 2) return respond(sock, "400 Bad Request", "text/plain; charset=utf-8", "Bad request")
                    val method = parts[0].uppercase(Locale.ROOT)
                    val rawTarget = parts[1]
                    val path = routePath(rawTarget)
                    val headers = readHeaders(input)
                    when {
                        method == "GET" && path == "/" && hasValidToken(rawTarget) -> respond(sock, "200 OK", "text/html; charset=utf-8", uploadPage(uploadToken))
                        method == "GET" && path == "/state" && hasValidToken(rawTarget) -> respond(sock, "200 OK", "application/json; charset=utf-8", state().toString())
                        method == "POST" && path == "/upload" && hasValidToken(rawTarget) -> handleUpload(sock, input, headers)
                        (path == "/" || path == "/state" || path == "/upload") -> respond(sock, "403 Forbidden", "text/plain; charset=utf-8", "Invalid upload token")
                        else -> respond(sock, "404 Not Found", "text/plain; charset=utf-8", "Not found")
                    }
                } catch (e: Throwable) {
                    lastError = e.message ?: e.javaClass.simpleName
                    respond(sock, "500 Internal Server Error", "text/plain; charset=utf-8", "Upload failed")
                }
            }
        }

        private fun handleUpload(sock: Socket, input: BufferedInputStream, headers: Map<String, String>) {
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            if (length <= 0) return respond(sock, "400 Bad Request", "text/plain; charset=utf-8", "Missing body")
            if (length > MAX_UPLOAD_BYTES) return respond(sock, "413 Payload Too Large", "text/plain; charset=utf-8", "File too large")
            val contentType = headers["content-type"].orEmpty()
            val boundary = contentType.substringAfter("boundary=", "").trim().trim('"')
            if (!contentType.startsWith("multipart/form-data") || boundary.isBlank()) {
                return respond(sock, "415 Unsupported Media Type", "text/plain; charset=utf-8", "Use multipart/form-data")
            }
            val body = readBytes(input, length)
            val part = parseMultipartFile(body, boundary)
                ?: return respond(sock, "400 Bad Request", "text/plain; charset=utf-8", "No file part")
            if (!isSupportedFilename(part.filename)) {
                return respond(sock, "415 Unsupported Media Type", "text/plain; charset=utf-8", "Only PDF, EPUB, and Markdown files are supported")
            }
            val file = uniqueFile(sanitizeFilename(part.filename))
            file.writeBytes(part.bytes)
            lastUploadName = file.name
            lastUploadSize = file.length()
            lastUploadAt = System.currentTimeMillis()
            respond(sock, "200 OK", "text/html; charset=utf-8", uploadedPage(file.name, uploadToken))
        }

        private fun respond(sock: Socket, status: String, contentType: String, body: String) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 $status\r\n" +
                "Connection: close\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "\r\n"
            val out = sock.getOutputStream()
            out.write(head.toByteArray(Charsets.US_ASCII))
            out.write(bytes)
            out.flush()
        }

        private fun uniqueFile(cleanName: String): File {
            val dot = cleanName.lastIndexOf('.')
            val base = if (dot > 0) cleanName.substring(0, dot) else cleanName
            val ext = if (dot > 0) cleanName.substring(dot) else ""
            var candidate = File(inboxDir, cleanName)
            var index = 2
            while (candidate.exists()) {
                candidate = File(inboxDir, "${base}_${index}${ext}")
                index += 1
            }
            return candidate
        }

        private fun sanitizeFilename(raw: String): String {
            val leaf = raw.substringAfterLast('/').substringAfterLast('\\').trim()
            val clean = leaf.map { c ->
                if (c.isLetterOrDigit() || c == '.' || c == '_' || c == '-' || c == ' ' || c == '(' || c == ')') c else '_'
            }.joinToString("").trim().trim('.')
            return clean.ifBlank { "inkloop-upload.bin" }.take(96)
        }

        private fun parseMultipartFile(body: ByteArray, boundary: String): UploadedPart? {
            val boundaryBytes = "--$boundary".toByteArray(ASCII)
            val headerEndNeedle = "\r\n\r\n".toByteArray(ASCII)
            val nextBoundaryNeedle = "\r\n--$boundary".toByteArray(ASCII)
            var offset = indexOf(body, boundaryBytes, 0)
            while (offset >= 0) {
                val headerStart = indexOf(body, "\r\n".toByteArray(ASCII), offset)
                if (headerStart < 0) return null
                val headerEnd = indexOf(body, headerEndNeedle, headerStart + 2)
                if (headerEnd < 0) return null
                val headers = body.copyOfRange(headerStart + 2, headerEnd).toString(Charsets.UTF_8)
                val filename = filenameFromDisposition(headers)
                val dataStart = headerEnd + headerEndNeedle.size
                val dataEnd = indexOf(body, nextBoundaryNeedle, dataStart).let { if (it >= 0) it else body.size }
                if (!filename.isNullOrBlank() && dataEnd >= dataStart) {
                    return UploadedPart(filename, body.copyOfRange(dataStart, dataEnd))
                }
                offset = indexOf(body, boundaryBytes, dataStart)
            }
            return null
        }

        private fun filenameFromDisposition(headers: String): String? {
            Regex("""filename="([^"]*)"""").find(headers)?.let { return it.groupValues[1] }
            Regex("""filename=([^;\r\n]+)""").find(headers)?.let { return it.groupValues[1].trim().trim('"') }
            return null
        }

        private fun routePath(rawTarget: String): String = rawTarget.substringBefore('?')

        private fun tokenFrom(rawTarget: String): String {
            val query = rawTarget.substringAfter('?', "")
            return query.split('&')
                .mapNotNull {
                    val idx = it.indexOf('=')
                    if (idx <= 0) null else it.substring(0, idx) to it.substring(idx + 1)
                }
                .firstOrNull { it.first == "token" }
                ?.second
                .orEmpty()
        }

        private fun hasValidToken(rawTarget: String): Boolean = tokenFrom(rawTarget) == uploadToken

        private fun isSupportedFilename(name: String): Boolean =
            name.endsWith(".pdf", ignoreCase = true)
                || name.endsWith(".epub", ignoreCase = true)
                || name.endsWith(".md", ignoreCase = true)
                || name.endsWith(".markdown", ignoreCase = true)

        private fun uploadPage(token: String): String = """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>InkLoop LAN Import</title>
            <style>
              body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:28px;line-height:1.5;color:#111;background:#fff}
              main{max-width:560px}form{border:1px solid #bbb;padding:18px;border-radius:10px}
              input,button{font-size:16px}button{margin-top:14px;padding:10px 14px;border:1px solid #111;border-radius:8px;background:#111;color:#fff}
              button:disabled{opacity:.45}.hint{color:#555;font-size:14px}.status{margin-top:14px;border:1px solid #ccc;border-radius:8px;padding:10px;font-size:14px;min-height:22px}
              .bar{height:10px;background:#eee;border:1px solid #bbb;border-radius:999px;margin-top:12px;overflow:hidden}.bar span{display:block;height:100%;width:0;background:#111;transition:width .12s linear}
              .meta{margin-top:8px;color:#555;font-size:13px}.ok{font-weight:700}.err{font-weight:700;color:#000}
            </style>
            </head><body><h1>InkLoop LAN Import</h1><p class="hint">Upload a PDF, EPUB, or Markdown file from this computer to the e-paper device on the same Wi-Fi. InkLoop will add it to the local Library automatically.</p>
            <main>
            <form id="upload-form" method="post" action="/upload?token=${escapeHtml(token)}" enctype="multipart/form-data">
              <input id="file" type="file" name="file" accept=".pdf,.epub,.md,.markdown,application/pdf,application/epub+zip,text/markdown"><br>
              <button id="submit" type="submit">Upload to InkLoop</button>
              <div class="bar" aria-hidden="true"><span id="bar"></span></div>
              <div id="status" class="status">Choose a file to upload.</div>
              <div id="meta" class="meta"></div>
            </form>
            </main>
            <script>
            const token = ${jsonString(token)};
            const form = document.getElementById('upload-form');
            const fileInput = document.getElementById('file');
            const submit = document.getElementById('submit');
            const statusEl = document.getElementById('status');
            const metaEl = document.getElementById('meta');
            const bar = document.getElementById('bar');
            const fmt = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
            function setProgress(pct, text, cls) {
              bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
              statusEl.className = 'status ' + (cls || '');
              statusEl.textContent = text;
            }
            async function pollState(name, tries = 10) {
              try {
                const res = await fetch('/state?token=' + encodeURIComponent(token), { cache: 'no-store' });
                const state = await res.json();
                const inbox = Array.isArray(state.inbox) ? state.inbox : [];
                const saved = state.last_upload && state.last_upload.name;
                const inInbox = inbox.some((item) => item && item.name === name);
                if (saved === name || inInbox) {
                  setProgress(100, 'Device received the file. InkLoop is adding it to Library and syncing Cloud Hub.', 'ok');
                  return;
                }
              } catch (_) {}
              if (tries > 0) setTimeout(() => pollState(name, tries - 1), 900);
            }
            form.addEventListener('submit', (event) => {
              event.preventDefault();
              const file = fileInput.files && fileInput.files[0];
              if (!file) { setProgress(0, 'Choose a file first.', 'err'); return; }
              const data = new FormData();
              data.append('file', file);
              const xhr = new XMLHttpRequest();
              submit.disabled = true;
              metaEl.textContent = file.name + ' · ' + fmt(file.size);
              setProgress(1, 'Starting upload...', '');
              xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) { setProgress(8, 'Uploading...', ''); return; }
                const pct = Math.round((event.loaded / event.total) * 100);
                setProgress(pct, 'Uploading ' + pct + '% (' + fmt(event.loaded) + ' / ' + fmt(event.total) + ')', '');
              };
              xhr.onerror = () => { submit.disabled = false; setProgress(0, 'Upload failed. Check Wi-Fi and retry.', 'err'); };
              xhr.onload = () => {
                submit.disabled = false;
                if (xhr.status >= 200 && xhr.status < 300) {
                  setProgress(100, 'Upload complete. Waiting for InkLoop Library...', 'ok');
                  pollState(file.name);
                  fileInput.value = '';
                } else {
                  setProgress(0, 'Upload failed: HTTP ' + xhr.status + '. ' + (xhr.responseText || ''), 'err');
                }
              };
              xhr.open('POST', '/upload?token=' + encodeURIComponent(token));
              xhr.send(data);
            });
            </script>
            </body></html>
        """.trimIndent()

        private fun uploadedPage(name: String, token: String): String = """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Uploaded</title></head><body><h1>Uploaded</h1><p>${escapeHtml(name)} is being added to the InkLoop Library.</p><p><a href="/?token=${escapeHtml(token)}">Upload another file</a></p></body></html>
        """.trimIndent()

        private fun escapeHtml(s: String): String = s
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")

        private fun jsonString(s: String): String = JSONObject.quote(s)

        companion object {
            private const val MAX_UPLOAD_BYTES = 80 * 1024 * 1024
            private val ASCII: Charset = Charsets.US_ASCII

            fun emptyState(ctx: Context): JSONObject = JSONObject()
                .put("running", false)
                .put("port", LAN_UPLOAD_PORT)
                .put("ip", deviceIp() ?: JSONObject.NULL)
                .put("url", JSONObject.NULL)
                .put("wifi_lock_held", false)
                .put("ip_candidates", ipCandidates())
                .put("inbox", LanUploadServer(ctx).listInbox())

            private val TOKEN_RANDOM = SecureRandom()

            private fun randomToken(): String {
                val bytes = ByteArray(16)
                TOKEN_RANDOM.nextBytes(bytes)
                return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            }

            private fun readLine(input: BufferedInputStream): String? {
                val out = ArrayList<Byte>(128)
                while (true) {
                    val b = input.read()
                    if (b < 0) break
                    if (b == '\n'.code) break
                    if (b != '\r'.code) out.add(b.toByte())
                }
                if (out.isEmpty()) return null
                return out.toByteArray().toString(ASCII)
            }

            private fun readHeaders(input: BufferedInputStream): Map<String, String> {
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isBlank()) break
                    val idx = line.indexOf(':')
                    if (idx > 0) headers[line.substring(0, idx).trim().lowercase(Locale.ROOT)] = line.substring(idx + 1).trim()
                }
                return headers
            }

            private fun readBytes(input: BufferedInputStream, length: Int): ByteArray {
                val body = ByteArray(length)
                var offset = 0
                while (offset < length) {
                    val read = input.read(body, offset, length - offset)
                    if (read <= 0) break
                    offset += read
                }
                return if (offset == length) body else body.copyOf(offset)
            }

            private fun indexOf(haystack: ByteArray, needle: ByteArray, start: Int): Int {
                if (needle.isEmpty() || start >= haystack.size) return -1
                outer@ for (i in start..(haystack.size - needle.size)) {
                    for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
                    return i
                }
                return -1
            }

            private fun ipCandidates(): JSONArray = try {
                val arr = JSONArray()
                NetworkInterface.getNetworkInterfaces().toList()
                    .filter { it.isUp }
                    .sortedWith(compareBy<NetworkInterface> { if (it.name == "wlan0") 0 else 1 }.thenBy { it.name })
                    .forEach { network ->
                        network.inetAddresses.toList()
                            .filterIsInstance<Inet4Address>()
                            .forEach { address ->
                                arr.put(
                                    JSONObject()
                                        .put("interface", network.name)
                                        .put("address", address.hostAddress)
                                        .put("loopback", address.isLoopbackAddress)
                                        .put("link_local", address.hostAddress?.startsWith("169.254.") == true)
                                )
                            }
                    }
                arr
            } catch (_: Throwable) {
                JSONArray()
            }

            private fun deviceIp(): String? = try {
                NetworkInterface.getNetworkInterfaces().toList()
                    .filter { it.isUp }
                    .sortedWith(compareBy<NetworkInterface> { if (it.name == "wlan0") 0 else 1 }.thenBy { it.name })
                    .flatMap { it.inetAddresses.toList() }
                    .filterIsInstance<Inet4Address>()
                    .firstOrNull { !it.isLoopbackAddress && it.hostAddress?.startsWith("169.254.") != true }
                    ?.hostAddress
            } catch (_: Throwable) {
                null
            }
        }
    }

    private data class UploadedPart(val filename: String, val bytes: ByteArray)
}
