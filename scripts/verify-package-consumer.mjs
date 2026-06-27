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
    if (typeof sdk.renderInkLoopVisualModel !== 'function') throw new Error('missing renderer export');
    if (typeof sdk.installInkLoopSurfaceStyles !== 'function') throw new Error('missing style export');
  `;
  run('node', ['--input-type=module', '-e', esmProbe], { cwd: consumerDir });

  writeFileSync(path.join(consumerDir, 'index.ts'), [
    "import { parseInkLoopVisualModel, type InkLoopVisualModel } from 'ink-surface-sdk';",
    "const model: InkLoopVisualModel | null = parseInkLoopVisualModel('# Plain markdown');",
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
    'dist/obsidian-plugin/inkloop-sync/main.js',
    'dist/obsidian-plugin/inkloop-sync/manifest.json',
    'dist/obsidian-plugin/inkloop-sync/styles.css',
    'dist/obsidian-plugin/inkloop-sync/inkloop-surface-sdk.iife.js',
    'plugins/obsidian/inkloop-sync/main.js',
    'scripts/install-obsidian-plugin.mjs',
  ]) {
    if (!packedFiles.has(required)) throw new Error(`packed SDK is missing ${required}`);
  }
  for (const forbidden of ['src/index.test.ts', 'examples/ai-annotation-demo/package.json']) {
    if (packedFiles.has(forbidden)) throw new Error(`packed SDK should not include ${forbidden}`);
  }

  console.log(`consumer verification passed for ${filename}`);
} finally {
  if (process.env.INK_SURFACE_KEEP_CONSUMER_TMP !== '1') rmSync(tempRoot, { recursive: true, force: true });
}
