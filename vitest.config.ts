import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'providers/*/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
