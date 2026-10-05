// SPDX-License-Identifier: MIT

import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

/**
 * Build config for `@confeature/sdk-cloudflare-worker`.
 *
 * Emits ESM only (`dist/index.mjs`). Cloudflare Workers consume ESM
 * natively; CJS and IIFE bundles add bytes for zero practical value
 * (research §R4).
 *
 * `@confeature/sdk-browser-js` is a peer dependency — consumers install
 * it themselves. We don't bundle it: that would defeat the "thin
 * wrapper" structure and inflate the bundle past the < 15 KB gzipped
 * budget (SC-005 / research §R5).
 *
 * Bundle-size budget (SC-005): the gzipped ESM bundle MUST stay below
 * 15 KB. Enforced via `scripts/check-bundle-size.mjs` post-build.
 *
 * The test pool (Vitest under `@cloudflare/vitest-pool-workers`) is
 * configured separately in `vitest.config.ts`.
 */
export default defineConfig({
  pack: {
    // JSDoc stays in the .d.mts only (#800).
    outputOptions: { comments: PUBLISHED_COMMENTS },
    format: ["esm"],
    dts: {
      tsgo: true,
    },
    // sdk-browser-js is a PEER dependency — never bundle it. Consumers
    // install it explicitly so they can dedupe with other Confeature
    // SDKs running in the same Worker. sdk-shared rides along as a
    // transitive dep of sdk-browser-js so it's also kept external.
    deps: {
      neverBundle: ["@confeature/sdk-browser-js", "@confeature/sdk-shared"],
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
