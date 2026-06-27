import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 独立于主 vite.config（不加载 inferenceProxy 插件/server 依赖），跑纯逻辑单测。
// 引擎重构（Stage B/C/F）前的安全网：domain/几何/账本等纯函数在此积累覆盖。
export default defineConfig({
  resolve: {
    alias: {
      'ink-surface-sdk': path.resolve(import.meta.dirname, 'packages/ink-surface-sdk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/ink-surface-sdk/src/**/*.test.ts'],
  },
});
