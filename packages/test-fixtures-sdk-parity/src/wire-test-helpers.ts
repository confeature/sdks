// SPDX-License-Identifier: MIT

/**
 * Shared wire-case test helpers for the JS-family consumers
 * (sdk-node / sdk-browser-js / sdk-bun / sdk-deno).
 *
 * The corpus-shape type, the error-class mapping, and the mock-transport
 * builder are identical across those four `tests/wire/wire-cases.test.ts`
 * files; this module is the single source of truth (extracted #490
 * follow-up). The per-SDK part stays in each consumer: which
 * `HttpConfigFetcher` it constructs, the 2-arg vs 3-arg `fetchAsync`
 * signature, and its own version string, which `assertWireCase` pins in the
 * URL `?sdk=` param so each conformance gate captures the runtime identity.
 *
 * This file imports `vi` from vitest (a devDependency of this fixtures
 * package); it is reached ONLY via the `./wire-test-helpers` subpath from
 * test files, never from the package's main entry, so non-test consumers
 * never pull vitest in.
 */

import { SdkErrorCode } from "@confeature/sdk-shared";
import { expect, type Mock, test, vi } from "vitest";

import configBooleanBody from "../fixtures/config-v6.boolean.json" with { type: "json" };
// FR-001's path for a key: the corpus oracle's ONE escaper (Go's
// `url.PathEscape`), shared with scripts/validate-wire-cases.ts.
import { fr001Path } from "./fr001-path.ts";

/** One HTTP round-trip the SDK MUST conform to (mirrors wire-cases.schema.json). */
export interface WireCase {
  id: string;
  description: string;
  given: { previousEtag: string | null; baseUrl?: string; sdkKey?: string };
  server: {
    behavior?: "respond" | "timeout" | "close-mid-response";
    status: number;
    headers: Record<string, string>;
    bodyRef?: string | null;
    body?: string;
  };
  expected: {
    requestHeaderIfNoneMatch?: string | null;
    outcome: "fetched" | "notModified" | "failed";
    resultingEtag?: string | null;
    errorClass?: string;
    hasConfig: boolean;
    requestUrlPrefix?: string;
    requestPath?: string;
  };
}

/**
 * Every `given` / `expected` field this reader understands (schema 1.3). A
 * corpus field outside these sets FAILS the case (#803, FR-003): the next
 * expectation added to the corpus cannot be skipped silently by a reader that
 * predates it — which is how 12 native suites ignored `requestUrlPrefix` and
 * #803 went unseen. Add a field here only together with the code that reads it.
 */
const KNOWN_GIVEN_FIELDS: ReadonlySet<string> = new Set(["previousEtag", "baseUrl", "sdkKey"]);
const KNOWN_EXPECTED_FIELDS: ReadonlySet<string> = new Set([
  "requestHeaderIfNoneMatch",
  "outcome",
  "resultingEtag",
  "errorClass",
  "hasConfig",
  "requestUrlPrefix",
  "requestPath",
]);

/**
 * The SDK key a suite must configure its SDK with for a case: the corpus's
 * `given.sdkKey` when the case pins one, else the suite's own default.
 * `assertWireCase` fails when the key it is handed is not this one.
 */
export function sdkKeyFor(wireCase: WireCase, defaultKey: string): string {
  return wireCase.given.sdkKey ?? defaultKey;
}

/**
 * The path of a recorded request URL, as sent: still percent-encoded, query
 * and fragment excluded (#807 may add a query; the pins must not care). The
 * base resolves a live runner's path-only URL; an absolute URL ignores it.
 */
function requestPathOf(url: string): string {
  return new URL(url, "http://relative.invalid").pathname;
}

// Lookup table for `bodyRef`-resolved bodies. Lives here (not in the
// corpus JSON) because JS consumers resolve refs by importing the JSON
// module (Python reads from disk via repo root).
const FIXTURES_BY_REF: Record<string, unknown> = {
  "config-v6.boolean.json": configBooleanBody,
};

// Maps the shared SdkErrorCode onto the corpus's normalised errorClass
// vocabulary. Every code that can appear in a wire-case outcome MUST be
// mapped — an unmapped code surfaces as a clear test failure rather than
// a silent mis-classification.
export const ERROR_CODE_TO_CLASS: Record<string, string> = {
  [SdkErrorCode.FETCH_FAILED]: "fetchFailed",
  [SdkErrorCode.FETCH_TIMEOUT]: "timeout",
  [SdkErrorCode.PARSE_FAILED]: "parseFailed",
  [SdkErrorCode.INVALID_SDK_KEY]: "invalidSdkKey",
};

