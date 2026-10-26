// SPDX-License-Identifier: MIT

/**
 * The single source of truth for the CLI version string (FR-001, C3).
 *
 * `--version` prints exactly this value, and the smoke test asserts against it.
 * A `cli-v<version>` release tag must match it (`scripts/release-version-check.ts`).
 */
export const VERSION = "0.6.0";
