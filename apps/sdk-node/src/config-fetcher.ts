// SPDX-License-Identifier: MIT

import {
  buildConfigUrl,
  isConfigShape,
  type IConfig,
  type LoggerWrapper,
} from "@confeature/sdk-shared";
import { SdkErrorCode } from "./types.ts";
import { CONFEATURE_SDK_VERSION } from "./version.ts";

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
  // No `exception`: a library error may quote the URL, which holds the SDK
  // key — failures carry a fixed, key-free message only (#803, FR-002).
  | { status: "failed"; errorCode: SdkErrorCode; errorMessage: string };

/**
 * HTTP fetcher contract. Implementations MUST resolve the returned
 * promise with a {@link FetchOutcome} — they MUST NOT reject. Errors
 * are encoded as `status: "failed"` so the caller's hot path never has
 * to wrap the call in a try/catch (matches `configcat-common`'s
 * IConfigFetcher contract).
 */
export interface IConfigFetcher {
  fetchAsync(sdkKey: string, eTag: string | null, signal: AbortSignal): Promise<FetchOutcome>;
}

/**
 * Global-`fetch`-backed config fetcher. Sends an `If-None-Match` header
 * when `eTag` is non-null so the CDN can answer with 304. The URL comes
 * from `@confeature/sdk-shared`'s {@link buildConfigUrl} — the federation's
 * one builder (#803, FR-001): ConfigCat's CDN path, a well-shaped key raw,
 * any other key Go-`url.PathEscape`d into one segment, and `null` (never a
 * throw) for a key no segment can hold. The URL holds the key, so it MUST
 * NEVER reach a log line or a fetch result (FR-002).
 *
 * Caller owns the `AbortSignal` lifetime — the fetcher honours it for
 * timeout + dispose semantics but does not create its own controller.
 */
export class HttpConfigFetcher implements IConfigFetcher {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: LoggerWrapper,
  ) {}

  async fetchAsync(
    sdkKey: string,
    eTag: string | null,
    signal: AbortSignal,
  ): Promise<FetchOutcome> {
    const url = buildConfigUrl(this.baseUrl, sdkKey, CONFEATURE_SDK_VERSION);
    if (url === null) {
      // No request at all: the key cannot be put in a path (FR-001).
      this.logger.invalidSdkKey(sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.INVALID_SDK_KEY,
        errorMessage: "SDK key cannot be sent in a request path; no request was made.",
      };
    }

    const headers: Record<string, string> = {};
    if (eTag) headers["If-None-Match"] = eTag;

    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, signal });
    } catch (err) {
      // AbortError is the SDK's caller (timeout OR dispose). The caller
      // decides whether to log FETCH_TIMEOUT or to stay silent.
      if (isAbortError(err)) {
        return {
          status: "failed",
          errorCode: SdkErrorCode.FETCH_TIMEOUT,
          errorMessage: "Config fetch aborted (timeout or dispose).",
        };
      }
      // FR-002: only a fixed reason travels on — never `err`, whose message
      // or cause may quote the URL, and the URL holds the key.
      const reason = classifyFetchError(err);
      this.logger.fetchFailed(sdkKey, reason);
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: `Network error while fetching config (${reason}).`,
      };
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
      this.logger.invalidSdkKey(sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.INVALID_SDK_KEY,
        errorMessage: `SDK key not recognised by the CDN (HTTP ${String(response.status)}).`,
      };
    }

    if (!response.ok) {
      this.logger.fetchFailed(sdkKey, response.status);
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: `Unexpected HTTP status ${String(response.status)}.`,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      const reason = isAbortError(err) ? "aborted" : classifyFetchError(err);
      this.logger.fetchFailed(sdkKey, `${String(response.status)}, body ${reason}`);
      return {
        status: "failed",
        errorCode: SdkErrorCode.FETCH_FAILED,
        errorMessage: `Failed to read response body (${reason}).`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parser's message quotes the body; the fixed message is enough.
      this.logger.parseError(sdkKey);
      return {
        status: "failed",
        errorCode: SdkErrorCode.PARSE_FAILED,
        errorMessage: "Config payload is not valid JSON.",
      };
    }

    if (!isConfigShape(parsed)) {
      this.logger.parseError(sdkKey);
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

/**
 * FR-002 (#803): reduce a transport error to a short, FIXED, key-free reason
 * code — Go's `classifyError` pattern (apps/sdk-go/internal/configfetcher).
 * Node's `fetch` (undici) wraps every failure in `TypeError("fetch failed")`
 * with the real error as `cause`; only its `code` (or the one known redirect
 * message) is read, and only ever to pick a constant from this closed set.
 * Nothing of the error's text is returned.
 */
export function classifyFetchError(err: unknown): string {
  for (const e of [err, causeOf(err)]) {
    if (typeof e !== "object" || e === null) continue;
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof message === "string" && /redirect count exceeded/i.test(message)) {
      return "redirect_loop";
    }
    if (typeof code !== "string") continue;
    switch (code) {
      case "ECONNRESET":
      case "EPIPE":
      case "UND_ERR_SOCKET":
      case "UND_ERR_CLOSED":
        return "connection_reset";
      case "ECONNREFUSED":
        return "connection_refused";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "dns_failure";
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
      case "UND_ERR_HEADERS_TIMEOUT":
      case "UND_ERR_BODY_TIMEOUT":
        return "transport_timeout";
      default:
        if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code)) {
          return "tls_failure";
        }
    }
  }
  return "network_error";
}

function causeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
}