function resolveBody(server: WireCase["server"]): string | null {
  if (server.bodyRef != null) return JSON.stringify(FIXTURES_BY_REF[server.bodyRef]);
  if (server.body != null) return server.body;
  return null;
}

/**
 * Build the mock `fetch` for a case based on `server.behavior` (#490).
 * The behaviour adapter maps each value onto a fetch-mock primitive:
 *   - respond            → resolve a Response with status/headers/body;
 *   - timeout            → reject with an AbortError, which every fetcher
 *                          maps to FETCH_TIMEOUT → "timeout";
 *   - close-mid-response → resolve a Response whose body stream errors
 *                          mid-read, so response.text() throws → the
 *                          fetcher maps it to FETCH_FAILED → "fetchFailed".
 * An unrecognised behaviour FAILS LOUDLY — it MUST NEVER fall through to
 * the respond path and silently mis-pass (FR-008 anti-false-green guard).
 */
export function buildFetchSpy(server: WireCase["server"]): Mock {
  switch (server.behavior ?? "respond") {
    case "respond": {
      const response = new Response(resolveBody(server), {
        status: server.status,
        headers: server.headers,
      });
      return vi.fn().mockResolvedValueOnce(response);
    }
    case "timeout":
      return vi.fn().mockImplementationOnce(() => {
        const err = new Error("Config fetch aborted (simulated timeout).");
        err.name = "AbortError";
        return Promise.reject(err);
      });
    case "close-mid-response": {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"p":{"s":"partial'));
          controller.error(new TypeError("network connection reset mid-response"));
        },
      });
      const response = new Response(stream, {
        status: server.status,
        headers: server.headers,
      });
      return vi.fn().mockResolvedValueOnce(response);
    }
    default:
      throw new Error(
        `wire-cases: unsupported server.behavior ${JSON.stringify(server.behavior)} — ` +
          "no adapter; refusing to fall through to the respond path",
      );
  }
}

// ---------------------------------------------------------------------------
// assertWireCase — what a corpus `expected` block means, for the JS family
// (#783, decision row 5). ONE implementation, called by the four hermetic
// suites (sdk-node / browser-js / bun / deno) AND by the sdk-node live runner,
// so a mocked fetch and a real HTTP round-trip are judged by the same rules.
// ---------------------------------------------------------------------------

/** The outcome every JS-family `HttpConfigFetcher.fetchAsync` resolves to. */
export type WireFetchOutcome =
  | { status: "fetched"; configJson: unknown; eTag: string | null }
  | { status: "notModified"; eTag: string | null }
  | { status: "failed"; errorCode: string };

/**
 * The request the SDK sent, SDK-neutral: a hermetic suite builds it from its
 * fetch spy, a live runner from the harness's `GET /admin/requests`.
 */
export interface CapturedRequest {
  /** Absolute (hermetic) or path + query (live, as the harness saw it). */
  url: string;
  /** The `If-None-Match` sent, or null when the request carried none. */
  ifNoneMatch: string | null;
}

