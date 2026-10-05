import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

/**
 * Build config for @confeature/sdk-bun.
 *
 * Emits ESM only (`dist/index.mjs`) — Bun consumes ESM natively; CJS
 * and IIFE bundles add bytes for zero practical value (research §R3).
 *
 * Everything (including `@confeature/sdk-shared`) is bundled — the
 * Bun consumer should not re-resolve workspace dependencies at install
 * time.
 *
 * Bundle-size budget (SC-002): its single home is `scripts/check-bundle-size.mjs`.
 * Enforced via `scripts/check-bundle-size.mjs` post-build.
 */
export default defineConfig({
  pack: {
    // JSDoc stays in the .d.mts only (#800).
    outputOptions: { comments: PUBLISHED_COMMENTS },
    format: ["esm"],
    dts: {
      tsgo: true,
    },
    // Bundle the shared workspace package — Bun consumers should not
    // have to resolve `@confeature/sdk-shared` at install time.
    deps: {
      alwaysBundle: ["@confeature/sdk-shared"],
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
