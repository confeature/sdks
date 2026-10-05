// SPDX-License-Identifier: MIT

import { configFilePath } from "./paths.ts";
import { ExitCode } from "../cli/exit.ts";
import { CliError } from "../cli/errors.ts";

/** Per-profile non-secret settings stored in `config.json`. */
export interface ProfileSettings {
  apiUrl?: string;
}

/** The parsed `config.json` document. */
export interface ConfigFile {
  activeProfile: string;
  profiles: Record<string, ProfileSettings>;
}

/** Raised when `config.json` exists but is malformed (invalid JSON / shape). */
export class MalformedConfigError extends CliError {
  constructor(path: string, detail: string) {
    super(`malformed config file ${path}: ${detail}`, ExitCode.RUNTIME);
  }
}

/** Raised when a selected `--profile`/active profile is not defined. */
export class UnknownProfileError extends CliError {
  constructor(profile: string, path: string) {
    super(`unknown profile '${profile}' — not defined in ${path}`, ExitCode.USAGE);
  }
}

/**
 * Read and validate `config.json`. Returns `null` when the file is absent (a
 * fresh install with no config is valid). Throws {@link MalformedConfigError}
 * with the file path on invalid JSON or an unexpected shape (data-model edge
 * case, C17) — never a raw stack trace.
 */
export async function loadConfigFile(): Promise<ConfigFile | null> {
  const path = configFilePath();
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MalformedConfigError(path, detail);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new MalformedConfigError(path, "expected a JSON object");
  }

  const obj = raw as Record<string, unknown>;
  const profiles = obj.profiles;
  if (typeof profiles !== "object" || profiles === null) {
    throw new MalformedConfigError(path, "missing 'profiles' object");
  }

  const activeProfile = typeof obj.activeProfile === "string" ? obj.activeProfile : "default";

  const validated: Record<string, ProfileSettings> = {};
  for (const [name, value] of Object.entries(profiles as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new MalformedConfigError(path, `profile '${name}' is not an object`);
    }
    const settings = value as Record<string, unknown>;
    const apiUrl = settings.apiUrl;
    if (apiUrl !== undefined && typeof apiUrl !== "string") {
      throw new MalformedConfigError(path, `profile '${name}'.apiUrl must be a string`);
    }
    validated[name] = apiUrl === undefined ? {} : { apiUrl };
  }

  return { activeProfile, profiles: validated };
}

/**
 * Resolve which profile is active and return its settings.
 *
 * Selection order: an explicit `--profile` flag wins; otherwise the file's
 * `activeProfile`; otherwise `"default"`. A `--profile` naming an undefined
 * profile is a usage error — {@link UnknownProfileError}, never a silent
 * fallback (FR-005, C11/C12).
 */
export function selectProfile(
  config: ConfigFile | null,
  requested: string | undefined,
): { name: string; settings: ProfileSettings } {
  const path = configFilePath();
  const profiles = config?.profiles ?? {};

  if (requested !== undefined) {
    if (!(requested in profiles)) {
      throw new UnknownProfileError(requested, path);
    }
    return { name: requested, settings: profiles[requested] };
  }

  const active = config?.activeProfile ?? "default";
  return { name: active, settings: profiles[active] ?? {} };
}
