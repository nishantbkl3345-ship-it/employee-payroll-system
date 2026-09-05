import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Keep the suite output readable; the app's structured logs are exercised
    // through the /api/jobs/:id/logs assertions instead of stdout.
    env: { LOG_LEVEL: 'silent', LOG_PRETTY: 'false', ROW_PROCESSING_DELAY_MS: '0' },
  },
});
