// SPDX-License-Identifier: MIT

import { ExitCode } from "../exit.ts";
import type { Leaf, RunContext } from "./registry.ts";
import { clearToken, readToken } from "../../auth/credentials.ts";
import { resolveConfig } from "../../config/resolve.ts";
import { ApiClient, ApiError, type FetchLike } from "../../api/client.ts";

/**
 * `whoami` — report the authenticated identity of the active profile (spec 180
 * / #654, US3).
 *
 *   - No token  → print "not logged in" and exit OK (0), with NO network call
 *     (preserve #653's offline behaviour, FR-007 / C15).
 *   - Token     → call `GET /v1/me` with the bearer and print the identity.
 *   - 401       → the token was revoked/expired server-side; print a clear
 *     "session expired" message, clear the stale local token, and exit OK (0)
 *     — `whoami` reporting logged-out is not itself an error.
 *
 * SECURITY: the token is never logged; it travels only in the Authorization
 * header the client attaches.
 */

/** `GET /v1/me` 200 body (ConfigCat-parity MeModel). */
interface MeModel {
  email: string;
  fullName: string;
}

/** Injectable seam for the whoami test. */
export interface WhoamiDeps {
  fetch?: FetchLike;
  readToken?: (profile: string) => Promise<string | null>;
  clearToken?: (profile: string) => Promise<void>;
}

export async function runWhoami(ctx: RunContext, deps: WhoamiDeps = {}): Promise<ExitCode> {
  const config = await resolveConfig(ctx.globals);
  const read = deps.readToken ?? readToken;
  const clear = deps.clearToken ?? clearToken;

  const token = await read(config.profile);

  // No token: offline path — never touch the network (FR-007 / C15).
  if (token === null) {
    printNotLoggedIn(ctx, config.profile);
    return ExitCode.OK;
  }

  const client = new ApiClient({ baseUrl: config.apiUrl, token, fetch: deps.fetch });
  let me: MeModel;
  try {
    me = await client.json<MeModel>("/v1/me", { method: "GET" });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The token was revoked or expired server-side — drop the stale local
      // secret so the next command starts clean, and report logged-out.
      await clear(config.profile);
      if (config.outputJson) {
        ctx.io.out(
          JSON.stringify({ loggedIn: false, profile: config.profile, sessionExpired: true }),
        );
      } else {
        ctx.io.out(
          `not logged in (session expired) — run \`confeature login\` (profile: ${config.profile})`,
        );
      }
      return ExitCode.OK;
    }
    throw error;
  }

  if (config.outputJson) {
    ctx.io.out(
      JSON.stringify({
        loggedIn: true,
        profile: config.profile,
        user: me.email,
        apiUrl: config.apiUrl,
      }),
    );
  } else {
    ctx.io.out(`logged in as ${me.email} (profile: ${config.profile}, api: ${config.apiUrl})`);
  }
  return ExitCode.OK;
}

function printNotLoggedIn(ctx: RunContext, profile: string): void {
  if (ctx.globals.outputJson) {
    ctx.io.out(JSON.stringify({ loggedIn: false, profile }));
  } else {
    ctx.io.out(`not logged in (profile: ${profile})`);
  }
}

export const whoamiCommand: Leaf = {
  name: "whoami",
  summary: "Show the authenticated identity of the active profile.",
  run: (ctx) => runWhoami(ctx),
};
