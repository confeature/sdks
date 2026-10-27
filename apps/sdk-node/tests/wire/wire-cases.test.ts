// SPDX-License-Identifier: MIT

/**
 * Wire-protocol fixture suite (Node consumer).
 *
 * Drives sdk-node's HttpConfigFetcher against each case in
 * `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
 * corpus is the language-agnostic contract; this file is the Node-
 * specific consumer that maps Node's typed FetchOutcome / SdkErrorCode
 * vocabulary onto the corpus's normalised {fetched, notModified,
 * failed} × {fetchFailed, timeout, parseFailed, invalidSdkKey}
 * vocabulary.
 *
 * See epic #146 (contract testing framework) + #148 (this suite).
 */

import { afterEach, beforeEach, describe, vi } from "vitest";

import { HttpConfigFetcher } from "../../src/config-fetcher.ts";
import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";
import { LoggerWrapper, NullLogger } from "@confeature/sdk-shared";
import wireCases from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases.json" with { type: "json" };
// Cases this SDK cannot pass yet, by name (1.4, #994): each runs as a STRICT
// expected failure, so the entry turns red the day the SDK passes the case.
import wirePending from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases-pending.json" with { type: "json" };
import {
  buildFetchSpy,
  capturedRequestFromSpy,
  sdkKeyFor,
  type WireCase,
  assertWireCase,
  pendingCasesFor,
  wireTestFor,
} from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE_URL = "https://cdn.example.test";

const wireTest = wireTestFor(pendingCasesFor(wirePending, "sdk-node"));

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wire-cases.json contract (Node)", () => {
  for (const wireCase of wireCases.cases as unknown as WireCase[]) {
    wireTest(wireCase.id)(wireCase.id, async () => {
      const { given, server } = wireCase;

      const fetchSpy = buildFetchSpy(server);
      vi.stubGlobal("fetch", fetchSpy);

      const logger = new LoggerWrapper(new NullLogger());
      const fetcher = new HttpConfigFetcher(given.baseUrl ?? BASE_URL, logger);
      const controller = new AbortController();
      // The corpus's given.sdkKey when the case pins one (#803, FR-003).
      const sdkKey = sdkKeyFor(wireCase, SDK_KEY);
      const outcome = await fetcher.fetchAsync(sdkKey, given.previousEtag, controller.signal);

      // ---- Request + outcome assertions: one shared definition (#783) ----
      const request = capturedRequestFromSpy(fetchSpy, server);
      assertWireCase(wireCase, outcome, request, sdkKey, CONFEATURE_SDK_VERSION);
    });
  }
});
