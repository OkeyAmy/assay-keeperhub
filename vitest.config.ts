import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The reconciler is the product. It does not get to be partially tested.
      thresholds: {
        'packages/core/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
