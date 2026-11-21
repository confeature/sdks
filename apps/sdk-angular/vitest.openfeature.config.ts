// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

import suite from "./vitest.config.js";

export default defineConfig({
  ...suite,
  test: { ...suite.test, include: ["tests/openfeature.live.ts"], testTimeout: 15_000 },
});
