import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the crx plugin there rewrites the
// manifest and would try to build the extension. Tests only need TS + node.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
