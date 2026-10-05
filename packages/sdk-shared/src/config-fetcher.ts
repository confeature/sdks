// SPDX-License-Identifier: MIT

import { isConfigShape, type IConfig } from "./config-json.ts";
import type { LoggerWrapper } from "./logger.ts";
import { isValidConfeatureKeyFormat } from "./sdk-key.ts";
import { SdkErrorCode } from "./types.ts";

/**
 * Outcome of a fetch attempt — successful 200 / 304, or a typed failure.
 *
 * On 304 the body is not re-parsed (zero allocations in the parser path),
 * and `configJson` is `null`; the caller MUST preserve the previously
 * cached payload and only refresh the `fetchTime` stamp.
 */
export type FetchOutcome =
  | { status: "fetched"; configJson: IConfig; eTag: string | null }
  | { status: "notModified"; eTag: string | null }
  | { status: "failed"; errorCode: SdkErrorCode; errorMessage: string; exception?: unknown };

/**
 * Go's `url.PathEscape` (the federation's reference escaper, FR-001): keeps
 * `A-Z a-z 0-9 - _ . ~` and `$ & + : = @`, `%XX`-escapes (uppercase) every
 * other UTF-8 byte. `encodeURIComponent` differs on exactly eleven bytes: it
 * also keeps `! ' ( ) *` and escapes `$ & + : = @`. Throws `URIError` on a
 * lone surrogate (no UTF-8 encoding) — {@link buildConfigUrl} refuses it.
 */
