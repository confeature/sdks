// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { resolveNpx, wranglerKvArgv } from "../src/wrangler-host.js";

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

/**
 * #918 (plan 867 security note): the harness runs inside SDK containers from a
 * `pnpm deploy` of this package, so `npx` must never fetch a wrangler of its
 * own from the registry when the deployed one is missing — it must fail.
 */
describe("wranglerKvArgv (#918)", () => {
  it("never lets npx install: --no-install comes before the package name", () => {
    const argv = wranglerKvArgv(["bulk", "put", "/p/f.json"], ["--namespace-id=CONFIG_KV"], "/p");
    expect(argv).toEqual([
      "--no-install",
      "wrangler",
      "kv",
      "bulk",
      "put",
      "/p/f.json",
      "--namespace-id=CONFIG_KV",
      "--local",
      "--persist-to=/p",
    ]);
  });
});
