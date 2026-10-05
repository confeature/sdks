// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { type LoginDeps, runLogin } from "../src/cli/commands/login.ts";
import type { RunContext } from "../src/cli/commands/registry.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { Io } from "../src/cli/io.ts";
import { ExitCode } from "../src/cli/exit.ts";

/** Capture stdout/stderr lines. */
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

/** A JSON `Response` for the stub fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const AUTHORIZE_BODY = {
  device_code: "secret-device-code",
  user_code: "WDJB-MJHT",
  verification_uri: "https://app.example/cli",
  verification_uri_complete: "https://app.example/cli?user_code=WDJB-MJHT",
  interval: 5,
  expires_in: 600,
};

/**
 * Build a stub fetch that returns the authorize body once, then walks the
 * supplied poll outcomes (one per /device/token call). Records every URL hit.
 */
function stubFetch(pollResponses: Response[]): {
  fetch: LoginDeps["fetch"];
  urls: string[];
} {
  const urls: string[] = [];
  let pollIndex = 0;
  const fetch: LoginDeps["fetch"] = (url) => {
    urls.push(url);
    if (url.endsWith("/v1/cli/device/authorize")) {
      return Promise.resolve(jsonResponse(200, AUTHORIZE_BODY));
    }
    if (url.endsWith("/v1/cli/device/token")) {
      const res = pollResponses[pollIndex] ?? jsonResponse(400, { error: "authorization_pending" });
      pollIndex += 1;
      return Promise.resolve(res);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetch, urls };
}

/** A no-op opener that records whether it was invoked (never spawns a browser). */
function fakeOpener(): { open: LoginDeps["openBrowser"]; calls: string[] } {
  const calls: string[] = [];
  return {
    open: (url) => {
      calls.push(url);
      return Promise.resolve(true);
    },
    calls,
  };
}

Deno.test("login: prints the verification URL + user code", async () => {
  const { io, out } = captureIo();
  const { fetch } = stubFetch([jsonResponse(200, {
    access_token: "secret-token",
    token_type: "bearer",
    identity: { user: "alice@example.com", org: "Acme" },
  })]);
  const opener = fakeOpener();

  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: opener.open,
    sleep: () => Promise.resolve(),
    writeToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  const text = out.join("\n");
  assertStringIncludes(text, "https://app.example/cli?user_code=WDJB-MJHT");
  assertStringIncludes(text, "WDJB-MJHT");
  // The opener was attempted with the completion URL — but no real browser spawned.
  assertEquals(opener.calls, ["https://app.example/cli?user_code=WDJB-MJHT"]);
});

Deno.test("login: polls honouring pending then stores the token on success", async () => {
  const { io, out } = captureIo();
  const { fetch, urls } = stubFetch([
    jsonResponse(400, { error: "authorization_pending" }),
    jsonResponse(400, { error: "authorization_pending" }),
    jsonResponse(200, {
      access_token: "secret-token-value",
      token_type: "bearer",
      identity: { user: "alice@example.com", org: "Acme" },
    }),
  ]);
  const opener = fakeOpener();

  let stored: { profile: string; token: string } | null = null;
  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: opener.open,
    sleep: () => Promise.resolve(),
    writeToken: (profile, token) => {
      stored = { profile, token };
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(stored, { profile: "default", token: "secret-token-value" });
  // Three poll calls were made (two pending + one success).
  assertEquals(urls.filter((u) => u.endsWith("/v1/cli/device/token")).length, 3);
  assertStringIncludes(out.join("\n"), "Logged in as alice@example.com (org: Acme)");
});

Deno.test("login: backs off on a 429 rate-limit before succeeding", async () => {
  // The server signals "slow down" by returning HTTP 429 (rate-limit), NOT an
  // RFC 8628 `slow_down` error body. The CLI must treat the 429 as a back-off-
  // and-retry, exactly like slow_down.
  const { io } = captureIo();
  const { fetch } = stubFetch([
    jsonResponse(429, { error: "rate_limited", message: "too many requests" }),
    jsonResponse(200, {
      access_token: "secret",
      token_type: "bearer",
      identity: { user: "bob@example.com", org: "Acme" },
    }),
  ]);

  const sleeps: number[] = [];
  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: () => Promise.resolve(false),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    writeToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  // First poll waited the 5s interval; after the 429 the next wait grew by 5s.
  assertEquals(sleeps[0], 5000);
  assertEquals(sleeps[1], 10000);
});

Deno.test("login: backs off on slow_down before succeeding (protocol completeness)", async () => {
  // The schema retains the RFC 8628 `slow_down` error case; the CLI must still
  // handle it as a back-off even though the current server prefers 429.
  const { io } = captureIo();
  const { fetch } = stubFetch([
    jsonResponse(400, { error: "slow_down" }),
    jsonResponse(200, {
      access_token: "secret",
      token_type: "bearer",
      identity: { user: "bob@example.com", org: "Acme" },
    }),
  ]);

  const sleeps: number[] = [];
  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: () => Promise.resolve(false),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    writeToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  // First poll waited the 5s interval; after slow_down the next wait grew by 5s.
  assertEquals(sleeps[0], 5000);
  assertEquals(sleeps[1], 10000);
});

Deno.test("login: exits AUTH on access_denied without storing a token", async () => {
  const { io, err } = captureIo();
  const { fetch } = stubFetch([jsonResponse(400, { error: "access_denied" })]);

  let storeCalled = false;
  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    writeToken: () => {
      storeCalled = true;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.AUTH);
  assertEquals(storeCalled, false, "no token must be stored on denial");
  assertStringIncludes(err.join("\n").toLowerCase(), "denied");
});

Deno.test("login: exits AUTH on expired_token without storing a token", async () => {
  const { io, err } = captureIo();
  const { fetch } = stubFetch([jsonResponse(400, { error: "expired_token" })]);

  let storeCalled = false;
  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    writeToken: () => {
      storeCalled = true;
      return Promise.resolve();
    },
  });

  assertEquals(code, ExitCode.AUTH);
  assertEquals(storeCalled, false, "no token must be stored on expiry");
  assertStringIncludes(err.join("\n").toLowerCase(), "expired");
});

Deno.test("login: a failed browser opener does not crash login", async () => {
  const { io, out } = captureIo();
  const { fetch } = stubFetch([jsonResponse(200, {
    access_token: "secret",
    token_type: "bearer",
    identity: { user: "alice@example.com", org: "Acme" },
  })]);

  const code = await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    // Opener reports failure — login must fall back to the printed URL.
    openBrowser: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    writeToken: () => Promise.resolve(),
  });

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n"), "open the URL above");
});

Deno.test("login: never logs the access token or device code", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = stubFetch([jsonResponse(200, {
    access_token: "TOP-SECRET-TOKEN",
    token_type: "bearer",
    identity: { user: "alice@example.com", org: "Acme" },
  })]);

  await runLogin(ctx(io, { apiUrl: "https://api.example" }), {
    fetch,
    openBrowser: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    writeToken: () => Promise.resolve(),
  });

  const all = [...out, ...err].join("\n");
  assertEquals(all.includes("TOP-SECRET-TOKEN"), false, "access token must never be printed");
  assertEquals(all.includes("secret-device-code"), false, "device code must never be printed");
});
