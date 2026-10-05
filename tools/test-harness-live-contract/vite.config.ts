// SPDX-License-Identifier: MIT
import { defineConfig } from "vite-plus";

/**
 * Format config for @confeature/test-harness-live-contract.
 *
 * The TEST config lives in `vitest.config.ts`, which vitest reads in
 * preference to this file — a `test:` block here is silently ignored (it was,
 * until #783 found it by bounding the pool here and measuring no effect).
 */
export default defineConfig({
  fmt: {},
});
