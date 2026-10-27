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
import { describe, expect, type Mock, test, vi } from "vitest";

import configBooleanBody from "../fixtures/config-v6.boolean.json" with { type: "json" };
import wireCasesCorpus from "../fixtures/wire-cases.json" with { type: "json" };
// FR-001's path for a key: the corpus oracle's ONE escaper (Go's
// `url.PathEscape`), shared with scripts/validate-wire-cases.ts.
import { fr001Path } from "./fr001-path.ts";

/** One HTTP round-trip the SDK MUST conform to (mirrors wire-cases.schema.json). */
export interface WireCase {
  id: string;
  description: string;
  given: {
    previousEtag: string | null;
    baseUrl?: string;
    sdkKey?: string;
    originScheme?: "https";
  };
  server: {
    behavior?: "respond" | "timeout" | "close-mid-response";
    /** The origin's FIRST answer (1.4, #994); the fields below are the target's. */
    redirect?: { status: number; location: string };
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
    downgradeTargetRequests?: number;
    failureReason?: string;
  };
}

/**
 * Every `given` / `expected` field this reader understands (schema 1.4). A
 * corpus field outside these sets FAILS the case (#803, FR-003): the next
 * expectation added to the corpus cannot be skipped silently by a reader that
 * predates it — which is how 12 native suites ignored `requestUrlPrefix` and
 * #803 went unseen. Add a field here only together with the code that reads it.
 */
const KNOWN_GIVEN_FIELDS: ReadonlySet<string> = new Set([
  "previousEtag",
  "baseUrl",
  "sdkKey",
  "originScheme",
]);
const KNOWN_EXPECTED_FIELDS: ReadonlySet<string> = new Set([
  "requestHeaderIfNoneMatch",
  "outcome",
  "resultingEtag",
  "errorClass",
  "hasConfig",
  "requestUrlPrefix",
  "requestPath",
  "downgradeTargetRequests",
  "failureReason",
]);

/** The pending list (`fixtures/wire-cases-pending.json`, 1.4, #994). */
export interface WirePendingManifest {
  pending: Record<string, { ticket: string; cases: string[] }>;
}

/**
 * The cases `sdkName` may not pass yet, as `wireTestFor` takes them (case id →
 * ticket). The TS reader READS every 1.4 field, so its proof that an entry is
 * still true is the strongest one: the case runs as a STRICT expected failure,
 * and turns the suite red the day the SDK passes it — the entry must then go.
 */
export function pendingCasesFor(
  manifest: WirePendingManifest,
  sdkName: string,
): Record<string, string> {
  const entry = manifest.pending[sdkName];
  return Object.fromEntries((entry?.cases ?? []).map((id) => [id, entry!.ticket]));
}

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
export function buildFetchSpy(server: WireCase["server"]): WireFetchSpy {
  if (server.redirect !== undefined) return buildRedirectSpy(server, server.redirect);
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

/** A fetch spy, plus — for a redirect case — every URL that reached the wire. */
export type WireFetchSpy = Mock & { wireLog?: string[] };

/**
 * The transport of a redirect case (1.4, #994): the origin's FIRST request
 * gets `server.redirect` (status + the resolved `Location`), every later
 * request gets the target answer (`server`). `{origin}` resolves to the
 * request's own authority and `{samePath}` to its path and query, so the
 * downgrade target is the same host on `http:` — told apart by scheme.
 *
 * It honours the fetch `redirect` mode the way a SERVER runtime's fetch does
 * (undici, bun, deno, workerd — none refuses a downgrade): `"manual"` hands
 * the 30x to the SDK, `"error"` rejects, and `"follow"` (the default) follows
 * the Location itself — so an SDK that leaves following to the runtime sends
 * the keyed URL to the http target, and `wireLog` records it. A mock that
 * never followed would let such an SDK pass the refused case unseen.
 */
function buildRedirectSpy(
  server: WireCase["server"],
  redirect: NonNullable<WireCase["server"]["redirect"]>,
): WireFetchSpy {
  if ((server.behavior ?? "respond") !== "respond") {
    throw new Error("wire-cases: server.redirect is defined only with behavior respond");
  }
  const wireLog: string[] = [];
  const target = (): Response =>
    new Response(resolveBody(server), { status: server.status, headers: server.headers });
  const spy = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    wireLog.push(url);
    if (wireLog.length > 1) return target();
    const origin = new URL(url);
    const location = redirect.location
      .replace("{origin}", origin.host)
      .replace("{samePath}", origin.pathname + origin.search);
    switch (init?.redirect ?? (input instanceof Request ? input.redirect : "follow")) {
      case "manual":
        return new Response(null, { status: redirect.status, headers: { Location: location } });
      case "error":
        throw new TypeError("fetch failed: redirect mode is 'error'");
      default:
        // What the runtime does on its own: send the Location. No scheme check.
        wireLog.push(location);
        return target();
    }
  });
  return Object.assign(spy, { wireLog });
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
  | { status: "failed"; errorCode: string; errorMessage?: string };

