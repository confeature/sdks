// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runWhoami, type WhoamiDeps } from "../src/cli/commands/whoami.ts";
import { type LogoutDeps, runLogout } from "../src/cli/commands/logout.ts";
import type { RunContext } from "../src/cli/commands/registry.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { Io } from "../src/cli/io.ts";
import { ExitCode } from "../src/cli/exit.ts";

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function globals(overrides: Partial<Globals> = {}): Globals {
  return { help: false, version: false, outputJson: false, ...overrides };
}

function ctx(io: Io, overrides: Partial<Globals> = {}): RunContext {
  return { globals: globals(overrides), args: [], io };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── whoami ────────────────────────────────────────────────────────────────

Deno.test("whoami: logged-in path calls /v1/me and prints the identity", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const fetch: WhoamiDeps["fetch"] = (url) => {
    urls.push(url);
    return Promise.resolve(jsonResponse(200, { email: "alice@example.com", fullName: "alice" }));
  };

  const code = await runWhoami(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    readToken: () => Promise.resolve("a-stored-token"),
    clearToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/me"]);
  assertStringIncludes(out.join("\n"), "alice@example.com");
});

Deno.test("whoami: no-token path prints 'not logged in' and makes NO network call", async () => {
  const { io, out } = captureIo();
  let fetchCalled = false;
  const fetch: WhoamiDeps["fetch"] = () => {
    fetchCalled = true;
    return Promise.resolve(jsonResponse(200, {}));
  };

  const code = await runWhoami(ctx(io), {
    fetch,
    readToken: () => Promise.resolve(null),
    clearToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(fetchCalled, false, "the offline path must never touch the network");
  assertStringIncludes(out.join("\n").toLowerCase(), "not logged in");
});

Deno.test("whoami: a 401 reports session expired and clears the stale token", async () => {
  const { io, out } = captureIo();
  const fetch: WhoamiDeps["fetch"] = () =>
    Promise.resolve(jsonResponse(401, { error: "unauthorized", message: "no valid credential" }));

  let cleared: string | null = null;
  const code = await runWhoami(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    readToken: () => Promise.resolve("revoked-token"),
    clearToken: (profile) => {
      cleared = profile;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(cleared, "default", "the stale token must be cleared on 401");
  assertStringIncludes(out.join("\n").toLowerCase(), "session expired");
});

Deno.test("whoami: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const fetch: WhoamiDeps["fetch"] = () =>
    Promise.resolve(jsonResponse(200, { email: "alice@example.com", fullName: "alice" }));

  await runWhoami(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    readToken: () => Promise.resolve("SECRET-BEARER"),
    clearToken: () => Promise.resolve(),
  });

  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── logout ──────────────────────────────────────────────────────────────────

Deno.test("logout: calls cli/logout then clears the local token", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const fetch: LogoutDeps["fetch"] = (url) => {
    urls.push(url);
    return Promise.resolve(jsonResponse(200, { ok: true }));
  };

  let cleared: string | null = null;
  const code = await runLogout(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    readToken: () => Promise.resolve("a-token"),
    clearToken: (profile) => {
      cleared = profile;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/cli/logout"]);
  assertEquals(cleared, "default", "the local token must be cleared after the revoke call");
  assertStringIncludes(out.join("\n"), "Logged out.");
});

Deno.test("logout: clears the local token even when the revoke call fails", async () => {
  const { io, out, err } = captureIo();
  const fetch: LogoutDeps["fetch"] = () => Promise.reject(new TypeError("network down"));

  let cleared = false;
  const code = await runLogout(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    readToken: () => Promise.resolve("a-token"),
    clearToken: () => {
      cleared = true;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(cleared, true, "the local token must be cleared despite a network failure");
  assertStringIncludes(out.join("\n"), "Logged out.");
  assertStringIncludes(err.join("\n").toLowerCase(), "warning");
});

Deno.test("logout: when not logged in, no network call and a clean exit", async () => {
  const { io, out } = captureIo();
  let fetchCalled = false;
  const fetch: LogoutDeps["fetch"] = () => {
    fetchCalled = true;
    return Promise.resolve(jsonResponse(200, {}));
  };

  let clearCalled = false;
  const code = await runLogout(ctx(io), {
    fetch,
    readToken: () => Promise.resolve(null),
    clearToken: () => {
      clearCalled = true;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(fetchCalled, false, "no revoke call when already logged out");
  assertEquals(clearCalled, false);
  assertStringIncludes(out.join("\n").toLowerCase(), "already logged out");
});
