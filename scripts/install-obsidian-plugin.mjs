import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'inkloop-sync';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_VAULT = path.join(PACKAGE_ROOT, 'examples/ai-annotation-demo/.inkloop-smoke-runs/20260626-real-flow/obsidian-vault');
const ALLOWED_FLAGS = new Set(['--vault', '--use-smoke-default-vault', '--allow-missing-sdk']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateArgs() {
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg?.startsWith('--')) continue;
    if (!ALLOWED_FLAGS.has(arg)) fail(`Unknown option: ${arg}`);
    if (arg === '--vault') {
      const value = process.argv[index + 1];
      if (!value || value.startsWith('--')) fail('--vault requires a path value.');
      index += 1;
    }
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

validateArgs();

const allowMissingSdk = process.argv.includes('--allow-missing-sdk');
const useSmokeDefaultVault = process.argv.includes('--use-smoke-default-vault');
const vaultArg = argValue('--vault');
if (!vaultArg && !useSmokeDefaultVault) fail('Missing --vault. Use --use-smoke-default-vault only for local smoke runs.');

function cleanDeviceId(input) {
  return String(input || 'obsidian-plugin')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'obsidian-plugin';
}

async function latestLocalSessionToken(tenantId, userId) {
  if (process.env.INKLOOP_DISABLE_LOCAL_SESSION_DISCOVERY === '1') return '';
  const authStorePath = process.env.INKLOOP_LOCAL_AUTH_STORE
    ? path.resolve(process.env.INKLOOP_LOCAL_AUTH_STORE)
    : path.join(PACKAGE_ROOT, 'examples/ai-annotation-demo/.inkloop/auth-sessions.json');
  try {
    const parsed = JSON.parse(await readFile(authStorePath, 'utf8'));
    const now = Date.now();
    const sessions = Object.entries(parsed.sessions || {})
      .filter(([, session]) => session?.tenant_id === tenantId && session?.user_id === userId && Number(session?.expires_at || 0) > now)
      .sort(([, left], [, right]) => Number(right?.updated_at || right?.created_at || 0) - Number(left?.updated_at || left?.created_at || 0));
    return String(sessions[0]?.[0] || '');
  } catch {
    return '';
  }
}

const warnings = [];
const vaultRoot = path.resolve(vaultArg ?? DEFAULT_VAULT);
const builtPluginSource = path.join(PACKAGE_ROOT, 'dist', 'obsidian-plugin', PLUGIN_ID);
const sourcePluginSource = path.join(PACKAGE_ROOT, 'plugins', 'obsidian', PLUGIN_ID);
const pluginSource = await pathExists(builtPluginSource) ? builtPluginSource : sourcePluginSource;
const pluginTarget = path.join(vaultRoot, '.obsidian', 'plugins', PLUGIN_ID);
const sdkBundleSource = path.join(PACKAGE_ROOT, 'dist', 'inkloop-surface-sdk.iife.js');
const sdkBundleTarget = path.join(pluginTarget, 'inkloop-surface-sdk.iife.js');

const obsidianConfigDir = path.join(vaultRoot, '.obsidian');
await mkdir(obsidianConfigDir, { recursive: true });
const appConfigPath = path.join(obsidianConfigDir, 'app.json');
if (!(await pathExists(appConfigPath))) await writeJson(appConfigPath, {});
await writeJson(path.join(obsidianConfigDir, 'restricted-mode.json'), { restrictedMode: false });
await cp(pluginSource, pluginTarget, { recursive: true, force: true });
let sdkBundleInstalled = false;
try {
  await cp(sdkBundleSource, sdkBundleTarget, { force: true });
  sdkBundleInstalled = true;
} catch (error) {
  if (!allowMissingSdk) {
    throw new Error(`Missing SDK bundle at ${sdkBundleSource}. Run npm run build from the repository root before installing the plugin.`);
  }
  warnings.push(`SDK bundle was not installed: ${String(error?.message || error)}`);
}

const enabledPath = path.join(vaultRoot, '.obsidian', 'community-plugins.json');
const enabled = await readJson(enabledPath, []);
const nextEnabled = Array.isArray(enabled) ? [...new Set([...enabled, PLUGIN_ID])] : [PLUGIN_ID];
await writeJson(enabledPath, nextEnabled);

const pluginDataPath = path.join(pluginTarget, 'data.json');
const existingData = await readJson(pluginDataPath, {});
const tenantId = process.env.INKLOOP_TENANT_ID || existingData.tenantId || 'local';
const userId = process.env.INKLOOP_USER_ID || existingData.userId || 'local_demo';
const sessionToken = process.env.INKLOOP_SESSION_TOKEN
  || process.env.INKLOOP_DEVICE_SESSION_TOKEN
  || existingData.sessionToken
  || await latestLocalSessionToken(tenantId, userId);
await writeJson(pluginDataPath, {
  ...existingData,
  baseDir: '.inkloop',
  documentsDir: 'InkLoop',
  syncEndpoint: '',
  runtimePushEndpoint: 'http://127.0.0.1:8731/v1/runtime/events:push',
  runtimePullEndpoint: 'http://127.0.0.1:8731/v1/runtime/events:pull',
  knowledgeBaseEndpoint: 'http://127.0.0.1:8731/v1/knowledge',
  deviceCommandEndpoint: 'http://127.0.0.1:8731/v1/devices/commands',
  tenantId,
  userId,
  sessionToken,
  deviceId: process.env.INKLOOP_OBSIDIAN_DEVICE_ID || existingData.deviceId || cleanDeviceId(`obsidian_${path.basename(vaultRoot)}`),
  autoSyncOnChange: true,
  debounceMs: 750,
  runtimePollMs: 2500,
  notifyManualSync: true,
  visualEnhancement: true,
  surfaceMode: 'thinking',
  inkTool: 'pen',
  inkColors: {
    pen: '#38bdf8',
    highlighter: '#facc15',
  },
  previewEditing: false,
});

console.log(JSON.stringify({
  ok: true,
  vault_root: vaultRoot,
  plugin_id: PLUGIN_ID,
  plugin_source: pluginSource,
  plugin_target: pluginTarget,
  sdk_bundle: sdkBundleTarget,
  sdk_bundle_installed: sdkBundleInstalled,
  session_token_configured: !!sessionToken,
  warnings,
  enabled_plugins: nextEnabled,
}, null, 2));
