import { defineConfig } from 'vitest/config';

// Only this patch's two leaves. No upstream global fixture, browser, local
// services, real analytics, migrations, or externally configured connections.
export default defineConfig({
  test: {
    include: ['galaxy-account-scope/checks/account-scope.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    env: { SELF_HOSTED: 'true' },
  },
});
