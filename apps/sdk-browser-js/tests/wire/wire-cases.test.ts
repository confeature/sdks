// SPDX-License-Identifier: MIT

/**
 * Wire-protocol fixture suite (Browser JS consumer).
 *
 * Drives sdk-browser-js's `HttpConfigFetcher` (re-exported from
 * `@confeature/sdk-shared` — the WHATWG-fetch implementation shared by
 * every browser-family SDK) against each case in
 * `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
 * corpus is the language-agnostic contract; this file is the
 * browser-specific consumer that maps the SDK's typed
 * FetchOutcome / SdkErrorCode vocabulary onto the corpus's normalised
 * {fetched, notModified, failed} × {fetchFailed, timeout, parseFailed,
 * invalidSdkKey} vocabulary.
 *
 * See epic #146 (contract testing framework) + #148 slice 1 (this
 * suite) + spec 112.
 *
 * The HttpConfigFetcher consumed here differs from sdk-node's:
 *  - browser binds sdkKey + sdkVersion at construction time, so
 *    `fetchAsync(eTag, signal)` is a 2-arg call (vs sdk-node's 3-arg
 *    `fetchAsync(sdkKey, eTag, signal)`).
 *  - error classification, URL shape, and `If-None-Match` round-trip
 *    are byte-identical — that is exactly what this suite gates.
 */

import { afterEach, beforeEach, describe, vi } from "vitest";

import { HttpConfigFetcher, LoggerWrapper, NullLogger } from "@confeature/sdk-shared";
import wireCases from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases.json" with { type: "json" };
// Cases this SDK cannot pass yet, by name (1.4, #994): each runs as a STRICT
// expected failure, so the entry turns red the day the SDK passes the case.
import wirePending from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases-pending.json" with { type: "json" };
import {
  buildFetchSpy,
  capturedRequestFromSpy,
  type WireCase,
  assertWireCase,
  pendingCasesFor,
  wireTestFor,
  sdkKeyFor,
} from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE_URL = "https://cdn.example.test";
const SDK_VERSION = "confeature-sdk-browser-js/0.0.0-wire-test";

const wireTest = wireTestFor(pendingCasesFor(wirePending, "sdk-browser-js"));

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wire-cases.json contract (Browser JS)", () => {
  for (const wireCase of wireCases.cases as unknown as WireCase[]) {
    wireTest(wireCase.id)(wireCase.id, async () => {
      const { given, server } = wireCase;
      // The corpus's `given.sdkKey` when the case pins one (#803, FR-003).
      const sdkKey = sdkKeyFor(wireCase, SDK_KEY);

      const fetchSpy = buildFetchSpy(server);
      vi.stubGlobal("fetch", fetchSpy);

      const logger = new LoggerWrapper(new NullLogger());
      const fetcher = new HttpConfigFetcher(given.baseUrl ?? BASE_URL, sdkKey, SDK_VERSION, logger);
      const controller = new AbortController();
      const outcome = await fetcher.fetchAsync(given.previousEtag, controller.signal);

      // ---- Request + outcome assertions: one shared definition (#783) ----
      const request = capturedRequestFromSpy(fetchSpy, server);
      assertWireCase(wireCase, outcome, request, sdkKey, SDK_VERSION);
    });
  }
});
