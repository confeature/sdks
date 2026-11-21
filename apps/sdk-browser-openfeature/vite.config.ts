// SPDX-License-Identifier: MIT

import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

export default defineConfig({
  pack: {
    target: "es2022",
    deps: {
      neverBundle: ["@confeature/sdk-browser-js", "@openfeature/web-sdk"],
    },
    outputOptions: { comments: PUBLISHED_COMMENTS },
    tsconfig: "./tsconfig.build.json",
    dts: { tsgo: true },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
