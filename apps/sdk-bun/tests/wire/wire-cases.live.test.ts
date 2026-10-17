// SPDX-License-Identifier: MIT

/**
 * sdk-bun live wire-cases (#919, after sdk-node's #783) — the fetcher this
 * SDK's client wires (`@confeature/sdk-shared`'s WHATWG `HttpConfigFetcher`,
 * stamped with this SDK's own `CONFEATURE_SDK_VERSION`, exactly as
 * `src/client.ts` builds it), over real HTTP, against a RUNNING live-contract
 * harness serving the reference origin of the CDN read path. Every seeded
 * wire-case is replayed and judged by `assertWireCase`, the SAME function the
 * hermetic suite (`wire-cases.test.ts`) uses on a mocked fetch — the corpus is
 * the only definition of a case; nothing is hand-built here, and no admin
 * write is made.
 *
 *   - The case set comes from the running harness (`GET /admin/state` →
 *     `keys`), never recomputed — the harness's own seed-fidelity test pins
 *     that set to the seeded corpus cases.
 *   - The request each case sent is read back from the harness
 *     (`GET /admin/requests`), and each fetch must add exactly one entry —
 *     so a retrying SDK, or a request logged by an earlier run, cannot stand
 *     in for the one under test.
 *   - A timeout case is ended by the SDK's OWN deadline: the fetcher's
 *     `requestTimeoutMs`, the option the client passes it, set to a quarter
 *     of the harness's hold — never by an abort the test fires itself.
 *   - US4: one unseeded key reaches the Worker's OWN unknown-key answer
 *     (ConfigCat's 403, `http-403`'s body since #918) — the one path the
 *     corpus seeds shield.
 *
 * Run it through the harness wrapper, the one agreed boot (the manifest's
 * `liveSuite.runner`):
 *
 *     node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
 *       --exec -- pnpm --filter @confeature/sdk-bun exec vp test run tests/wire/wire-cases.live.test.ts
 *
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
 * hermetic run. When it is set without `LIVE_HARNESS_URL`, or the harness
 * does not answer, the module FAILS at load; it never skips and never boots
 * a harness of its own.
 */

import { describe, expect, test } from "vitest";

import type {
  AdminRequestsResponse,
  AdminStateResponse,
  RecordedRequest,
} from "@confeature/test-harness-live-contract";
import {
  assertWireCase,
  ERROR_CODE_TO_CLASS,
  sdkKeyFor,
  type WireCase,
  wireTestFor,
} from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";
import wireCases from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases.json" with { type: "json" };
import { HttpConfigFetcher, LoggerWrapper, NullLogger } from "@confeature/sdk-shared";

import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";

const LIVE = process.env.CONFEATURE_LIVE === "1";
const HARNESS_URL = (process.env.LIVE_HARNESS_URL ?? "").replace(/\/$/, "");

// Known sdk-bun bugs, as STRICT expected failures: case id → ticket. A fix
// turns the case red until its entry is removed (#783 A7).
const KNOWN_SDK_BUGS: Record<string, string> = {};
const wireTest = wireTestFor(KNOWN_SDK_BUGS);

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HARNESS_URL}${path}`);
  if (!res.ok) throw new Error(`harness ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

if (LIVE && !HARNESS_URL) {
  throw new Error(
    "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " +
      "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping",
  );
}
const state: AdminStateResponse | undefined = LIVE
  ? await getJson<AdminStateResponse>("/admin/state")
  : undefined;
const caseIds = [...(state?.keys ?? [])].sort();
const corpusById = new Map(
  (wireCases.cases as unknown as WireCase[]).map((c) => [c.id, c] as const),
);

async function requestsFor(sdkKey: string): Promise<RecordedRequest[]> {
  const body = await getJson<AdminRequestsResponse>(
    `/admin/requests?sdkKey=${encodeURIComponent(sdkKey)}`,
  );
  if (!body.ok) throw new Error(`harness refused /admin/requests: ${body.error}`);
  return body.requests;
}

/** The fetcher as `src/client.ts` wires it: this SDK's version, its own timeout. */
function sdkFetcher(sdkKey: string, requestTimeoutMs?: number): HttpConfigFetcher {
  return new HttpConfigFetcher(
    HARNESS_URL,
    sdkKey,
    CONFEATURE_SDK_VERSION,
    new LoggerWrapper(new NullLogger()),
    requestTimeoutMs,
  );
}

describe.skipIf(!LIVE)("sdk-bun live wire-cases against the harness (#919)", () => {
  test("the harness serves a non-empty seeded set, all of it in the corpus", () => {
    expect(caseIds.length).toBeGreaterThan(0);
    expect(caseIds.filter((id) => !corpusById.has(id))).toEqual([]);
  });

  for (const id of caseIds) {
    wireTest(id)(id, async () => {
      const wireCase = corpusById.get(id)!;

      let holdMs: number | undefined;
      if (wireCase.server.behavior === "timeout") {
        // The SDK's deadline is derived from the harness's hold (#783 A8).
        const fault = state!.faults[id];
        holdMs = typeof fault === "object" && fault.kind === "timeout" ? fault.ms : undefined;
        if (holdMs === undefined) throw new Error(`${id} is seeded without a timeout fault`);
      }

      // The harness seeds each case under its id; a case that pins
      // given.sdkKey is configured with that key instead (#803, FR-003).
      const sdkKey = sdkKeyFor(wireCase, id);
      const before = (await requestsFor(sdkKey)).length;
      const startedAt = Date.now();
      const fetcher = sdkFetcher(sdkKey, holdMs === undefined ? undefined : Math.floor(holdMs / 4));
      const outcome = await fetcher.fetchAsync(
        wireCase.given.previousEtag,
        new AbortController().signal,
      );
      const elapsedMs = Date.now() - startedAt;

      const log = await requestsFor(sdkKey);
      expect(log.length - before, `${id}: requests sent by one fetch`).toBe(1);
      if (holdMs !== undefined) {
        // The SDK's own deadline ended the fetch, not the harness releasing it.
        expect(elapsedMs, `${id}: aborted before the hold`).toBeLessThan(holdMs);
      }
      assertWireCase(wireCase, outcome, log.at(-1)!, sdkKey, CONFEATURE_SDK_VERSION);
    });
  }

  test("an unseeded key reaches the Worker's own answer and reports invalidSdkKey (US4)", async () => {
    const outcome = await sdkFetcher("never-seeded-919").fetchAsync(
      null,
      new AbortController().signal,
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(ERROR_CODE_TO_CLASS[outcome.errorCode]).toBe("invalidSdkKey");
      // The Worker's 403, not the fetcher refusing to send the key: the
      // harness logs only seeded keys, so the status is the proof it was sent.
      expect(outcome.errorMessage).toContain("(HTTP 403)");
    }
  });
});
