import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLUGIN_ID = 'inkloop-sync';
const DEFAULT_VAULT = path.resolve('.inkloop-smoke-runs/20260626-real-flow/obsidian-vault');
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

validateArgs();

const allowMissingSdk = process.argv.includes('--allow-missing-sdk');
const useSmokeDefaultVault = process.argv.includes('--use-smoke-default-vault');
const vaultArg = argValue('--vault');
if (!vaultArg && !useSmokeDefaultVault) fail('Missing --vault. Use --use-smoke-default-vault only for local smoke runs.');

const warnings = [];
const vaultRoot = path.resolve(vaultArg ?? DEFAULT_VAULT);
const pluginSource = path.resolve('obsidian-plugin', PLUGIN_ID);
const pluginTarget = path.join(vaultRoot, '.obsidian', 'plugins', PLUGIN_ID);
const sdkBundleSource = path.resolve('dist', 'inkloop-surface-sdk', 'inkloop-surface-sdk.iife.js');
const sdkBundleTarget = path.join(pluginTarget, 'inkloop-surface-sdk.iife.js');

await mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
await cp(pluginSource, pluginTarget, { recursive: true, force: true });
let sdkBundleInstalled = false;
try {
  await cp(sdkBundleSource, sdkBundleTarget, { force: true });
  sdkBundleInstalled = true;
} catch (error) {
  if (!allowMissingSdk) {
    throw new Error(`Missing SDK bundle at ${sdkBundleSource}. Run npm run build:sdk before installing the plugin.`);
  }
  warnings.push(`SDK bundle was not installed: ${String(error?.message || error)}`);
}

const enabledPath = path.join(vaultRoot, '.obsidian', 'community-plugins.json');
const enabled = await readJson(enabledPath, []);
const nextEnabled = Array.isArray(enabled) ? [...new Set([...enabled, PLUGIN_ID])] : [PLUGIN_ID];
await writeJson(enabledPath, nextEnabled);

const pluginDataPath = path.join(pluginTarget, 'data.json');
const existingData = await readJson(pluginDataPath, {});
await writeJson(pluginDataPath, {
  baseDir: '.inkloop',
  documentsDir: 'InkLoop',
  syncEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/pull',
  autoSyncOnChange: true,
  debounceMs: 750,
  notifyManualSync: true,
  visualEnhancement: true,
  surfaceMode: 'thinking',
  inkTool: 'pen',
  inkColors: {
    pen: '#38bdf8',
    highlighter: '#facc15',
  },
  ...existingData,
  previewEditing: false,
});

console.log(JSON.stringify({
  ok: true,
  vault_root: vaultRoot,
  plugin_id: PLUGIN_ID,
  plugin_target: pluginTarget,
  sdk_bundle: sdkBundleTarget,
  sdk_bundle_installed: sdkBundleInstalled,
  warnings,
  enabled_plugins: nextEnabled,
}, null, 2));