const pathEscape = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]|%(?:2[46B]|3[AD]|40)/g, (m) =>
    m[0] === "%" ? decodeURIComponent(m) : `%${m.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * FR-001 (#803): the ONE function that builds the config URL — ConfigCat's
 * `<baseUrl>/configuration-files/<sdkKey>/config_v6.json?sdk=<version>`
 * (configcat-common `ConfigCatClientOptions.js` `getUrl`, which puts the key
 * in the path raw).
 *
 *  - A well-shaped key ({@link isValidConfeatureKeyFormat}) travels RAW: its
 *    `/`-separated parts, each segment-escaped (a no-op for a valid key), so a
 *    `configcat-sdk-1/<a>/<b>` key is the exact bytes a stock ConfigCat SDK
 *    sends.
 *  - Any other key is escaped into ONE segment, so it cannot leave it — Go
 *    `url.PathEscape`'s bytes exactly (`pathEscape`).
 *  - Returns `null` — the caller MUST NOT fetch — for a key no escaper keeps
 *    inside its segment: `""`, `.`, `..` (and an unencodable lone surrogate).
 *
 * The URL holds the key, so nothing derived from a request (an exception, its
 * message) may reach a log or a {@link FetchOutcome} — see `fetchAsync`.
 */
export function buildConfigUrl(baseUrl: string, sdkKey: string, sdkVersion: string): string | null {
  let keyPath: string;
  try {
    keyPath = isValidConfeatureKeyFormat(sdkKey)
      ? sdkKey.split("/").map(pathEscape).join("/")
      : pathEscape(sdkKey);
  } catch {
    return null; // URIError: a lone surrogate has no UTF-8 encoding
  }
  if (keyPath === "" || keyPath === "." || keyPath === "..") return null;
  return `${baseUrl}/configuration-files/${keyPath}/config_v6.json?sdk=${sdkVersion}`;
}

/**
 * HTTP fetcher contract. Implementations MUST resolve the returned
 * promise with a {@link FetchOutcome} — they MUST NOT reject. Errors
 * are encoded as `status: "failed"` so the caller's hot path never has
 * to wrap the call in a try/catch (matches `configcat-common`'s
 * IConfigFetcher contract).
 *
 * The SDK key + version are bound at construction time so per-call
 * signatures stay symmetrical across modes and the key never leaks
 * through unintended parameter paths.
 */
export interface IConfigFetcher {
  fetchAsync(eTag: string | null, signal: AbortSignal): Promise<FetchOutcome>;
}

/**
 * `globalThis.fetch`-backed config fetcher shared by every WHATWG-fetch
 * SDK (browser, Bun, Deno). Sends an `If-None-Match` header when `eTag`
 * is non-null so the CDN can answer with 304. The URL comes from
 * {@link buildConfigUrl} — ConfigCat's CDN path, the key raw.
 *
 * FR-002 (#803): the request URL carries the SDK key, and a runtime's fetch
 * error may quote it (Deno: "error sending request for url (…)"). Every
 * failure is therefore reduced to a FIXED, key-free reason before it reaches
 * the logger or the outcome; no exception is logged or forwarded.
 *
 * Caller owns the `AbortSignal` lifetime — the fetcher honours it for
 * timeout + dispose semantics but does not create its own controller.
 *
 * Runtime requirements: WHATWG `globalThis.fetch`, `AbortController`,
 * `setTimeout`. The sdk-node package uses a different (undici/node:http)
 * stack and ships its own per-package fetcher; it does NOT consume this
 * class.
 */
export class HttpConfigFetcher implements IConfigFetcher {
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly sdkKey: string,
    private readonly sdkVersion: string,
    private readonly logger: LoggerWrapper,
    requestTimeoutMs?: number,
  ) {
    this.requestTimeoutMs = requestTimeoutMs ?? 10_000;
  }

  async fetchAsync(eTag: string | null, signal: AbortSignal): Promise<FetchOutcome> {
    const url = buildConfigUrl(this.baseUrl, this.sdkKey, this.sdkVersion);
    if (url === null) {
      this.logger.invalidSdkKey(this.sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.INVALID_SDK_KEY,
        errorMessage: "SDK key cannot be sent in a request path; no request made.",
      };
    }

    const headers: Record<string, string> = {};
    if (eTag) headers["If-None-Match"] = eTag;

    // Layered AbortController — combine the caller's signal with our own
    // timeout signal so the fetcher honours BOTH dispose() and timeout
    // without leaking timers. `requestTimeoutMs` is configurable per
    // instance (default 10_000 ms).
    const ac = new AbortController();
    const onCallerAbort = () => {
      try {
        ac.abort();
      } catch {
        /* swallow — AbortController.abort is spec-noexcept anyway */
      }
    };
    if (signal.aborted) {
      onCallerAbort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timeoutHandle = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        /* swallow */
      }
    }, this.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, signal: ac.signal });
    } catch (err) {
      // Key-free by construction: only the error's name is inspected.
      if (isAbortError(err)) {
        return {
          status: "failed",
          errorCode: SdkErrorCode.FETCH_TIMEOUT,
          errorMessage: "Config fetch aborted (timeout or dispose).",
        };
      }
      this.logger.fetchFailed(this.sdkKey, "network");
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: "Network error while fetching config.",
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onCallerAbort);
    }

    // 304 Not Modified — fast path, no body parse.
    if (response.status === 304) {
      return { status: "notModified", eTag: response.headers.get("ETag") ?? eTag };
    }

    // ConfigCat parity: BOTH 403 and 404 mean "your SDK Key seems to be
    // wrong" — a non-retryable invalid-key signal, distinct from a generic
    // (retryable) fetch failure. configcat-js classes 403/404 together; we
    // match that (#336). Every other non-2xx falls through to fetchFailed.
    if (response.status === 404 || response.status === 403) {
      this.logger.invalidSdkKey(this.sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.INVALID_SDK_KEY,
        errorMessage: `SDK key not recognised by the CDN (HTTP ${String(response.status)}).`,
      };
    }

    if (!response.ok) {
      this.logger.fetchFailed(this.sdkKey, response.status);
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: `Unexpected HTTP status ${String(response.status)}.`,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      this.logger.fetchFailed(this.sdkKey, "body-read");
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: "Failed to read response body.",
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger.parseError(this.sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.PARSE_FAILED,
        errorMessage: "Config payload is not valid JSON.",
      };
    }

    if (!isConfigShape(parsed)) {
      this.logger.parseError(this.sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.PARSE_FAILED,
        errorMessage: "Config payload does not match the expected {p,f,s} shape.",
      };
    }

    return {
      status: "fetched",
      configJson: parsed,
      eTag: response.headers.get("ETag") ?? null,
    };
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; code?: unknown };
    if (e.name === "AbortError") return true;
    if (e.code === "ABORT_ERR") return true;
  }
  return false;
}
