import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone config (does not merge vite.config.ts): node-environment unit tests
// need the path aliases but not the svelte plugin or dev-server middleware.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': r('./src/engine'),
      '@ai': r('./src/ai'),
      '@protocol': r('./src/protocol'),
      '@storage': r('./src/storage'),
      '@ui': r('./src/ui'),
      '@vendor': r('./vendor'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/data/**/*.test.ts',
      'tests/protocol/**/*.test.ts',
      'tests/storage/**/*.test.ts',
      'tests/determinism/**/*.test.ts',
      'tests/balance/**/*.test.ts',
    ],
    // The sandbox has 2 CPUs; keep contention low.
    maxWorkers: 2,
  },
});
