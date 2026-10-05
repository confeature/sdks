// SPDX-License-Identifier: MIT

import { ExitCode } from "../exit.ts";
import type { RunContext } from "./registry.ts";
import type { Leaf } from "./registry.ts";
import { clearToken, readToken } from "../../auth/credentials.ts";
import { resolveConfig } from "../../config/resolve.ts";
import { ApiClient, type FetchLike } from "../../api/client.ts";

/**
 * `logout` — revoke the active profile's token server-side, then clear it
 * locally (spec 180 / #654).
 *
 * Best-effort revoke: `POST /v1/cli/logout` (Bearer) sets `revoked_at` on the
 * presenting token; a network failure after we still clear the local store is
 * NOT fatal — the local secret is gone either way, which is the user-visible
 * promise. Logging out while already logged out is a clean no-op (exit 0,
 * idempotent — mirrors the cred store's idempotent `clearToken`).
 *
 * SECURITY: the token is never logged; it travels only in the Authorization
 * header the client attaches.
 */

/** Injectable seam for the logout test. */
export interface LogoutDeps {
  fetch?: FetchLike;
  readToken?: (profile: string) => Promise<string | null>;
  clearToken?: (profile: string) => Promise<void>;
}

export async function runLogout(ctx: RunContext, deps: LogoutDeps = {}): Promise<ExitCode> {
  const config = await resolveConfig(ctx.globals);
  const read = deps.readToken ?? readToken;
  const clear = deps.clearToken ?? clearToken;

  const token = await read(config.profile);
  if (token === null) {
    ctx.io.out("Already logged out.");
    return ExitCode.OK;
  }

  // Best-effort server-side revoke. A transport / non-OK failure must not block
  // clearing the local secret — log a warning and proceed.
  const client = new ApiClient({ baseUrl: config.apiUrl, token, fetch: deps.fetch });
  try {
    await client.json("/v1/cli/logout", { method: "POST" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.io.err(
      `warning: could not revoke the token server-side (${detail}); clearing it locally anyway.`,
    );
  }

  await clear(config.profile);
  ctx.io.out("Logged out.");
  return ExitCode.OK;
}

export const logoutCommand: Leaf = {
  name: "logout",
  summary: "Revoke the active profile's token and clear it locally.",
  run: (ctx) => runLogout(ctx),
};
