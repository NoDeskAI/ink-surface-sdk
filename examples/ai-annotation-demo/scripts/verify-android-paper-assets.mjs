import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const androidAssetDir = path.join(root, 'android/app/src/main/assets');
const androidMainActivity = path.join(root, 'android/app/src/main/java/com/inkloop/app/MainActivity.kt');
const androidManifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const androidIntegration = path.join(root, 'android/INTEGRATION.md');
const androidRuntimeBridge = path.join(root, 'android/app/src/main/java/com/example/hmpocrpoc/InkLoopRuntimeBridge.kt');
const androidLanImportBridge = path.join(root, 'android/app/src/main/java/com/example/hmpocrpoc/InkLoopLanImportBridge.kt');
const mobileHtml = path.join(root, 'mobile.html');
const mobileMain = path.join(root, 'src/mobile-main.ts');
const mobileCss = path.join(root, 'src/mobile/mobile.css');
const inkCapture = path.join(root, 'src/capture/ink.ts');
const m103RawPenAdapter = path.join(root, 'src/capture/m103-raw-pen-adapter.ts');

const failures = [];
const checked = [];
const checkedSyncedFiles = new Set();

function note(message) {
  checked.push(message);
}

function fail(message) {
  failures.push(message);
}

function mustExist(filePath, label = filePath) {
  if (!existsSync(filePath)) {
    fail(`missing ${label}: ${path.relative(root, filePath)}`);
    return false;
  }
  return true;
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function requireIncludes(filePath, needles) {
  if (!mustExist(filePath)) return;
  const text = readText(filePath);
  for (const needle of needles) {
    if (!text.includes(needle)) {
      fail(`${path.relative(root, filePath)} does not include required text: ${needle}`);
    }
  }
  note(`${path.relative(root, filePath)}: required Android/Paper boundary text present`);
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function requireSyncedFile(relativePath) {
  const distPath = path.join(distDir, relativePath);
  const assetPath = path.join(androidAssetDir, relativePath);
  if (!mustExist(distPath, `dist ${relativePath}`) || !mustExist(assetPath, `Android asset ${relativePath}`)) return;
  if (hashFile(distPath) !== hashFile(assetPath)) {
    fail(`Android asset is stale for ${relativePath}`);
    return;
  }
  if (checkedSyncedFiles.has(relativePath)) return;
  checkedSyncedFiles.add(relativePath);
  note(`${relativePath}: dist and Android asset copy match`);
}

function localReferencesFromHtml(relativeHtmlPath) {
  const htmlPath = path.join(distDir, relativeHtmlPath);
  if (!mustExist(htmlPath, `dist ${relativeHtmlPath}`)) return [];
  const html = readText(htmlPath);
  const refs = new Set();
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;
  while ((match = attrPattern.exec(html))) {
    const raw = match[1];
    if (!raw || raw.startsWith('#') || raw.startsWith('data:') || /^[a-z]+:/i.test(raw)) continue;
    const withoutQuery = raw.split('?')[0].split('#')[0];
    if (!withoutQuery || withoutQuery.startsWith('/')) continue;
    refs.add(path.normalize(path.join(path.dirname(relativeHtmlPath), withoutQuery)));
  }
  if (refs.size === 0) fail(`${relativeHtmlPath} has no local script/style references`);
  return [...refs].sort();
}

function verifyEntrypoints() {
  const entries = ['ai-pen-demo.html', 'index.html', 'mobile.html'];
  if (!mustExist(distDir, 'dist directory')) return;
  if (!mustExist(androidAssetDir, 'Android assets directory')) return;
  for (const entry of entries) {
    requireSyncedFile(entry);
    for (const ref of localReferencesFromHtml(entry)) {
      requireSyncedFile(ref);
    }
  }
  note('Vite multi-page entries and referenced JS/CSS assets are mirrored into Android assets');
}

function verifyAndroidRuntimeBoundary() {
  requireIncludes(androidManifest, ['android:label="InkLoop Paper"']);
  requireIncludes(androidManifest, [
    'android:launchMode="singleTop"',
    'android:scheme="inkloop"',
    'android:host="oauth"',
    'android:path="/lark/callback"',
  ]);
  requireIncludes(androidMainActivity, [
    'APP_URL_HTTPS = "https://appassets.androidplatform.net/assets/mobile.html"',
    'APP_URL_HTTP = "http://appassets.androidplatform.net/assets/mobile.html"',
    '.setHttpAllowed(debuggable)',
    'webView.loadUrl(appUrlForIntent(intent, debuggable))',
    'override fun onNewIntent(intent: Intent)',
    'isLarkOAuthCallback(uri)',
    'appUrlForOAuthCallback(uri',
    'appendQueryParameter("inkloop_oauth", "lark")',
    'onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError)',
    'isLocalCloudHubSslError(error)',
    'mixedContentMode = if (debuggable) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW',
    'InkLoop Paper V1 demo',
    'InkLoopRuntimeBridge.attach(webView)',
    'InkLoopLanImportBridge.attach(webView, this)',
    'InkLoopLanImportBridge.shutdown()',
    'RawPenFrame JSON/JSONL',
    'acceptedMimeTypes(params)',
    'application/x-ndjson',
  ]);
  requireIncludes(androidLanImportBridge, [
    'window.InkLoopLanImport',
    'ServerSocket',
    '0.0.0.0',
    'multipart/form-data',
    'lan-inbox',
    'readBase64',
    'same Wi-Fi',
  ]);
  requireIncludes(androidRuntimeBridge, [
    'window.InkLoopRuntime',
    'inkloop.android_runtime_manifest.v1',
    'InkLoop Paper',
    'sync_loop',
    'Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection',
    'web-cloud-first-paper-local-first',
  ]);
  requireIncludes(mobileHtml, [
    'runtime-boundary',
    'InkLoop Paper',
    'V1 demo · Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection',
  ]);
  requireIncludes(mobileMain, [
    'InkLoopRuntime',
    'initAndroidRuntimeBoundary',
    'V1 demo · Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection',
    'sync_loop',
    'web-cloud-first-paper-local-first',
    'InkLoopLanImport',
    '局域网上传',
    'Wi-Fi 收件箱',
    'readLanImportState',
    'installM103RawPenCaptureBridge',
  ]);
  requireIncludes(mobileCss, [
    '#runtime-boundary',
    '#runtime-boundary[hidden]',
    'white-space:normal',
    '.lanbox',
  ]);
  requireIncludes(inkCapture, [
    'publishM103RawPenStroke',
    'm103_hqhw_stylus',
    'm103-hqhw-bridge',
    'surfaceRect: cv.getBoundingClientRect()',
  ]);
  requireIncludes(m103RawPenAdapter, [
    'M103_RAW_PEN_CAPTURE_BRIDGE_NAME',
    'InkLoopM103RawPenCapture',
    'RAW_PEN_FRAME_BRIDGE_NAME',
    'm103SocketStrokeToRawPenFrames',
    'publishM103RawPenStroke',
    'installM103RawPenCaptureBridge',
    'framesToJsonl',
    'getAllFrames',
    'getSummary',
    'exportAllJsonl',
    'validateRawFrameRecords',
    'm103_hqunifiedsocket',
    'android_native',
  ]);
  requireIncludes(androidIntegration, [
    'ai-pen-demo.html',
    'mobile.html',
    'HqHwBridge',
    'hqunifiedsocket',
    'm103-raw-pen-adapter.ts',
    'window.InkLoopM103RawPenCapture',
    'exportJsonl()',
    'exportAllJsonl()',
    'smoke:m103-physical-pen-capture',
    'InkLoopLanImport',
    '局域网上传',
    '同一 Wi-Fi',
    'Cloud Hub first',
  ]);
}

function verifyPdfRuntimeAssets() {
  for (const dir of ['cmaps', 'standard_fonts']) {
    const target = path.join(androidAssetDir, dir);
    if (!mustExist(target, `Android PDF runtime asset directory ${dir}`)) continue;
    const count = readdirSync(target).filter((entry) => statSync(path.join(target, entry)).isFile()).length;
    if (count === 0) fail(`Android PDF runtime asset directory is empty: ${dir}`);
    else note(`${dir}: ${count} Android PDF runtime assets available`);
  }
}

verifyEntrypoints();
verifyPdfRuntimeAssets();
verifyAndroidRuntimeBoundary();

if (failures.length > 0) {
  console.error('Android/Paper asset verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Android/Paper asset verification passed:');
for (const message of checked) console.log(`- ${message}`);
