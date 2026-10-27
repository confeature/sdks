// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { access, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { caseToSeedPath, defaultWireCasesPath, listWireCaseIds } from "../src/corpus-mapper.js";

/**
 * Wire-cases this harness CANNOT express, each with the specific reason and,
 * where one exists, what would unblock it (#778).
 *
 * This list is a narrowing of a claim, not a suppression of a failure, and the
 * difference is enforced below: every id here must still exist in the corpus,
 * none of them may acquire a seed, and every reason must be a real one. An
 * exclusion that stops being true fails the suite rather than surviving in it.
 *
 * Plan 680 (#780) removed five entries by adding the `status` fault and the
 * `close-mid-response` behaviour. What they now serve is checked by
 * seed-fidelity.test.ts; this file only checks that seeds EXIST.
 */
const NOT_REPRESENTABLE: ReadonlyMap<string, string> = new Map([
  [
    "custom-base-url",
    "NOT a gap, and the one entry here that no feature would remove. It is a " +
      "CLIENT-configuration case: it asserts the SDK builds its request URL from a " +
      "configured baseUrl. In live mode the harness IS that custom base — it prints " +
      "`LIVE_HARNESS_URL` and every SDK under test points at it — so the case is " +
      "satisfied by the harness existing. There is no server state to seed, and a " +
      "seed file would be an empty gesture.",
  ],
  ...(
    ["request-path-legacy-key", "request-path-configcat-key", "request-path-malformed-key"] as const
  ).map(
    (id) =>
      [
        id,
        "A GAP in this harness's addressing, not in the Worker (#803). The case's " +
          "subject is the SDK key's own bytes in the request path (given.sdkKey → " +
          "expected.requestPath), but buildCorpusSeed renames every seeded key to its " +
          "case id and every live runner addresses a case by using that id as its SDK " +
          "key — so a seed here would serve the id, never the pinned key. The server " +
          "half is checked against the same Worker by the private CDN Worker's " +
          "request-path integration test (every corpus requestPath reaches serveConfig for that " +
          "exact key); the client half by every hermetic wire suite. Unblocked when " +
          "the corpus seed keys such a case by given.sdkKey and the runners send it.",
      ] as const,
  ),
  ...(["redirect-https-to-http-refused", "redirect-https-to-https-followed"] as const).map(
    (id) =>
      [
        id,
        "A GAP in this harness's transport, not in the Worker (#994, epic #834). The " +
          "case's subject is a hop: an https origin answers a 30x (server.redirect) to " +
          "an http downgrade target that counts its hits, or to a second https hop. The " +
          "harness is one plain-http Miniflare listener with no TLS, no Location, no " +
          "second target and no redirect fault (fault-injector kinds: status, timeout, " +
          "etag-mismatch), and the CDN Worker never redirects a config request, so a " +
          "seed would serve the target answer directly and prove nothing. The client " +
          "half is checked by every hermetic wire suite (wire-test-helpers' redirect " +
          "transport for the JS family). Unblocked by an https listener plus a redirect " +
          "fault with a counted second target.",
      ] as const,
  ),
]);

describe("wire-cases corpus → seed mapping", () => {
  it("every representable case ID in wire-cases.json has a seed file", async () => {
    const ids = await listWireCaseIds(defaultWireCasesPath());
    expect(ids.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const id of ids) {
      if (NOT_REPRESENTABLE.has(id)) continue;
      try {
        await access(caseToSeedPath(id));
      } catch {
        missing.push(id);
      }
    }
    // Reported as a SET, not one at a time: the old form threw on the first
    // missing id, so a reader learned about `http-401` and nothing about the
    // six behind it. Knowing the whole gap is what made #778 answerable.
    expect(missing).toEqual([]);
  });

  it("every exclusion still names a real case — the list cannot outlive its subject", async () => {
    // A renamed or deleted wire-case must not leave a stale excuse behind that
    // silently narrows coverage for a case nobody is tracking any more.
    const ids = new Set(await listWireCaseIds(defaultWireCasesPath()));
    const stale = [...NOT_REPRESENTABLE.keys()].filter((id) => !ids.has(id));
    expect(stale).toEqual([]);
  });

  it("no exclusion has a seed — a case that became representable must lose its excuse", async () => {
    // The other direction, and the one that matters when the arbitrary-status
    // fault lands: whoever writes `seeds/http-403.json` should be told to delete
    // the exclusion, not left with a file the suite quietly ignores.
    const withSeeds: string[] = [];
    for (const id of NOT_REPRESENTABLE.keys()) {
      try {
        await access(caseToSeedPath(id));
        withSeeds.push(id);
      } catch {
        /* expected — no seed, because it cannot be expressed */
      }
    }
    expect(withSeeds).toEqual([]);
  });

  it("every seed names a real case — a seed cannot outlive its subject", async () => {
    // The mirror of the check above: a seed whose case left the corpus (or
    // was misspelt) would be served by nothing and checked by nothing.
    const ids = new Set(await listWireCaseIds(defaultWireCasesPath()));
    const seedsDir = dirname(caseToSeedPath("probe"));
    const orphans = (await readdir(seedsDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  it("every exclusion carries a non-trivial reason", () => {
    for (const [id, reason] of NOT_REPRESENTABLE) {
      expect(reason.length, `exclusion ${id} needs a real reason`).toBeGreaterThan(60);
    }
  });

  it("rejects malformed case ids", () => {
    expect(() => caseToSeedPath("../etc/passwd")).toThrow();
    expect(() => caseToSeedPath("with space")).toThrow();
    expect(() => caseToSeedPath("UPPER")).toThrow();
  });
});
