import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], environment: 'node', testTimeout: 30000, pool: 'forks', env: { HIVELANE_LANG: 'ko' } },
});
