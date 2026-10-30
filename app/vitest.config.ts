import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
    // v21.28.0 [GATE-STABILITY]: the 254-file sequential run can stall a
    // single fast suite past the 5s default (disk/AV/Ollama I/O spikes); a
    // timeout then cascades through shared-mock tests. 15s keeps the gate
    // deterministic without masking a genuine hang (none run anywhere near).
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // v21.11: setup.ts ka afterAll har file ke baad `.test-data-*` leak
    // clean karta hai (vitest 4 me globalTeardown option nahi hai)
  },
});
