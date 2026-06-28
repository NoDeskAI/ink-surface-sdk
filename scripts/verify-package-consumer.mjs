import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(tmpdir(), 'ink-surface-sdk-consumer-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });
}

function parseNpmPackJson(output) {
  const start = output.lastIndexOf('\n[');
  return JSON.parse(output.slice(start === -1 ? output.indexOf('[') : start + 1).trim());
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  const packOutput = run('npm', ['pack', '--pack-destination', packDir, '--json']);
  const [{ filename }] = parseNpmPackJson(packOutput);
  const tarball = path.join(packDir, filename);

  run('npm', ['init', '-y'], { cwd: consumerDir });
  run('npm', ['install', tarball], { cwd: consumerDir });

  const esmProbe = `
    import * as sdk from 'ink-surface-sdk';
    import * as offlineStore from 'ink-surface-sdk/offline-store';
    import * as fileSidecar from 'ink-surface-sdk/offline-store/file-sidecar';
    import * as indexeddbStore from 'ink-surface-sdk/offline-store/indexeddb';
    import * as runtimeSchema from 'ink-surface-sdk/runtime-schema';
    import * as syncClient from 'ink-surface-sdk/sync-client';
    if (typeof sdk.renderInkLoopVisualModel !== 'function') throw new Error('missing renderer export');
    if (typeof sdk.installInkLoopSurfaceStyles !== 'function') throw new Error('missing style export');
    if (typeof offlineStore.resolveOfflineOpenState !== 'function') throw new Error('missing offline-store export');
    if (typeof fileSidecar.SidecarRuntimeStore !== 'function') throw new Error('missing file-sidecar export');
    if (typeof indexeddbStore.IndexedDbOfflineRuntimeStore !== 'function') throw new Error('missing indexeddb export');
    if (typeof runtimeSchema.validateRuntimeSyncEvent !== 'function') throw new Error('missing runtime-schema export');
    if (typeof syncClient.RuntimeSyncRunner !== 'function') throw new Error('missing sync-client export');
  `;
  run('node', ['--input-type=module', '-e', esmProbe], { cwd: consumerDir });

  writeFileSync(path.join(consumerDir, 'index.ts'), [
    "import { parseInkLoopVisualModel, type InkLoopVisualModel } from 'ink-surface-sdk';",
    "import { resolveOfflineOpenState, type OfflineDocumentCacheRecord } from 'ink-surface-sdk/offline-store';",
    "import { RuntimeSyncRunner, type RuntimeSyncTransportPort } from 'ink-surface-sdk/sync-client';",
    "import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';",
    "const model: InkLoopVisualModel | null = parseInkLoopVisualModel('# Plain markdown');",
    "const record: OfflineDocumentCacheRecord | null = null;",
    "const openState = resolveOfflineOpenState(record, 'inkloop.runtime_sync_event.v1');",
    "const event: RuntimeSyncEvent | null = null;",
    "const transport: RuntimeSyncTransportPort | null = null;",
    "void RuntimeSyncRunner;",
    "void transport;",
    "void event;",
    "void openState;",
    "console.log(model?.documentTitle);",
    '',
  ].join('\n'));
  writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ['index.ts'],
  }, null, 2));

  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  run(tsc, ['-p', path.join(consumerDir, 'tsconfig.json'), '--pretty', 'false']);

  const packed = parseNpmPackJson(run('npm', ['pack', '--dry-run', '--json']))[0];
  const packedFiles = new Set(packed.files.map((file) => file.path));
  for (const required of [
    'dist/index.d.ts',
    'dist/inkloop-surface-sdk.es.js',
    'dist/inkloop-surface-sdk.iife.js',
    'dist/packages/adapter-contracts/src/index.d.ts',
    'dist/packages/adapter-contracts/src/index.js',
    'dist/packages/native-bridge/src/index.d.ts',
    'dist/packages/native-bridge/src/index.js',
    'dist/packages/offline-store/src/file-sidecar-store.d.ts',
    'dist/packages/offline-store/src/file-sidecar-store.js',
    'dist/packages/offline-store/src/index.d.ts',
    'dist/packages/offline-store/src/index.js',
    'dist/packages/offline-store/src/indexeddb-store.d.ts',
    'dist/packages/offline-store/src/indexeddb-store.js',
    'dist/packages/runtime-schema/src/index.d.ts',
    'dist/packages/runtime-schema/src/index.js',
    'dist/packages/surface-model/src/index.d.ts',
    'dist/packages/surface-model/src/index.js',
    'dist/packages/surface-web/src/index.d.ts',
    'dist/packages/surface-web/src/index.js',
    'dist/packages/sync-client/src/index.d.ts',
    'dist/packages/sync-client/src/index.js',
    'dist/obsidian-plugin/inkloop-sync/main.js',
    'dist/obsidian-plugin/inkloop-sync/manifest.json',
    'dist/obsidian-plugin/inkloop-sync/styles.css',
    'dist/obsidian-plugin/inkloop-sync/inkloop-surface-sdk.iife.js',
    'apps/sync-api/README.md',
    'apps/sync-api/contracts/runtime-sync-api.md',
    'apps/sync-api/contracts/security-and-privacy.md',
    'apps/sync-api/contracts/runtime-sync-api.test-fixtures.jsonl',
    'docs/cross-platform-offline-runtime.md',
    'docs/platform-renderer-strategy.md',
    'packages/adapter-contracts/package.json',
    'packages/adapter-contracts/src/index.ts',
    'packages/native-bridge/package.json',
    'packages/native-bridge/src/index.ts',
    'packages/native-bridge/src/webview-host.md',
    'packages/native-bridge/src/offline-state-matrix.md',
    'packages/offline-store/package.json',
    'packages/offline-store/src/index.ts',
    'packages/offline-store/src/file-sidecar-store.ts',
    'packages/offline-store/src/indexeddb-store.ts',
    'packages/runtime-schema/package.json',
    'packages/runtime-schema/src/index.ts',
    'packages/runtime-schema/src/schema-versioning.md',
    'packages/runtime-schema/src/fixtures/runtime-sync-event.json',
    'packages/surface-model/package.json',
    'packages/surface-model/src/index.ts',
    'packages/sync-client/package.json',
    'packages/sync-client/src/index.ts',
    'packages/surface-web/package.json',
    'packages/surface-web/src/index.ts',
    'plugins/obsidian/inkloop-sync/main.js',
    'native/ios/README.md',
    'native/android/README.md',
    'scripts/finalize-types.mjs',
    'scripts/install-obsidian-plugin.mjs',
    'tsconfig.packages.json',
  ]) {
    if (!packedFiles.has(required)) throw new Error(`packed SDK is missing ${required}`);
  }
  for (const forbidden of ['apps/sync-api/src/runtime-sync-contract.test.ts', 'src/index.test.ts', 'packages/adapter-contracts/src/adapter-authority.test.ts', 'packages/native-bridge/src/native-bridge.test.ts', 'packages/offline-store/src/offline-store.test.ts', 'packages/offline-store/src/file-sidecar-store.test.ts', 'packages/offline-store/src/indexeddb-store.test.ts', 'packages/runtime-schema/src/runtime-schema.test.ts', 'packages/surface-model/src/index.test.ts', 'packages/sync-client/src/sync-client.test.ts', 'packages/surface-web/src/index.test.ts', 'examples/ai-annotation-demo/package.json']) {
    if (packedFiles.has(forbidden)) throw new Error(`packed SDK should not include ${forbidden}`);
  }

  console.log(`consumer verification passed for ${filename}`);
} finally {
  if (process.env.INK_SURFACE_KEEP_CONSUMER_TMP !== '1') rmSync(tempRoot, { recursive: true, force: true });
}
