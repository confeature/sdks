// SPDX-License-Identifier: MIT

/**
 * `startHarness()` names its upstream explicitly (#858). The harness used to
 * depend on the private CDN Worker; with that dependency gone, a config that
 * forgets `cdnEntry` must fail loudly and by type, never boot whatever the
 * wrangler.toml's `main` happens to point at. No harness boot.
 */

import { describe, expect, it } from "vitest";
import { HarnessConfigError, referenceOrigin, startHarness } from "../src/index.js";
import type { HarnessConfig } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

async function rejection(config: Partial<HarnessConfig>): Promise<unknown> {
  return startHarness(config as HarnessConfig).then(
    (handle) => {
      void handle.stop();
      return "booted";
    },
    (err: unknown) => err,
  );
}

describe("startHarness — the upstream is required", () => {
  for (const [name, config] of [
    ["a missing", { cdnConfigPath }],
    ["an empty", { cdnEntry: "", cdnConfigPath }],
  ] as const) {
    it(`refuses ${name} cdnEntry with a HarnessConfigError naming the field`, async () => {
      const err = await rejection(config);
      expect(err).toBeInstanceOf(HarnessConfigError);
      expect((err as HarnessConfigError).field).toBe("cdnEntry");
    });
  }

  for (const [name, config] of [
    ["a missing", { cdnEntry }],
    ["an empty", { cdnEntry, cdnConfigPath: "" }],
  ] as const) {
    it(`refuses ${name} cdnConfigPath the same way`, async () => {
      const err = await rejection(config);
      expect(err).toBeInstanceOf(HarnessConfigError);
      expect((err as HarnessConfigError).field).toBe("cdnConfigPath");
    });
  }
});
