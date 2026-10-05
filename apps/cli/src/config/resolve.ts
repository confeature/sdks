// SPDX-License-Identifier: MIT

import type { Globals } from "../cli/globals.ts";
import { type ConfigFile, loadConfigFile, selectProfile } from "./profile.ts";
import { ExitCode } from "../cli/exit.ts";
import { CliError } from "../cli/errors.ts";

/** The default hosted management API base URL (matches the management API's server URL). */
export const DEFAULT_API_URL = "https://api.confeature.io";

/** Which source won a given resolved field (observability for SC-004). */
export type Source = "flag" | "env" | "file" | "default";

/** Raised when a resolved API URL is not an absolute http(s) URL. */
export class InvalidApiUrlError extends CliError {
  constructor(apiUrl: string, source: Source) {
    super(
      `invalid API URL '${apiUrl}' (from ${source}): must be an absolute ` +
        `http(s) URL.`,
      ExitCode.USAGE,
    );
  }
}

/**
 * Reject an API base URL that does not parse as an absolute http(s) URL. This
 * is the choke point before any later slice (#654+) uses `apiUrl` as a request
 * target, so a `file:`/`javascript:`/garbage value can never reach `fetch`.
 */
function assertHttpUrl(apiUrl: string, source: Source): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new InvalidApiUrlError(apiUrl, source);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidApiUrlError(apiUrl, source);
  }
}

/** The effective, resolved configuration for a single invocation. */
export interface EffectiveConfig {
  apiUrl: string;
  profile: string;
  outputJson: boolean;
  /** Which source supplied each tracked field. */
  source: { apiUrl: Source; profile: Source };
}

/**
 * Resolve the effective configuration with strict precedence
 * **flag > env (`CONFEATURE_*`) > config file > built-in default** (FR-004),
 * recording which source won each field (SC-004).
 *
 * `config` may be pre-loaded (the tests inject it); when omitted it is read
 * from disk via {@link loadConfigFile}. A malformed file surfaces as a thrown
 * `MalformedConfigError` naming the path (C17). An undefined `--profile` throws
 * `UnknownProfileError` (C12).
 */
export async function resolveConfig(
  globals: Globals,
  env: { apiUrl?: string; profile?: string } = readEnv(),
  config: ConfigFile | null | undefined = undefined,
): Promise<EffectiveConfig> {
  const loaded = config === undefined ? await loadConfigFile() : config;

  // Profile selection (flag > env > file activeProfile > "default").
  const requestedProfile = globals.profile ?? env.profile;
  const { name: profileName, settings } = selectProfile(loaded, requestedProfile);

  let profileSource: Source = "default";
  if (globals.profile !== undefined) profileSource = "flag";
  else if (env.profile !== undefined) profileSource = "env";
  else if (loaded?.activeProfile !== undefined) profileSource = "file";

  // apiUrl resolution.
  let apiUrl = DEFAULT_API_URL;
  let apiUrlSource: Source = "default";
  if (globals.apiUrl !== undefined) {
    apiUrl = globals.apiUrl;
    apiUrlSource = "flag";
  } else if (env.apiUrl !== undefined) {
    apiUrl = env.apiUrl;
    apiUrlSource = "env";
  } else if (settings.apiUrl !== undefined) {
    apiUrl = settings.apiUrl;
    apiUrlSource = "file";
  }

  assertHttpUrl(apiUrl, apiUrlSource);

  return {
    apiUrl,
    profile: profileName,
    outputJson: globals.outputJson,
    source: { apiUrl: apiUrlSource, profile: profileSource },
  };
}

/** Read the `CONFEATURE_*` environment overrides. */
export function readEnv(): { apiUrl?: string; profile?: string } {
  const result: { apiUrl?: string; profile?: string } = {};
  const apiUrl = Deno.env.get("CONFEATURE_API_URL");
  if (apiUrl) result.apiUrl = apiUrl;
  const profile = Deno.env.get("CONFEATURE_PROFILE");
  if (profile) result.profile = profile;
  return result;
}
