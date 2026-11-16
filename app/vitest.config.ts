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
    // timeout then cascades through shared-mock tests.
    // 30s — the global-risk / feed suites perform real network reads with
    // 8s deadlines; on a slow or dark WAN the old 15s budget expired and
    // the NEXT assertions in the same file failed from stale state (the
    // files pass when rerun with 30s). Still short enough to catch a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // v21.11: setup.ts ka afterAll har file ke baad `.test-data-*` leak
    // clean karta hai (vitest 4 me globalTeardown option nahi hai)
  },
});
