import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

/**
 * Build config for @confeature/sdk-react.
 *
 * Emits ESM only (`dist/index.mjs`) — React consumers always use modern
 * bundlers; CJS / IIFE add bytes for zero practical value. NO `engines`
 * field at the package level either: React SDKs run wherever React runs
 * (browser DOM, Node SSR, edge workers) (research §R9).
 *
 * @confeature/sdk-browser-js is bundled via `alwaysBundle` so React
 * consumers install only `@confeature/sdk-react`. React + react-dom are
 * peer deps and are externalised (NOT bundled) — bundling React causes
 * the classic "Invalid Hook Call" footgun when the consumer also has
 * its own copy.
 *
 * Bundle-size budgets (SC-002 + SC-002b):
 *  - the total ESM bundle and the React layer alone (total − the measured
 *    sdk-browser-js bundle) — their numbers live in one place,
 *    `scripts/check-bundle-size.mjs`.
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
    deps: {
      // Bundle the workspace runtime SDK — React consumers should not
      // have to resolve `@confeature/sdk-browser-js` (or, transitively,
      // `@confeature/sdk-shared`) at install time.
      alwaysBundle: ["@confeature/sdk-browser-js", "@confeature/sdk-shared"],
      // React + react-dom stay external automatically because they are
      // declared in `peerDependencies` (vite-plus externalises peer-
      // dep packages by default). Bundling React would cause the
      // classic "Invalid Hook Call" duplicate-React footgun.
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    environment: "happy-dom",
  },
});