export function assertWireCase(
  wireCase: WireCase,
  outcome: WireFetchOutcome,
  request: CapturedRequest,
  sdkKey: string,
  sdkVersion: string,
): void {
  const { expected, given } = wireCase;
  const id = wireCase.id;

  // ---- Fail closed on what this reader does not know (#803, FR-003) ----
  const unknownGiven = Object.keys(given).filter((field) => !KNOWN_GIVEN_FIELDS.has(field));
  expect(unknownGiven, `${id}: given fields this reader does not read`).toEqual([]);
  const unknownExpected = Object.keys(expected).filter(
    (field) => !KNOWN_EXPECTED_FIELDS.has(field),
  );
  expect(unknownExpected, `${id}: expected fields this reader does not read`).toEqual([]);
  if (given.sdkKey !== undefined) {
    // The suite, not this function, configures the SDK: a suite that ignored
    // `given.sdkKey` would make every path check below vacuous.
    expect(sdkKey, `${id}: the SDK must be configured with given.sdkKey`).toBe(given.sdkKey);
  }

  // ---- Request side ----------------------------------------------------
  // The parsed path, compared EXACTLY: the corpus's `requestPath` when the
  // case pins one (its single home), else FR-001's path for the suite's key.
  expect(requestPathOf(request.url), `${id}: request path`).toBe(
    expected.requestPath ?? fr001Path(sdkKey),
  );
  expect(request.url, `${id}: legacy /v2/ path`).not.toContain("/v2/");
  expect(sdkParam(request.url), `${id}: ?sdk= param`).toBe(sdkVersion);
  if (expected.requestUrlPrefix != null) {
    expect(request.url.startsWith(expected.requestUrlPrefix), `${id}: base URL`).toBe(true);
  }
  if (expected.requestHeaderIfNoneMatch !== undefined) {
    expect(request.ifNoneMatch, `${id}: If-None-Match`).toBe(expected.requestHeaderIfNoneMatch);
  }

  // ---- Outcome side ---------------------------------------------------
  const hasConfig = outcome.status === "fetched" && outcome.configJson != null;
  expect(hasConfig, `${id}: hasConfig`).toBe(expected.hasConfig);
  switch (expected.outcome) {
    case "fetched":
      expect(outcome.status, `${id}: outcome`).toBe("fetched");
      if (outcome.status === "fetched") {
        expect(outcome.eTag, `${id}: resulting ETag`).toBe(expected.resultingEtag ?? null);
        // Content, not presence: a fetched case with a bodyRef must yield
        // exactly that fixture — otherwise "fetched" proves only that bytes
        // arrived, and a wrong config would pass.
        const ref = wireCase.server.bodyRef;
        if (ref != null) {
          if (!(ref in FIXTURES_BY_REF)) throw new Error(`${id}: unknown bodyRef ${ref}`);
          expect(outcome.configJson, `${id}: config is ${ref}`).toEqual(FIXTURES_BY_REF[ref]);
        }
      }
      break;
    case "notModified":
      expect(outcome.status, `${id}: outcome`).toBe("notModified");
      if (outcome.status === "notModified") {
        expect(outcome.eTag, `${id}: resulting ETag`).toBe(expected.resultingEtag ?? null);
      }
      break;
    case "failed":
      expect(outcome.status, `${id}: outcome`).toBe("failed");
      if (outcome.status === "failed") {
        const mapped = ERROR_CODE_TO_CLASS[outcome.errorCode];
        expect(mapped, `${id}: errorCode ${outcome.errorCode} is mapped`).toBeDefined();
        expect(mapped, `${id}: errorClass`).toBe(expected.errorClass);
      }
      break;
    default: {
      // A corpus outcome this function does not know must FAIL, never pass
      // silently — the hermetic switch this replaces had no default.
      const unknown: never = expected.outcome;
      throw new Error(`${id}: unmapped corpus outcome ${JSON.stringify(unknown)}`);
    }
  }
}

/** The raw `sdk` query value of a request URL (absolute or path + query). */
function sdkParam(url: string): string | undefined {
  const query = url.split("?")[1] ?? "";
  return query
    .split("&")
    .find((pair) => pair.startsWith("sdk="))
    ?.slice("sdk=".length);
}

/**
 * The one request a hermetic suite's fetch spy received, SDK-neutral. Asserts
 * exactly one call, reads `If-None-Match` case-insensitively (a plain object,
 * a `Headers`, or tuples — the SDK's choice must not decide the verdict), and
 * for a `timeout` case that the SDK threaded an abort signal into fetch: that
 * is how a real request-budget timeout aborts the call (#490).
 */
export function capturedRequestFromSpy(
  fetchSpy: Mock,
  server: WireCase["server"],
): CapturedRequest {
  expect(fetchSpy).toHaveBeenCalledOnce();
  const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [unknown, RequestInit | undefined];
  if (server.behavior === "timeout") {
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
  }
  return {
    url: String(calledUrl),
    ifNoneMatch: new Headers(calledInit?.headers).get("If-None-Match"),
  };
}

/**
 * Pick `test` or a STRICT expected failure for a case, from the SDK's own
 * list of known SDK bugs (case id → ticket). `test.fails` turns red the moment
 * the bug is fixed, so an entry can never outlive its reason (#783 A7). This
 * list is for SDK defects; cases that cannot be seeded at all live in the
 * harness's NOT_REPRESENTABLE instead.
 */
export function wireTestFor(
  knownSdkBugs: Readonly<Record<string, string>>,
): (caseId: string) => typeof test | typeof test.fails {
  return (caseId) => (caseId in knownSdkBugs ? test.fails : test);
}
