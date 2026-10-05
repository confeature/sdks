// SPDX-License-Identifier: MIT

import { credentialFilePath, credentialsDir } from "../config/paths.ts";
import { ExitCode } from "../cli/exit.ts";
import { CliError } from "../cli/errors.ts";

/** On-disk shape of a per-profile credential file. */
interface CredentialFile {
  token: string;
  savedAt: string;
}

const POSIX = Deno.build.os !== "windows";

/** Raised when a credential file is group/world-accessible (leaked secret). */
export class InsecureCredentialError extends CliError {
  constructor(path: string, mode: number) {
    super(
      `credential file ${path} is group/world-accessible (mode ` +
        `${(mode & 0o777).toString(8)}); refusing to use it. ` +
        `Run "confeature login" again to re-create it securely.`,
      ExitCode.RUNTIME,
    );
  }
}

/** Raised when a credential file exists but does not contain valid JSON. */
export class CorruptCredentialError extends CliError {
  constructor(path: string, detail: string) {
    super(
      `credential file ${path} is corrupt: ${detail}. ` +
        `Run "confeature login" again to re-create it.`,
      ExitCode.RUNTIME,
    );
  }
}

/**
 * Persist a bearer token for `profile`. Ensures the credentials directory
 * exists with mode `0700`, writes the file, then chmods it to `0600` so the
 * secret is owner-only at rest (FR-006, C13).
 *
 * No CLI command obtains a token in this slice (login is #654) — this is the
 * store the login slice + the tests drive.
 */
export async function writeToken(profile: string, token: string): Promise<void> {
  const dir = credentialsDir();
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) {
    // mkdir's `mode` is masked by the process umask; force it.
    await Deno.chmod(dir, 0o700);
  }

  const path = credentialFilePath(profile);
  const payload: CredentialFile = { token, savedAt: new Date().toISOString() };
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  if (POSIX) {
    await Deno.chmod(path, 0o600);
  }
}

/**
 * Read the bearer token for `profile`, or `null` if none is stored.
 *
 * Defensive (data-model): on POSIX, if the credential file is group- or
 * world-accessible, treat it as untrusted — throw so the caller can instruct a
 * re-login rather than silently trusting a leaked secret.
 */
export async function readToken(profile: string): Promise<string | null> {
  const path = credentialFilePath(profile);
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }

  if (POSIX && info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new InsecureCredentialError(path, info.mode);
  }

  const text = await Deno.readTextFile(path);
  let parsed: CredentialFile;
  try {
    parsed = JSON.parse(text) as CredentialFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CorruptCredentialError(path, detail);
  }
  return typeof parsed.token === "string" ? parsed.token : null;
}

/**
 * Delete the credential file for `profile`. No error if it is already absent
 * (idempotent logout).
 */
export async function clearToken(profile: string): Promise<void> {
  const path = credentialFilePath(profile);
  try {
    await Deno.remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
}
