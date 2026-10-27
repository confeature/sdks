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

// ---------------------------------------------------------------------------
// Redirect cases (1.4, #994, epic #834)
// ---------------------------------------------------------------------------

/** The `server.redirect` / redirect-related fields of a case, as the rules read them. */
export interface RedirectCaseLike {
  id: string;
  given: { originScheme?: string; previousEtag?: string | null };
  server: {
    redirect?: { status: number; location: string };
    status: number;
    bodyRef?: string | null;
  };
  expected: {
    outcome: string;
    errorClass?: string;
    hasConfig: boolean;
    downgradeTargetRequests?: number;
    failureReason?: string;
  };
}

/**
 * The redirect rules the schema states only in part:
 *
 * 1. `server.redirect` requires `given.originScheme` (the rule is about what
 *    follows an https request) — and the converse: `originScheme` without a
 *    redirect pins nothing and is rejected, so it cannot become decoration.
 * 2. A Location on `http` after an https origin is the DOWNGRADE: the case
 *    MUST expect `failed` / `fetchFailed`, `downgradeTargetRequests: 0` and
 *    `failureReason: insecure_redirect`, and its target MUST answer 200 with a
 *    config — so an SDK that follows reports `fetched` and fails the case
 *    instead of passing it by accident.
 * 3. A Location on `https` is FOLLOWED: the case MUST expect `fetched` and
 *    carries neither `downgradeTargetRequests` nor `failureReason`.
 * 4. Neither expected field may appear on a case without a redirect.
 */
export function redirectErrors(cases: readonly RedirectCaseLike[]): string[] {
  const errors: string[] = [];
  for (const wireCase of cases) {
    const { id, given, server, expected } = wireCase;
    const redirect = server.redirect;
    const pinsDowngrade =
      expected.downgradeTargetRequests !== undefined || expected.failureReason !== undefined;
    if (redirect === undefined) {
      if (given.originScheme !== undefined) {
        errors.push(`${id}: given.originScheme without server.redirect pins nothing`);
      }
      if (pinsDowngrade) {
        errors.push(
          `${id}: expected.downgradeTargetRequests / failureReason without server.redirect`,
        );
      }
      continue;
    }
    if (given.originScheme !== "https") {
      errors.push(`${id}: server.redirect requires given.originScheme "https"`);
    }
    const scheme = /^(https?):\/\/\{origin\}\{samePath\}$/.exec(redirect.location)?.[1];
    if (scheme === "http") {
      if (expected.outcome !== "failed" || expected.errorClass !== "fetchFailed") {
        errors.push(`${id}: an https→http redirect must expect failed / fetchFailed`);
      }
      if (expected.downgradeTargetRequests !== 0) {
        errors.push(`${id}: an https→http redirect must expect downgradeTargetRequests 0`);
      }
      if (expected.failureReason !== "insecure_redirect") {
        errors.push(`${id}: an https→http redirect must expect failureReason insecure_redirect`);
      }
      if (server.status !== 200 || server.bodyRef == null) {
        errors.push(
          `${id}: the downgrade target must answer 200 with a bodyRef config, so a follower reports fetched`,
        );
      }
    } else if (scheme === "https") {
      if (expected.outcome !== "fetched") {
        errors.push(`${id}: an https→https redirect must expect fetched`);
      }
      if (pinsDowngrade) {
        errors.push(
          `${id}: an https→https redirect has no downgrade target — no downgradeTargetRequests / failureReason`,
        );
      }
    } else {
      errors.push(
        `${id}: server.redirect.location ${JSON.stringify(redirect.location)} is not a known template`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The pending list (wire-cases-pending.json, 1.4, #994)
// ---------------------------------------------------------------------------

export interface PendingManifest {
  description?: string;
  pending: Record<string, { ticket: string; cases: string[] }>;
}

/**
 * A wire-case consumer as the validator finds it BY CONTENT: an `apps/<name>`
 * directory whose tracked files read `wire-cases.json` (never a path glob —
 * #490 missed eleven consumers that way). `readsPending` is whether any of
 * those files names `wire-cases-pending.json`.
 */
export interface WireConsumer {
  name: string;
  readsPending: boolean;
}

/**
 * The pending list's rules. An entry is a narrowing of a claim, so each one
 * must stay true:
 *
 * 1. It names a real consumer (found by content) — a typo would exempt nobody
 *    and hide that the real consumer is red… or green by skipping.
 * 2. That consumer READS the pending file, so the skip and its proof actually
 *    run there (an entry the consumer ignores is decoration).
 * 3. It carries a ticket (`#NNN`) and at least one case, each a real corpus
 *    case, listed once.
 * 4. Only cases that NEED the list may be on it: a case of corpus schema 1.4
 *    or later that introduced a field consumers cannot yet serve — today the
 *    redirect cases. Parking a 1.3 case here would be a silent skip with a
 *    ticket attached.
 *
 * Each listed consumer's own suite then proves, per case, that it still
 * cannot read (native readers) or pass (the TS reader) it — the proof that
 * fails the moment the entry is stale.
 */
export function pendingErrors(
  manifest: PendingManifest,
  cases: readonly RedirectCaseLike[],
  consumers: readonly WireConsumer[],
): string[] {
  const errors: string[] = [];
  const byName = new Map(consumers.map((c) => [c.name, c] as const));
  const caseById = new Map(cases.map((c) => [c.id, c] as const));
  for (const [name, entry] of Object.entries(manifest.pending)) {
    const consumer = byName.get(name);
    if (consumer === undefined) {
      errors.push(
        `pending ${name}: not a wire-case consumer (no apps/${name} file reads wire-cases.json)`,
      );
    } else if (!consumer.readsPending) {
      errors.push(
        `pending ${name}: no apps/${name} file reads wire-cases-pending.json — the skip and its proof never run there`,
      );
    }
    if (!/^#[1-9][0-9]*$/.test(entry.ticket)) {
      errors.push(`pending ${name}: ticket ${JSON.stringify(entry.ticket)} is not #NNN`);
    }
    if (entry.cases.length === 0) {
      errors.push(`pending ${name}: an entry with no case — delete it`);
    }
    if (new Set(entry.cases).size !== entry.cases.length) {
      errors.push(`pending ${name}: a case is listed twice`);
    }
    for (const id of entry.cases) {
      const wireCase = caseById.get(id);
      if (wireCase === undefined) {
        errors.push(`pending ${name}: ${id} is not in the corpus`);
      } else if (wireCase.server.redirect === undefined) {
        errors.push(
          `pending ${name}: ${id} is not a redirect case — only a 1.4 case may be pending`,
        );
      }
    }
  }
  return errors;
}
