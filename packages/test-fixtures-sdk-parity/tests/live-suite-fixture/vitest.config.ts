// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

/** Only for live-wire-suite-count.test.ts's child run: the fixture, nothing else. */
export default defineConfig({
  test: { root: import.meta.dirname, include: ["live-suite.fixture.ts"] },
});
