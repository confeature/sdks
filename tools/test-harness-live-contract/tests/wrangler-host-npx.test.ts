// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { resolveNpx } from "../src/wrangler-host.js";

/**
 * #340 — supply-chain hardening. The harness must resolve `npx` to an
 * absolute path at startup (never spawn the bare command) and fail fast
 * when it can't.
 */
describe("resolveNpx (#340)", () => {
  it("resolves npx to an absolute path on the real PATH", () => {
    const p = resolveNpx();
    expect(p).toMatch(/npx(\.cmd|\.exe)?$/);
    // absolute (POSIX or Windows drive path)
    expect(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)).toBe(true);
  });

  it("throws a clear error when PATH is empty (resolution failure path)", () => {
    expect(() => resolveNpx({ PATH: "" } as NodeJS.ProcessEnv)).toThrow(/could not resolve `npx`/);
  });

  it("throws when PATH is absent entirely", () => {
    expect(() => resolveNpx({} as NodeJS.ProcessEnv)).toThrow(/could not resolve `npx`/);
  });
});
