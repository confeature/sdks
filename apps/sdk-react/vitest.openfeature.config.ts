// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    testTimeout: 15_000,
    environmentOptions: { happyDOM: { url: process.env.LIVE_HARNESS_URL } },
    include: ["tests/openfeature.live.tsx"],
  },
});
