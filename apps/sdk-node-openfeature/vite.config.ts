// SPDX-License-Identifier: MIT

import { defineConfig } from "vite-plus";

import { PUBLISHED_COMMENTS } from "../../tools/sdk-pack/comments.mjs";

export default defineConfig({
  pack: {
    target: "node20",
    deps: {
      neverBundle: ["@confeature/sdk-node", "@openfeature/server-sdk"],
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
