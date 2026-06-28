import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'src/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
