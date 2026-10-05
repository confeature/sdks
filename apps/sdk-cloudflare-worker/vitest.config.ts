// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

/**
 * Test config for `@confeature/sdk-cloudflare-worker`.
 *
 * Runs the suite under Vitest's default Node pool with an in-memory
 * `KVNamespace` mock rather than under `@cloudflare/vitest-pool-workers`.
 *
 * Why not workerd? — `@confeature/sdk-browser-js` is a thin wrapper
 * around `configcat-js`, which uses `WeakRef` for its per-key client
 * singleton table. Cloudflare's workerd runtime intentionally does
 * NOT expose `WeakRef` / `FinalizationRegistry` (they leak GC timing
 * to user code), so loading sdk-browser-js inside the workers pool
 * unconditionally throws `ReferenceError: WeakRef is not defined`
 * before any assertion runs.
 *
 * `workersKvCache` only depends on the `KVNamespace` interface shape
 * (`get(key, "text")` + `put(key, value, { expirationTtl })`), not on
 * the workerd runtime itself, so an in-memory mock that implements
 * those two methods is byte-for-byte equivalent for the adapter logic
 * we're testing. End-to-end Worker integration is covered out-of-band
 * via the README example deployed against real KV.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/version.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
});
