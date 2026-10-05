// SPDX-License-Identifier: MIT

/**
 * The cross-file rules of `fixtures/wire-cases.json` that its JSON Schema
 * cannot express (1.3, #803). Pure — no file reads, no `process.exit` — so
 * `scripts/validate-wire-cases.ts` runs them on the real corpus and
 * `tests/wire-case-rules.test.ts` drives every branch on hand-built corpora.
 * No vitest import, so the validator can load it under plain `tsx`.
 *
 * 1. `given.sdkKey` is never a per-case literal: it MUST be a `valid` key of
 *    sdk-key-shapes.json, the one key list every SDK validator reads — with
 *    ONE exception, below.
 * 2. `expected.requestPath` is FR-001's path for `given.sdkKey`, computed by
 *    the oracle's one escaper (src/fr001-path.ts — the same function the TS
 *    wire reader uses): a well-shaped key travels RAW, its exact bytes
 *    between `/configuration-files/` and `/config_v6.json`, a ConfigCat-shaped
 *    key's `/` kept (three segments, a stock ConfigCat SDK's bytes); any other
 *    key is ONE segment escaped with Go's `url.PathEscape`. A typo in the
 *    pinned path, or a key that is not in the list, fails here, before any SDK
 *    suite is asked to match it. The pinned path is real `go run` output, so
 *    this rule also cross-checks the TS escaper against Go.
 * 3. A case that pins `expected.requestPath` MUST pin `given.sdkKey`; one
 *    that does not is MALFORMED and rejected, never judged against a
 *    "default" key, because no such default exists at corpus level: the
 *    hermetic suites each carry their own constant, the sdk-node live runner
 *    configures the case's own id (the harness seeds each case under it), and
 *    the CDN's request-path test refuses the case outright. A path judged
 *    against one of those would pass here and fail another consumer. The
 *    schema states the same requirement (`if expected.requestPath then
 *    given.sdkKey`); this rule makes `crossFileErrors` fail closed on its own
 *    rather than skip, unchecked, a path it was handed.
 *
 * The exception: MALFORMED_KEY_CASES may pin a key that is NOT in
 * sdk-key-shapes.json, solely to pin FR-001's escape of a malformed key
 * (#803 review: seven SDKs escaped one differently from Go, and a corpus of
 * valid keys — whose escape is a no-op — could not see it). Its key is inline
 * rather than in the shapes file's `invalid` list on purpose: that list feeds
 * every SDK's key-validator AND per-SDK URL tests, and widening it would move
 * ~25 suites to pin one wire path. The exception is narrow by construction:
 * the key must genuinely FAIL the shape check (a well-shaped key belongs in the
 * list), must have a path (not "", "." or ".."), the case must pin
 * `requestPath` — a malformed key exists here only to pin its path — and the
 * exception cannot outlive its case.
 */

import { fr001Path, WELL_SHAPED_KEY } from "./fr001-path.ts";

export const MALFORMED_KEY_CASES: ReadonlySet<string> = new Set(["request-path-malformed-key"]);

export interface WireCaseLike {
  id: string;
  given: { sdkKey?: string };
  expected: { requestPath?: string };
}

/**
 * Every cross-file violation in `cases`, one message each; `[]` when the
 * corpus is clean. `validKeys` is the `valid` list of sdk-key-shapes.json;
 * `malformedKeyCases` defaults to the one named exception.
 */
export function crossFileErrors(
  cases: readonly WireCaseLike[],
  validKeys: ReadonlySet<string>,
  malformedKeyCases: ReadonlySet<string> = MALFORMED_KEY_CASES,
): string[] {
  const errors: string[] = [];
  for (const wireCase of cases) {
    const { sdkKey } = wireCase.given;
    const { requestPath } = wireCase.expected;
    if (malformedKeyCases.has(wireCase.id)) {
      if (sdkKey === undefined || requestPath === undefined) {
        errors.push(
          `${wireCase.id}: a malformed-key case must pin both given.sdkKey and expected.requestPath`,
        );
        continue;
      }
      if (WELL_SHAPED_KEY.test(sdkKey) || validKeys.has(sdkKey)) {
        errors.push(
          `${wireCase.id}: given.sdkKey ${JSON.stringify(sdkKey)} is well-shaped — a valid key belongs in sdk-key-shapes.json, not inline`,
        );
      }
      if (sdkKey === "" || sdkKey === "." || sdkKey === "..") {
        errors.push(
          `${wireCase.id}: given.sdkKey ${JSON.stringify(sdkKey)} has no FR-001 path (the SDK refuses to fetch)`,
        );
        continue;
      }
    } else if (sdkKey !== undefined && !validKeys.has(sdkKey)) {
      errors.push(
        `${wireCase.id}: given.sdkKey ${JSON.stringify(sdkKey)} is not a valid key in sdk-key-shapes.json`,
      );
    }
    if (requestPath !== undefined && sdkKey === undefined) {
      // Rule 3: rejected, never judged against a default — there is none to
      // judge against (see the header).
      errors.push(
        `${wireCase.id}: expected.requestPath is pinned without given.sdkKey — the path is a function of the key, and a consumer's default key is its own (the live runner uses the case id), so pin the key`,
      );
      continue;
    }
    if (requestPath !== undefined && sdkKey !== undefined) {
      // fr001Path throws for a key with no path ("" "." "..", a lone
      // surrogate); report it against the case rather than crash the gate.
      let fr001: string;
      try {
        fr001 = fr001Path(sdkKey);
      } catch (error) {
        errors.push(`${wireCase.id}: ${(error as Error).message}`);
        continue;
      }
      if (requestPath !== fr001) {
        errors.push(
          `${wireCase.id}: expected.requestPath ${JSON.stringify(requestPath)} is not FR-001's path ${JSON.stringify(fr001)}`,
        );
      }
    }
  }
  for (const id of malformedKeyCases) {
    // The exception cannot outlive its case.
    if (!cases.some((wireCase) => wireCase.id === id)) {
      errors.push(`${id}: listed in MALFORMED_KEY_CASES but not in the corpus`);
    }
  }
  return errors;
}
