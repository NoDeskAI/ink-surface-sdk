/**
 * 把前端构建产物 + 端侧模型同步进安卓工程的 assets/。
 *
 *   node scripts/sync-android-assets.mjs
 *
 * 前置：先 `VITE_API_BASE_URL=<Cloud Hub 或 proxy> npm run build` 生成 dist/。
 * 结果：android/app/src/main/assets/
 *   ├─ mobile.html, index.html, ai-pen-demo.html, assets/*, cmaps/, standard_fonts/ ← 来自 dist/
 *   └─ models/, dictionaries/                                       ← 来自 APK 解出的端侧资产（Phase 2）
 *
 * WebViewAssetLoader 把 URL /assets/ 映射到本目录，故页面地址是
 *   https://appassets.androidplatform.net/assets/mobile.html
 */
import { existsSync, rmSync, mkdirSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const ASSETS = resolve(ROOT, 'android/app/src/main/assets');
// APK 解出的端侧模型/词典（见 端侧ocr方案/extracted_assets）。
const ONDEVICE = resolve(ROOT, '../端侧ocr方案/extracted_assets/assets');

if (!existsSync(DIST)) {
  console.error('✗ dist/ 不存在。先跑：VITE_API_BASE_URL=<Cloud Hub 或 proxy> npm run build');
  process.exit(1);
}

function collectJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, name.name);
    if (name.isDirectory()) out.push(...collectJsFiles(path));
    else if (name.isFile() && name.name.endsWith('.js')) out.push(path);
  }
  return out;
}

function assertAndroidApiBaseIsNotLoopback() {
  if (process.env.INKLOOP_ALLOW_ANDROID_LOOPBACK_API === '1') return;
  const text = collectJsFiles(DIST).map((file) => readFileSync(file, 'utf8')).join('\n');
  const hasAppassetsBundle = text.includes('appassets.androidplatform.net');
  if (!hasAppassetsBundle) return;
  const hasUsableBase = /https:\/\/inkloopai\.xiaobuyu\.trade/.test(text)
    || /https?:\/\/(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.[^"'`\\\s]+:8731/.test(text);
  if (hasUsableBase) return;
  console.error('✗ Android assets 缺少可从真机访问的 VITE_API_BASE_URL。');
  console.error('  请先执行：VITE_API_BASE_URL=http://<Mac-LAN-IP>:8731 npm run build');
  console.error('  只有 USB 临时调试才允许：INKLOOP_ALLOW_ANDROID_LOOPBACK_API=1 npm run verify:android-paper-assets');
  process.exit(1);
}

assertAndroidApiBaseIsNotLoopback();

rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });
cpSync(DIST, ASSETS, { recursive: true });
console.log('✓ dist → android assets');

if (existsSync(resolve(ONDEVICE, 'models'))) {
  cpSync(resolve(ONDEVICE, 'models'), resolve(ASSETS, 'models'), { recursive: true });
  console.log('✓ models → android assets/models');
}
if (existsSync(resolve(ONDEVICE, 'dictionaries'))) {
  cpSync(resolve(ONDEVICE, 'dictionaries'), resolve(ASSETS, 'dictionaries'), { recursive: true });
  console.log('✓ dictionaries → android assets/dictionaries');
}
console.log('完成。Android Studio 里构建 :app 即可。');
