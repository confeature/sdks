import { defineConfig } from "vite-plus";

/**
 * Build config for @confeature/sdk-shared.
 *
 * ESM-only — every consumer of this package is an SDK package
 * (apps/sdk-*) which produces its own multi-format build. Keeping
 * sdk-shared ESM keeps tree-shaking honest (`sideEffects: false` in
 * package.json) and the dist directory minimal.
 */
export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
