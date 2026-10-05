// SPDX-License-Identifier: MIT

import { assertEquals, assertThrows } from "@std/assert";
import { VERSION } from "../src/version.ts";
import { parseCliTag, verifyReleaseTag } from "../scripts/release-version-check.ts";

// R2 / FR-004 — the release version guard.
//
// `parseCliTag` extracts `X.Y.Z` from a well-formed `cli-vX.Y.Z` tag and throws
// on a malformed one; `verifyReleaseTag` throws unless the tag's version equals
// the declared `VERSION`. Both are pure so the workflow step and this unit test
// share one source of truth (no tag push needed to test the guard).

Deno.test("parseCliTag extracts the semver from a well-formed tag", () => {
  assertEquals(parseCliTag("cli-v0.1.0"), "0.1.0");
  assertEquals(parseCliTag("cli-v12.34.56"), "12.34.56");
});

Deno.test("verifyReleaseTag accepts a tag matching the declared VERSION", () => {
  // No throw == pass. Anchored to the real VERSION so it tracks releases.
  verifyReleaseTag(`cli-v${VERSION}`, VERSION);
});

Deno.test("verifyReleaseTag throws when the tag version differs from VERSION", () => {
  assertThrows(
    () => verifyReleaseTag("cli-v9.9.9", VERSION),
    Error,
    "does not match",
  );
});

Deno.test("parseCliTag throws on a malformed tag", () => {
  // Missing patch / non-numeric / wrong prefix / missing the `v`.
  for (
    const bad of ["cli-vx", "v0.1.0", "cli-1.2.3", "cli-v1.2", "cli-v1.2.3.4", "cli-v1.2.3-rc1", ""]
  ) {
    assertThrows(() => parseCliTag(bad), Error);
  }
});

Deno.test("verifyReleaseTag throws on a malformed tag (delegates to parse)", () => {
  assertThrows(() => verifyReleaseTag("cli-1.2.3", VERSION), Error);
});
