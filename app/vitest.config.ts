import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
    // v21.11: setup.ts ka afterAll har file ke baad `.test-data-*` leak
    // clean karta hai (vitest 4 me globalTeardown option nahi hai)
  },
});
