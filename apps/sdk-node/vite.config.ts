import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

export default defineConfig({
  pack: {
    // JSDoc stays in the .d.mts only (#800).
    outputOptions: { comments: PUBLISHED_COMMENTS },
    // Scope the build program to `src/` only so test files, and any
    // cross-package source they import, never enter tsdown's tsgo program
    // and emit stray .d.ts files next to the source. See issue #103.
    tsconfig: "./tsconfig.build.json",
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
