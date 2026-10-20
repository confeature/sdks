// SPDX-License-Identifier: MIT

/**
 * The single source of truth for the CLI version string (FR-001, C3).
 *
 * `--version` prints exactly this value, and the smoke test asserts against it.
 * Keep this in sync with the `version` field in `deno.json` when releasing.
 */
export const VERSION = "0.4.0";
