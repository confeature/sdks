// SPDX-License-Identifier: MIT

/**
 * Release version guard (R2, FR-004; distribution slice #657 / spec 183).
 *
 * A pure, testable helper that asserts a pushed `cli-vX.Y.Z` tag agrees with the
 * CLI's declared `VERSION` (`src/version.ts`). The release workflow runs it as a
 * `deno run` step BEFORE any compile/upload, so a published binary can never
 * disagree with its tag (SC-003); the unit test imports the same functions so
 * the guard is covered without cutting a tag.
 *
 * Usage in the workflow:
 *   deno run scripts/release-version-check.ts "$GITHUB_REF_NAME"
 * Exits non-zero (with a clear message) on a malformed tag or a version mismatch.
 */

import { VERSION } from "../src/version.ts";

/** A strict `cli-v` + dotted three-part numeric semver (no pre-release / build). */
const TAG_PATTERN = /^cli-v(\d+\.\d+\.\d+)$/;

/**
 * Extract the `X.Y.Z` semver from a well-formed `cli-vX.Y.Z` tag.
 *
 * Throws on any malformed tag (wrong prefix, missing `v`, non-numeric, fewer or
 * more than three parts, a pre-release/build suffix) so the workflow fails loudly
 * rather than uploading against an ambiguous tag.
 */
export function parseCliTag(tag: string): string {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(
      `malformed CLI release tag: "${tag}" (expected "cli-vX.Y.Z", e.g. "cli-v0.1.0")`,
    );
  }
  return match[1];
}

/**
 * Assert the tag's version equals the declared one. No-op on a match; throws on a
 * malformed tag (via {@link parseCliTag}) or a version mismatch.
 *
 * @param tag      the pushed tag, e.g. `cli-v0.1.0`.
 * @param declared the declared `VERSION` (defaults to `src/version.ts`).
 */
export function verifyReleaseTag(tag: string, declared: string = VERSION): void {
  const tagged = parseCliTag(tag);
  if (tagged !== declared) {
    throw new Error(
      `release tag version (${tagged}) does not match the declared CLI version ` +
        `(${declared}). Bump src/version.ts + deno.json, or re-tag.`,
    );
  }
}

if (import.meta.main) {
  const tag = Deno.args[0];
  if (!tag) {
    console.error("usage: deno run scripts/release-version-check.ts <cli-vX.Y.Z>");
    Deno.exit(2);
  }
  try {
    verifyReleaseTag(tag);
    console.log(`✓ tag ${tag} matches the declared CLI version (${VERSION})`);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