/**
 * The request the SDK sent, SDK-neutral: a hermetic suite builds it from its
 * fetch spy, a live runner from the harness's `GET /admin/requests`.
 */
export interface CapturedRequest {
  /** Absolute (hermetic) or path + query (live, as the harness saw it). */
  url: string;
  /** The `If-None-Match` sent, or null when the request carried none. */
  ifNoneMatch: string | null;
  /**
   * Requests that reached the http downgrade target (redirect cases, 1.4) —
   * counted by the transport, never reported by the SDK. Undefined when the
   * transport served no redirect: a redirect case then FAILS.
   */
  downgradeTargetRequests?: number;
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
  // ---- Redirects (1.4, #994) --------------------------------------------
  if (given.originScheme !== undefined) {
    // An absolute URL is required: a path-only one cannot show its scheme.
    expect(new URL(request.url).protocol, `${id}: origin scheme`).toBe(`${given.originScheme}:`);
  }
  if (wireCase.server.redirect !== undefined) {
    expect(
      request.downgradeTargetRequests,
      `${id}: the transport served the redirect and counted the downgrade target`,
    ).toBeTypeOf("number");
  }
  if (expected.downgradeTargetRequests !== undefined) {
    expect(request.downgradeTargetRequests, `${id}: requests to the http downgrade target`).toBe(
      expected.downgradeTargetRequests,
    );
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
        if (expected.failureReason !== undefined) {
          // Fixed and key-free: the token, never the key, never a URL.
          const reason = outcome.errorMessage ?? "";
          expect(reason.toLowerCase(), `${id}: failure reason`).toContain(expected.failureReason);
          expect(reason, `${id}: the reason carries the SDK key`).not.toContain(sdkKey);
          expect(reason, `${id}: the reason carries a URL`).not.toContain("://");
        }
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
  fetchSpy: WireFetchSpy,
  server: WireCase["server"],
): CapturedRequest {
  if (server.redirect !== undefined) {
    // A redirect case: the ORIGIN request is the first one on the wire; the
    // rest are hops, and the http ones are the downgrade target's hits.
    const wireLog = fetchSpy.wireLog;
    if (wireLog === undefined)
      throw new Error("a redirect case needs buildFetchSpy's redirect transport");
    expect(fetchSpy).toHaveBeenCalled();
    const [, firstInit] = fetchSpy.mock.calls[0] as [unknown, RequestInit | undefined];
    return {
      url: wireLog[0]!,
      ifNoneMatch: new Headers(firstInit?.headers).get("If-None-Match"),
      downgradeTargetRequests: wireLog.slice(1).filter((url) => url.startsWith("http:")).length,
    };
  }
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

// ---------------------------------------------------------------------------
// The live wire-cases suite, shared (#925)
// ---------------------------------------------------------------------------

/** A recorded request, as `GET /admin/requests` lists it (the harness's own type). */
interface HarnessRequest extends CapturedRequest {}

// The harness's admin answers, cut down to what the suite reads. Declared here
// rather than imported: the harness depends on this package (the corpus), so
// importing its types back would make the two packages a cycle.
interface HarnessState {
  keys: string[];
  faults: Record<string, unknown>;
}
type HarnessRequests = { ok: true; requests: HarnessRequest[] } | { ok: false; error: string };

/** A config fetcher as an SDK's client wires it, judged by `assertWireCase`. */
export interface LiveWireFetcher {
  fetchAsync(
    previousEtag: string | null,
    signal: AbortSignal,
  ): Promise<WireFetchOutcome & { errorMessage?: string }>;
}

export interface LiveWireSuiteOptions {
  /** The SDK under test, as the suite names it (`sdk-bun`, …). */
  sdkName: string;
  /** The version the SDK stamps on its requests (`?sdk=`). */
  sdkVersion: string;
  /** Build the SDK's fetcher for a key, against the harness, with its own deadline. */
  createFetcher: (harnessUrl: string, sdkKey: string, requestTimeoutMs?: number) => LiveWireFetcher;
  /** Known SDK bugs, as STRICT expected failures: case id → ticket (#783 A7). */
  knownSdkBugs?: Readonly<Record<string, string>>;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Register an SDK's live wire-cases suite (#919, shared since #925): every
 * case the RUNNING live-contract harness seeds is replayed over real HTTP with
 * the SDK's own fetcher and judged by `assertWireCase`, the function the
 * hermetic suite uses.
 *
 *   - The case set comes from the harness (`GET /admin/state` → `keys`).
 *   - Each fetch must add exactly one entry to `GET /admin/requests`, so a
 *     retrying SDK, or a request logged by an earlier run, cannot stand in for
 *     the one under test.
 *   - A timeout case is ended by the SDK's OWN deadline (a quarter of the
 *     harness's hold), never by an abort the test fires.
 *   - US4: one unseeded key reaches the Worker's own unknown-key answer.
 *
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset. When it
 * is set without `LIVE_HARNESS_URL`, or the harness does not answer, this
 * REJECTS at module load (await it at top level); it never skips and never
 * boots a harness of its own.
 */
export async function defineLiveWireSuite(options: LiveWireSuiteOptions): Promise<void> {
  const env = options.env ?? process.env;
  const live = env.CONFEATURE_LIVE === "1";
  const harnessUrl = (env.LIVE_HARNESS_URL ?? "").replace(/\/$/, "");
  const wireTest = wireTestFor(options.knownSdkBugs ?? {});

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${harnessUrl}${path}`);
    if (!res.ok) throw new Error(`harness ${path} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  if (live && !harnessUrl) {
    throw new Error(
      "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " +
        "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping",
    );
  }
  const state = live ? await getJson<HarnessState>("/admin/state") : undefined;
  const caseIds = [...(state?.keys ?? [])].sort();
  const corpusById = new Map(
    (wireCasesCorpus.cases as unknown as WireCase[]).map((c) => [c.id, c] as const),
  );

  async function requestsFor(sdkKey: string): Promise<HarnessRequest[]> {
    const body = await getJson<HarnessRequests>(
      `/admin/requests?sdkKey=${encodeURIComponent(sdkKey)}`,
    );
    if (!body.ok) throw new Error(`harness refused /admin/requests: ${body.error}`);
    return body.requests;
  }

  describe.skipIf(!live)(`${options.sdkName} live wire-cases against the harness (#919)`, () => {
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
          const fault = state!.faults[id] as { kind?: string; ms?: number } | undefined;
          holdMs = typeof fault === "object" && fault?.kind === "timeout" ? fault.ms : undefined;
          if (holdMs === undefined) throw new Error(`${id} is seeded without a timeout fault`);
        }

        // The harness seeds each case under its id; a case that pins
        // given.sdkKey is configured with that key instead (#803, FR-003).
        const sdkKey = sdkKeyFor(wireCase, id);
        const before = (await requestsFor(sdkKey)).length;
        const startedAt = Date.now();
        const fetcher = options.createFetcher(
          harnessUrl,
          sdkKey,
          holdMs === undefined ? undefined : Math.floor(holdMs / 4),
        );
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
        assertWireCase(wireCase, outcome, log.at(-1)!, sdkKey, options.sdkVersion);
      });
    }

    test("an unseeded key reaches the Worker's own answer and reports invalidSdkKey (US4)", async () => {
      const outcome = await options
        .createFetcher(harnessUrl, "never-seeded-919")
        .fetchAsync(null, new AbortController().signal);
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(ERROR_CODE_TO_CLASS[outcome.errorCode]).toBe("invalidSdkKey");
        // The Worker's 403, not the fetcher refusing to send the key: the
        // harness logs only seeded keys, so the status is the proof it was sent.
        expect(outcome.errorMessage).toContain("(HTTP 403)");
      }
    });
  });
}
