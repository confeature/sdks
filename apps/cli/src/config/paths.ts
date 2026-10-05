// SPDX-License-Identifier: MIT

import { join } from "@std/path";
import { ExitCode } from "../cli/exit.ts";
import { CliError } from "../cli/errors.ts";

/**
 * Allowed profile-name shape. A profile name is interpolated into a credential
 * file path, so it MUST NOT contain path separators or `..` — otherwise a
 * crafted `activeProfile` in `config.json` (or a `--profile` value once #654's
 * login writes tokens) becomes a path-traversal read/write primitive. Restrict
 * to a safe, conventional identifier set.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Raised when a profile name is unsafe / malformed (path-traversal guard). */
export class InvalidProfileNameError extends CliError {
  constructor(profile: string) {
    super(
      `invalid profile name '${profile}': must match letters, digits, '-' or ` +
        `'_' (1–64 chars).`,
      ExitCode.USAGE,
    );
  }
}

/** Validate a profile name against {@link PROFILE_NAME_PATTERN}; returns it on success. */
export function validateProfileName(profile: string): string {
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new InvalidProfileNameError(profile);
  }
  return profile;
}

/**
 * Resolve the Confeature config directory (data-model "Config directory").
 *
 *   - POSIX: `$XDG_CONFIG_HOME/confeature` (default `~/.config/confeature`).
 *   - Windows: `%APPDATA%\confeature`.
 *
 * The directory itself is created on first write (mode `0700`); this function
 * only computes the path.
 */
export function configDir(): string {
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA");
    if (appData) {
      return join(appData, "confeature");
    }
    // Fallback: USERPROFILE\AppData\Roaming.
    const userProfile = Deno.env.get("USERPROFILE") ?? ".";
    return join(userProfile, "AppData", "Roaming", "confeature");
  }

  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) {
    return join(xdg, "confeature");
  }
  const home = Deno.env.get("HOME") ?? ".";
  return join(home, ".config", "confeature");
}

/** Absolute path to the non-secret `config.json` settings file. */
export function configFilePath(): string {
  return join(configDir(), "config.json");
}

/** Directory holding per-profile credential files (secrets, mode `0700`). */
export function credentialsDir(): string {
  return join(configDir(), "credentials");
}

/**
 * Absolute path to a single profile's credential file. The profile name is
 * validated first ({@link validateProfileName}) so it can never traverse out of
 * the credentials directory — this is the single choke point every credential
 * read/write/clear flows through.
 */
export function credentialFilePath(profile: string): string {
  validateProfileName(profile);
  return join(credentialsDir(), `${profile}.json`);
}
