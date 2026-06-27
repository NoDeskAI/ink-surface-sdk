import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PLUGIN_ID = 'inkloop-sync';

const pluginSource = path.join(PACKAGE_ROOT, 'plugins', 'obsidian', PLUGIN_ID);
const pluginTarget = path.join(PACKAGE_ROOT, 'dist', 'obsidian-plugin', PLUGIN_ID);
const sdkBundleSource = path.join(PACKAGE_ROOT, 'dist', 'inkloop-surface-sdk.iife.js');
const sdkBundleTarget = path.join(pluginTarget, 'inkloop-surface-sdk.iife.js');

await rm(pluginTarget, { recursive: true, force: true });
await mkdir(path.dirname(pluginTarget), { recursive: true });
await cp(pluginSource, pluginTarget, { recursive: true, force: true });
await cp(sdkBundleSource, sdkBundleTarget, { force: true });

console.log(`built Obsidian plugin package at ${path.relative(PACKAGE_ROOT, pluginTarget)}`);
