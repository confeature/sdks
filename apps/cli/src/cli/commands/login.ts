// SPDX-License-Identifier: MIT

import { ExitCode } from "../exit.ts";
import type { Io } from "../io.ts";
import type { Leaf, RunContext } from "./registry.ts";
import { writeToken } from "../../auth/credentials.ts";
import { resolveConfig } from "../../config/resolve.ts";
import { ApiClient, type FetchLike } from "../../api/client.ts";
import { type BrowserOpener, openBrowser } from "../browser.ts";

/**
 * `login` — browser device-flow login (spec 180 / #654, RFC 8628).
 *
 * Flow:
 *   1. POST /v1/cli/device/authorize → print the verification URL + user code
 *      and attempt to open the browser (best-effort; the printed URL is the
 *      fallback — a failed opener NEVER crashes login).
 *   2. Poll POST /v1/cli/device/token honouring `interval`, backing off on
 *      `slow_down`, until a terminal state:
 *        - approved   → store the token (0600) + print "Logged in as …".
 *        - access_denied / expired_token → a distinct message, exit non-zero,
 *          NO token stored.
 *
 * SECURITY: the access_token, device_code, and user_code are never logged. The
 * token reaches disk only through the cred store's single 0600 write.
 */

/** RFC 8628 device-authorization response (`device/authorize` 200). */
interface AuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

/** `device/token` 200 (approved) body. */
interface TokenSuccess {
  access_token: string;
  token_type: string;
  identity: { user: string; org: string };
}

/** `device/token` 400 (RFC 8628) error body. */
interface TokenError {
  error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied";
}

/** Injectable seams so the test drives the orchestration without I/O. */
export interface LoginDeps {
  fetch?: FetchLike;
  openBrowser?: BrowserOpener;
  /** Sleep `ms` between polls — stubbed to resolve instantly in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Persist the token (defaults to the cred store). */
  writeToken?: (profile: string, token: string) => Promise<void>;
  /** Wall-clock now (ms) — injectable so the expiry guard is testable. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Floor an `interval` (seconds) to a sane minimum so a bad value can't busy-loop. */
function intervalMs(seconds: number): number {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
  return Math.max(1, Math.floor(safe)) * 1000;
}

/**
 * The testable core: resolve config, authorize, poll, store. Returns the exit
 * code (OK on success, AUTH on a denied/expired flow). All side effects flow
 * through {@link LoginDeps} so the test injects a stub fetch + opener + sleep.
 */
export async function runLogin(ctx: RunContext, deps: LoginDeps = {}): Promise<ExitCode> {
  const config = await resolveConfig(ctx.globals);
  const fetchImpl = deps.fetch;
  const opener = deps.openBrowser ?? openBrowser;
  const sleep = deps.sleep ?? defaultSleep;
  const persist = deps.writeToken ?? writeToken;
  const now = deps.now ?? Date.now;

  const client = new ApiClient({ baseUrl: config.apiUrl, fetch: fetchImpl });

  // 1. Authorize.
  const authorize = await client.json<AuthorizeResponse>("/v1/cli/device/authorize", {
    method: "POST",
    body: JSON.stringify({ label: hostLabel() }),
  });

  printVerification(ctx.io, authorize);
  // Best-effort browser open — the printed URL is the guaranteed fallback.
  await tryOpenBrowser(ctx.io, opener, authorize.verification_uri_complete);

  // 2. Poll until terminal.
  const deadline = now() + Math.max(0, authorize.expires_in) * 1000;
  let waitMs = intervalMs(authorize.interval);

  while (true) {
    if (now() >= deadline) {
      ctx.io.err(
        "Login timed out — the code expired before it was approved. Run `confeature login` again.",
      );
      return ExitCode.AUTH;
    }
    await sleep(waitMs);

    const res = await client.request<TokenSuccess | TokenError>("/v1/cli/device/token", {
      method: "POST",
      body: JSON.stringify({ device_code: authorize.device_code }),
    });

    if (res.ok) {
      const success = res.body as TokenSuccess;
      await persist(config.profile, success.access_token);
      printLoggedIn(ctx.io, config.outputJson, config.profile, success.identity);
      return ExitCode.OK;
    }

    // The rate-limit IS the slow-down signal: the server enforces the poll
    // cadence by returning HTTP 429 (it never emits an RFC 8628 `slow_down`
    // error body). Treat a 429 EXACTLY like `slow_down` — back off by 5s and
    // retry, bounded by the deadline guard.
    if (res.status === 429) {
      waitMs += 5000;
      continue;
    }

    const error = (res.body as TokenError)?.error;
    switch (error) {
      case "authorization_pending":
        // Keep the current interval; wait again.
        break;
      case "slow_down":
        // RFC 8628: back off by 5s on each slow_down (kept for protocol
        // completeness — the schema retains the case even though the current
        // server signals back-off via 429 instead).
        waitMs += 5000;
        break;
      case "access_denied":
        ctx.io.err("Login was denied in the browser. No token was stored.");
        return ExitCode.AUTH;
      case "expired_token":
        ctx.io.err("Login expired before it was approved. Run `confeature login` again.");
        return ExitCode.AUTH;
      default:
        // Any other unexpected non-OK shape — back off and retry; the deadline
        // guard bounds the loop.
        waitMs += 5000;
        break;
    }
  }
}

/** A short host label for the dashboard token list (never an auth input). */
function hostLabel(): string {
  try {
    return Deno.hostname();
  } catch {
    // No `--allow-sys` / hostname unavailable — a generic label is fine.
    return "CLI";
  }
}

function printVerification(io: Io, authorize: AuthorizeResponse): void {
  io.out(
    `To authorize, visit ${authorize.verification_uri_complete}\n` +
      `and confirm the code: ${authorize.user_code}`,
  );
}

async function tryOpenBrowser(io: Io, opener: BrowserOpener, url: string): Promise<void> {
  const opened = await opener(url);
  if (opened) {
    io.out("(opening your browser…)");
  } else {
    io.out("(open the URL above in your browser to continue)");
  }
}

function printLoggedIn(
  io: Io,
  outputJson: boolean,
  profile: string,
  identity: { user: string; org: string },
): void {
  if (outputJson) {
    io.out(JSON.stringify({ loggedIn: true, profile, user: identity.user, org: identity.org }));
  } else {
    io.out(`Logged in as ${identity.user} (org: ${identity.org}).`);
  }
}

export const loginCommand: Leaf = {
  name: "login",
  summary: "Authenticate this machine via the browser (device flow).",
  run: (ctx) => runLogin(ctx),
};
