import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const demoDir = path.join(root, 'examples/ai-annotation-demo');
const androidDir = path.join(demoDir, 'android');

function fail(message) {
  console.error(`Android/Paper debug build failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) fail(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function firstExisting(paths) {
  return paths.find((candidate) => existsSync(candidate));
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  return firstExisting([
    path.join(os.homedir(), '.cache/inkloop-tools/jdks/temurin17/Contents/Home'),
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  ]);
}

function resolveAndroidSdk() {
  if (process.env.ANDROID_HOME && existsSync(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT && existsSync(process.env.ANDROID_SDK_ROOT)) return process.env.ANDROID_SDK_ROOT;
  return firstExisting([
    path.join(os.homedir(), 'Library/Android/sdk'),
    '/opt/android-sdk',
  ]);
}

function resolveLanIp() {
  const nets = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
    for (const item of nets[name] ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  for (const items of Object.values(nets)) {
    for (const item of items ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

function resolveDevApiBase() {
  if (process.env.VITE_API_BASE_URL) return process.env.VITE_API_BASE_URL;
  const ip = resolveLanIp();
  const httpsPort = process.env.INKLOOP_CLOUD_HUB_HTTPS_PORT || process.env.INKLOOP_HTTPS_PORT || '8732';
  const httpPort = process.env.INKLOOP_CLOUD_HUB_PORT || process.env.INKLOOP_DEV_API_PORT || '8731';
  if (ip && process.env.INKLOOP_ANDROID_HTTPS_API_BASE === '1') return `https://${ip}:${httpsPort}`;
  return ip ? `http://${ip}:${httpPort}` : '';
}

function resolveLocalDemoAuthFlag() {
  if (process.env.VITE_INKLOOP_LOCAL_DEMO_AUTH !== undefined) return process.env.VITE_INKLOOP_LOCAL_DEMO_AUTH;
  if (process.env.INKLOOP_ANDROID_LOCAL_DEMO_AUTH !== undefined) return process.env.INKLOOP_ANDROID_LOCAL_DEMO_AUTH;
  return '0';
}

const javaHome = resolveJavaHome();
if (!javaHome) {
  fail('JDK 17 not found. Set JAVA_HOME or install the local Temurin JDK at ~/.cache/inkloop-tools/jdks/temurin17/Contents/Home.');
}

const androidSdk = resolveAndroidSdk();
if (!androidSdk) {
  fail('Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.');
}

const androidBuildEnv = {
  ...process.env,
  VITE_INKLOOP_LOCAL_DEMO_AUTH: resolveLocalDemoAuthFlag(),
  VITE_API_BASE_URL: resolveDevApiBase(),
};

if (androidBuildEnv.VITE_API_BASE_URL) {
  console.log(`Android/Paper debug API base: ${androidBuildEnv.VITE_API_BASE_URL}`);
} else {
  console.warn('Android/Paper debug API base is empty. Device Cloud Hub sync will require runtime route configuration.');
}
console.log(`Android/Paper debug auth mode: ${androidBuildEnv.VITE_INKLOOP_LOCAL_DEMO_AUTH === '1' ? 'local-demo fallback' : 'device session required'}`);

run('npm', ['--workspace', './examples/ai-annotation-demo', 'run', 'build'], { env: androidBuildEnv });
run('npm', ['--workspace', './examples/ai-annotation-demo', 'run', 'verify:android-paper-assets']);

run('./gradlew', [':app:assembleDebug', '--no-daemon'], {
  cwd: androidDir,
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidSdk,
    ANDROID_SDK_ROOT: androidSdk,
    JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ''} -Djava.net.preferIPv4Stack=true`.trim(),
  },
});

console.log('Android/Paper debug APK ready: examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk');
