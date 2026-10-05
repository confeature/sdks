import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

/**
 * Build config for @confeature/sdk-browser-js.
 *
 * Emits three formats so the SDK ships through every adoption path:
 *  - ESM (`dist/index.mjs`) for modern bundlers (Vite/Webpack/Rollup).
 *  - CJS (`dist/index.cjs`) for legacy CJS consumers (e.g. Jest).
 *  - IIFE (`dist/confeature.iife.js`) for `<script>` tag adoption — the
 *    bundle attaches a single `Confeature` global carrying every public
 *    export (per FR-024 / SC-002 / research.md §R3).
 *
 * Everything (including `@confeature/sdk-shared`) is bundled — the
 * browser consumer should not re-resolve workspace dependencies.
 *
 * Bundle-size budget (SC-002): its single home is `scripts/check-bundle-size.mjs`.
 * Enforced via `scripts/check-bundle-size.mjs` post-build.
 */
export default defineConfig({
  pack: {
    // JSDoc stays in the .d.mts only (#800).
    outputOptions: { comments: PUBLISHED_COMMENTS },
    format: ["esm", "cjs", "iife"],
    globalName: "Confeature",
    dts: {
      tsgo: true,
    },
    // Bundle the shared workspace package — browser consumers should
    // not have to resolve `@confeature/sdk-shared` at install time. The
    // IIFE bundle in particular must be self-contained for direct
    // `<script>` usage (FR-024).
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
