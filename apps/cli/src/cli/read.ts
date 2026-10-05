// SPDX-License-Identifier: MIT

import { ExitCode } from "./exit.ts";
import { CliError } from "./errors.ts";
import type { RunContext } from "./commands/registry.ts";
import type { FetchLike } from "../api/client.ts";
import { ApiClient, ApiError } from "../api/client.ts";
import { readToken } from "../auth/credentials.ts";
import { resolveConfig } from "../config/resolve.ts";

/**
 * Shared plumbing for the read commands (`org`/`product`/`config`/`environment`/
 * `flag ls`, spec 181 / #655).
 *
 * Every read needs the same three things: an authenticated {@link ApiClient}, a
 * uniform "not logged in" failure when there is no session (R8), and a way to
 * render either a table or `--json`. This module owns the first two so each
 * command stays a thin "fetch → shape → render" leaf.
 *
 * SECURITY: the token is read from the cred store and handed to the client,
 * which attaches it as a bearer header. It is NEVER written to `io.out`/`io.err`.
 */

/** The message both the offline short-circuit and a 401 surface (R8). */
export const NOT_LOGGED_IN_MESSAGE = "not logged in — run `confeature login`";

/**
 * Raised when a read is attempted with no local session. Exits with `AUTH` (4)
 * and the uniform {@link NOT_LOGGED_IN_MESSAGE}. The offline path throws this
 * BEFORE any network call (R8); a server-side 401 is mapped to the same error so
 * the user sees one consistent message regardless of where the gap was caught.
 */
export class NotLoggedInError extends CliError {
  constructor() {
    super(NOT_LOGGED_IN_MESSAGE, ExitCode.AUTH);
  }
}

/** Injectable seams so command tests drive the read path without real I/O. */
export interface ReadDeps {
  fetch?: FetchLike;
  readToken?: (profile: string) => Promise<string | null>;
}

/** An authenticated client plus the resolved config it was built from. */
export interface ReadSession {
  client: ApiClient;
  apiUrl: string;
  profile: string;
  outputJson: boolean;
}

/**
 * Resolve config, require a session, and return an authenticated client.
 *
 * Throws {@link NotLoggedInError} (AUTH, NO network call) when no token is
 * stored for the active profile (R8). Otherwise the returned client carries the
 * bearer so the caller can issue typed GETs.
 */
export async function openReadSession(
  ctx: RunContext,
  deps: ReadDeps = {},
): Promise<ReadSession> {
  const config = await resolveConfig(ctx.globals);
  const read = deps.readToken ?? readToken;

  const token = await read(config.profile);
  // Offline short-circuit: refuse BEFORE touching the network (R8).
  if (token === null) {
    throw new NotLoggedInError();
  }

  const client = new ApiClient({ baseUrl: config.apiUrl, token, fetch: deps.fetch });
  return {
    client,
    apiUrl: config.apiUrl,
    profile: config.profile,
    outputJson: config.outputJson,
  };
}

/**
 * Run `fn` against the session and remap a server-side 401 to the uniform
 * {@link NotLoggedInError} — a revoked/expired token reads logged-out just like
 * having no token (R8). Every other {@link ApiError} (403/404/5xx) propagates
 * with its own status → exit-code mapping.
 */
export async function withSession<T>(
  session: ReadSession,
  fn: (client: ApiClient) => Promise<T>,
): Promise<T> {
  try {
    return await fn(session.client);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new NotLoggedInError();
    }
    throw error;
  }
}

/**
 * Require a leaf flag, throwing a clear USAGE error naming the option when it is
 * absent or empty (R9). Returns the trimmed value on success.
 */
export function requireOption(
  value: string | undefined,
  flag: string,
  command: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new CliError(
      `${command}: missing required option \`${flag}\`. ` +
        `Usage: confeature ${command} ${flag} <id>`,
      ExitCode.USAGE,
    );
  }
  return trimmed;
}

/**
 * Require a `--name` flag for the structural-create commands (#678), throwing a
 * clear USAGE error when it is absent or empty-after-trim. Returns the TRIMMED
 * name on success — the same trimming discipline `flag create` applies — so a
 * blank or whitespace-only name never reaches the server.
 */
export function requireName(value: string | undefined, command: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new CliError(
      `${command}: missing required option \`--name\`. ` +
        `Usage: confeature ${command} --name <name>`,
      ExitCode.USAGE,
    );
  }
  return trimmed;
}
