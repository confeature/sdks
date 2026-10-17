// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

/**
 * Test config for @confeature/test-harness-live-contract — the one vitest
 * reads (it takes precedence over `vite.config.ts`).
 *
 * `forks` so each Miniflare boot gets its own Node process and can use V8
 * isolates cleanly. Tests keep 30 s. Hooks get 120 s because a `beforeAll`
 * boot is where the COLD boot lands: in the Dagger container, the first boot
 * in each fork (esbuild bundling the upstream Worker from scratch) ran past 30 s on every
 * run, main included, while the same boot through the `--exec` wrapper, which
 * has no deadline, succeeded. The warm-boot budget (SC-001, 3 s) is
 * `boot.smoke`'s to assert, not this ceiling's.
 *
 * `maxWorkers: 2` (#783 review): unbounded, every file that boots Miniflare
 * boots it at once. In the Dagger container that queued workerd instances past
 * the 30 s timeouts — 7 of 138 red on main too — so `liveContract` (now
 * `harness-live-test`) never reached its SDK stage. Same cause as #772's Workers pool, but unconditional:
 * Dagger sets CI=true, and the container is exactly where it hurts.
 */
export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 120000,
    include: ["tests/**/*.test.ts"],
  },
});
