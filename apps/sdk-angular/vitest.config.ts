// SPDX-License-Identifier: MIT

/**
 * Vitest configuration for `@confeature/sdk-angular`.
 *
 * Bridges Angular's `TestBed` into Vitest via `@analogjs/vitest-angular`'s
 * `angular()` plugin (research §R2). The plugin runs the Angular
 * compiler's partial-ivy emit over the package's `src/` + `tests/`,
 * which is what makes `@Injectable` / `@Directive` / `@Pipe`
 * decorators executable under Vitest's worker pool.
 *
 * `jsdom` is the canonical environment for TestBed under Vitest —
 * happy-dom misses a couple of DOM APIs that Angular's
 * platform-browser-dynamic test bootstrap depends on (notably the
 * `customElements` registry behaviour).
 */

import angular from "@analogjs/vite-plugin-angular";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [angular()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test-setup.ts"],
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/version.ts"],
      thresholds: {
        lines: 80,
      },
    },
  },
  // The Angular compiler emits decorator metadata via Reflect.metadata.
  // Define the constant Angular emits + ensure tslib is resolvable.
  define: {
    "import.meta.vitest": "undefined",
  },
});
