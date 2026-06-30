import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(import.meta.dirname, '../..');

// 独立于主 vite.config（不加载 inferenceProxy 插件/server 依赖），跑纯逻辑单测。
// 引擎重构（Stage B/C/F）前的安全网：domain/几何/账本等纯函数在此积累覆盖。
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      'ink-surface-sdk': path.resolve(import.meta.dirname, '../../src/index.ts'),
      '@inksurface/knowledge-schema': path.resolve(import.meta.dirname, '../../packages/knowledge-schema/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['examples/ai-annotation-demo/src/**/*.test.ts'],
  },
});
