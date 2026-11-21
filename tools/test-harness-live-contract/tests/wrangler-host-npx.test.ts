// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveNpx, WranglerHost, wranglerKvArgv } from "../src/wrangler-host.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

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

it("keeps local fixture KV commands independent of host telemetry and agent settings", async () => {
  vi.stubEnv("WRANGLER_SEND_METRICS", "true");
  vi.stubEnv("WRANGLER_SEND_ERROR_REPORTS", "true");
  vi.stubEnv("WRANGLER_HIDE_BANNER", "false");
  vi.stubEnv("npm_config_offline", "false");
  vi.stubEnv("npm_config_registry", "https://registry.example.invalid/");
  vi.stubEnv("npm_registry", "https://registry.example.invalid/");
  vi.stubEnv("npm_config", "host-config-file");
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic-never-forwarded");
  const localKv = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(localKv as unknown as ReturnType<typeof spawn>);
  const host = new WranglerHost({ scriptPath: "unused", configPath: "/unused/wrangler.toml" });
  const internals = host as unknown as { persistDir: string; npxPath: string };
  internals.persistDir = "/unused/kv";
  internals.npxPath = "/unused/npx";
  queueMicrotask(() => {
    localKv.stdout.end("[]");
    localKv.emit("close", 0);
  });
  try {
    await expect(host.clear()).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env).toMatchObject({
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_HIDE_BANNER: "true",
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:1/",
      npm_registry: "http://127.0.0.1:1/",
      npm_config: join("/unused/kv", "local-npm.rc"),
    });
    expect(options?.env).not.toHaveProperty("CLAUDECODE");
    expect(options?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  } finally {
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockClear();
  }
});
