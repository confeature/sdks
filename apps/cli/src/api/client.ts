// SPDX-License-Identifier: MIT

import { ExitCode } from "../cli/exit.ts";
import { CliError } from "../cli/errors.ts";

/**
 * Minimal HTTP client for the Confeature management API (spec 180 / #654).
 *
 * It joins paths onto the resolved `apiUrl` (#653 config `resolve`), attaches an
 * `Authorization: Bearer` header when a token is present, parses JSON bodies,
 * and surfaces transport / non-OK responses as a {@link CliError} (so the
 * router's dispatch boundary turns them into a clean stderr message + exit code
 * instead of a raw stack trace).
 *
 * SECURITY: the client NEVER logs a token, device_code, or user_code — no
 * request/response body or header is ever written to a sink here. Secrets flow
 * only through the typed return value, never through `console`.
 *
 * `fetch` is injectable so the command tests can drive the orchestration
 * against a stub without touching `globalThis.fetch` or the network.
 */

/** The subset of `fetch` the client uses — injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for constructing an {@link ApiClient}. */
export interface ApiClientOptions {
  /** The resolved management API base URL (from `resolveConfig().apiUrl`). */
  baseUrl: string;
  /** The bearer token to attach, when the profile is logged in. */
  token?: string | null;
  /** Injected `fetch` (defaults to the global). Tests pass a stub. */
  fetch?: FetchLike;
}

/**
 * Raised when the API returns a non-OK status and the caller did not opt into
 * handling that status itself. Carries the HTTP status so a caller (e.g. the
 * poll loop) can branch — but the default mapping is `RUNTIME`, with `401`
 * mapped to `AUTH` so an expired/revoked session surfaces the right exit code.
 */
export class ApiError extends CliError {
  readonly status: number;
  /** The parsed JSON error body, when the response carried one. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message, status === 401 ? ExitCode.AUTH : ExitCode.RUNTIME);
    this.status = status;
    this.body = body;
  }
}

/** Raised when the request never reached the server (DNS, connection, TLS). */
export class NetworkError extends CliError {
  constructor(detail: string) {
    super(`could not reach the API: ${detail}`, ExitCode.RUNTIME);
  }
}

/** The result of a raw request: status plus the parsed JSON body (or `null`). */
export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string | null;
  readonly #fetch: FetchLike;

  constructor(options: ApiClientOptions) {
    // Normalise away a trailing slash so `${base}${path}` never doubles up.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token ?? null;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Typed `GET` for the contract's list reads (spec 181 / #655). `T` is the
   * operation's 200 body type, threaded from the generated `operations` types at
   * the call site so the read shape is build-verified against the contract
   * (R11). A non-OK status throws {@link ApiError} (401 → `AUTH`), exactly like
   * {@link json}; this is just the GET-only, intent-revealing alias the read
   * commands call.
   */
  get<T>(path: string): Promise<T> {
    return this.json<T>(path, { method: "GET" });
  }

  /**
   * Typed `PUT` for the contract's value writes (spec 182 / #656 — the
   * `flag value update` toggle). `TRes` is the operation's 200 body type and
   * `body` is the operation's request body, both threaded from the generated
   * `operations` types at the call site so the write shape is build-verified
   * against the contract (R8). A non-OK status throws {@link ApiError}
   * (401 → `AUTH`), exactly like {@link json}.
   *
   * SECURITY: the body is serialised straight into the request — it is NEVER
   * written to a log sink (the value/reason flow only through the wire).
   */
  put<TRes>(path: string, body: unknown): Promise<TRes> {
    return this.json<TRes>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  /**
   * Typed `POST` for the contract's writes (spec 182 / #656 — the config
   * `publish` that makes a toggled value live). Same typing + redaction
   * contract as {@link put}; a `body` of `undefined` issues a bodiless POST
   * (e.g. `publish`, which reads no JSON body).
   */
  post<TRes>(path: string, body?: unknown): Promise<TRes> {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.json<TRes>(path, init);
  }

  /**
   * Typed `PATCH` for the contract's partial-update writes (#677 — the
   * `flag update` metadata patch). Same typing + redaction contract as
   * {@link put}; a non-OK status throws {@link ApiError} (401 → `AUTH`).
   */
  patch<TRes>(path: string, body: unknown): Promise<TRes> {
    return this.json<TRes>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  /**
   * Typed `DELETE` for the contract's removals (#677 — `flag delete`). A 204
   * carries no body, which {@link parseJsonBody} surfaces as `null`; the caller
   * threads the operation's response type (often `unknown`) since there is
   * nothing to read. A non-OK status throws {@link ApiError} (401 → `AUTH`).
   */
  delete<TRes>(path: string): Promise<TRes> {
    return this.json<TRes>(path, { method: "DELETE" });
  }

  /**
   * Issue a request and return the parsed body, throwing {@link ApiError} on a
   * non-OK status. Use this for the simple "succeed or fail" calls (`/v1/me`,
   * logout). For endpoints whose error bodies are meaningful (the device-token
   * poll), use {@link request} and branch on the status yourself.
   */
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request<T>(path, init);
    if (!res.ok) {
      const message = errorMessage(res.status, res.body);
      throw new ApiError(res.status, message, res.body);
    }
    return res.body;
  }

  /**
   * Issue a request and return the status + parsed body WITHOUT throwing on a
   * non-OK status — the caller decides. A transport failure still throws
   * {@link NetworkError}.
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
    const url = `${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.#token) {
      headers.set("Authorization", `Bearer ${this.#token}`);
    }

    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, headers });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new NetworkError(detail);
    }

    const body = (await parseJsonBody(res)) as T;
    return { status: res.status, ok: res.ok, body };
  }
}

/** Parse a response body as JSON, tolerating an empty / non-JSON body (→ null). */
async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON error page (proxy 502, etc.) — surface the raw text so the
    // error message is still useful, without logging any secret (there is none
    // in a server error page).
    return { error: text.slice(0, 200) };
  }
}

/** Build a human error message from a non-OK response (never includes secrets). */
function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    if (message) return message;
    if (error) return `request failed (${status}): ${error}`;
  }
  return `request failed with status ${status}`;
}
