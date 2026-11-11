// SPDX-License-Identifier: MIT

import type { paths } from "@confeature/contract/api";
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
 * THE CLI'S API PATHS LIVE HERE (#1188). Every call names a path template from
 * the generated contract's `paths` (`"/v1/configs/{configId}"`), its parameters
 * as an object, and a method that path declares; the types refuse any other
 * path, a missing or extra parameter, and a method the path does not have. So
 * a path renamed or removed in the contract fails the CLI's type check instead
 * of 404ing at run time. The commands never build a path by hand: a test
 * (`tests/api_paths_test.ts`) refuses a template-string or concatenated path in
 * `src/cli/commands/`.
 *
 * Why a small typed layer over `paths` and not `openapi-fetch`: the CLI is a
 * compiled Deno binary with no npm dependency, and the layer is a few types
 * plus one encoder. It also keeps each call site's response type (`T`) its
 * own, which `openapi-fetch` would infer from the contract: some commands read
 * an answer wider than the contract on purpose, to work on both sides of an
 * api release (`flag ls`, the per-key setting reads).
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
  /**
   * The response headers, so a caller can read a signal the api sends there —
   * the `Retry-After` of a value write that is saved but not live yet (#933).
   */
  readonly headers: Headers;

  constructor(status: number, message: string, body: unknown, headers: Headers = new Headers()) {
    super(message, status === 401 ? ExitCode.AUTH : ExitCode.RUNTIME);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Raised when the request never reached the server (DNS, connection, TLS). */
export class NetworkError extends CliError {
  constructor(detail: string) {
    super(`could not reach the API: ${detail}`, ExitCode.RUNTIME);
  }
}

/** The result of a raw request: status, headers, and the parsed JSON body (or `null`). */
export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  body: T;
  headers: Headers;
}

/**
 * The HTTP methods the client speaks, spelled as the generated `paths` spells
 * them: a path declares a method by carrying an operation under its key.
 */
export type HttpMethod = "get" | "put" | "post" | "patch" | "delete";

/** The operation `P` declares for `M`, or `never` when `P` does not declare `M`. */
type OperationOf<P extends keyof paths, M extends HttpMethod> = paths[P] extends
  { [K in M]: infer Op } ? Op : never;

/** An operation's `parameters` block. */
type ParametersOf<Op> = Op extends { parameters: infer Params } ? Params : never;

/**
 * Whether the client can call the operation at all: it sends no header or
 * cookie parameter, so an operation that requires one is not callable here.
 */
type Callable<Op> = ParametersOf<Op> extends { header: object } | { cookie: object } ? false
  : true;

/** Every contract path that declares `M` with an operation this client can send. */
export type ApiPath<M extends HttpMethod> = {
  [P in keyof paths]: [OperationOf<P, M>] extends [never] ? never
    : Callable<OperationOf<P, M>> extends true ? P
    : never;
}[keyof paths];

/** The `{name}` placeholders of a path template, as a union of names. */
type Placeholders<P extends string> = P extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/**
 * The path parameters: required, and typed by the operation, whenever the
 * template has a placeholder; forbidden when it has none.
 */
type PathOption<P extends string, Op> = [Placeholders<P>] extends [never] ? { path?: never }
  : {
    path: ParametersOf<Op> extends { path: infer Declared } ? Declared
      : Record<Placeholders<P>, string>;
  };

/** The query parameters the operation declares, or none. */
type QueryOption<Op> = ParametersOf<Op> extends { query: infer Query } ? { query: Query }
  : ParametersOf<Op> extends { query?: infer Query }
    ? [NonNullable<Query>] extends [never] ? { query?: never } : { query?: NonNullable<Query> }
  : { query?: never };

/**
 * The JSON body the operation declares: required, optional, or forbidden. An
 * operation whose body is not JSON is not callable through this client.
 */
type BodyOption<Op> = Op extends { requestBody?: never } ? { body?: never }
  : Op extends { requestBody: { content: { "application/json": infer Body } } } ? { body: Body }
  : Op extends { requestBody?: { content: { "application/json": infer Body } } } ? { body?: Body }
  : never;

/** What one call of `M` on `P` takes besides the path itself. */
export type CallOptions<M extends HttpMethod, P extends ApiPath<M>> =
  & PathOption<P, OperationOf<P, M>>
  & QueryOption<OperationOf<P, M>>
  & BodyOption<OperationOf<P, M>>;

/** One call's arguments: the options may be left out only when nothing in them is required. */
type CallOf<M extends HttpMethod, P extends ApiPath<M>> = Record<never, never> extends
  CallOptions<M, P> ? [path: P, options?: CallOptions<M, P>]
  : [path: P, options: CallOptions<M, P>];

/**
 * Every valid `(path, options)` argument list for `M`: one tuple per path that
 * declares `M`, so the path literal picks the tuple and its options are checked
 * against that path's operation.
 */
export type ApiCall<M extends HttpMethod> = { [P in ApiPath<M>]: CallOf<M, P> }[ApiPath<M>];

/** `[method, path, options]` for any method: the argument list of {@link ApiClient.request}. */
export type AnyApiCall = { [M in HttpMethod]: [method: M, ...ApiCall<M>] }[HttpMethod];

/** The shape every typed call reduces to at run time. */
interface RuntimeOptions {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
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
   * Typed `GET` (spec 181 / #655). The path is a template from the contract's
   * `paths`, with its parameters (see {@link expandPath}). `T` is the
   * operation's 200 body type, threaded from the generated `operations` types
   * at the call site so the read shape is build-verified against the contract
   * (R11). A non-OK status throws {@link ApiError} (401 → `AUTH`).
   */
  get<T>(...call: ApiCall<"get">): Promise<T> {
    return this.#json<T>("get", call);
  }

  /**
   * Typed `PUT` for the contract's value writes (spec 182 / #656 — the
   * `flag value update` toggle). The body is the operation's request body,
   * checked against the contract by the path. A non-OK status throws
   * {@link ApiError} (401 → `AUTH`).
   *
   * SECURITY: the body is serialised straight into the request — it is NEVER
   * written to a log sink (the value/reason flow only through the wire).
   */
  put<TRes>(...call: ApiCall<"put">): Promise<TRes> {
    return this.#json<TRes>("put", call);
  }

  /**
   * Typed `POST` for the contract's writes (the creates, `member invite`,
   * `sdk-key rotate`, the device flow). Same typing + redaction contract as
   * {@link put}; an operation that declares no body issues a bodiless POST.
   */
  post<TRes>(...call: ApiCall<"post">): Promise<TRes> {
    return this.#json<TRes>("post", call);
  }

  /**
   * Typed `PATCH` for the contract's partial-update writes (#677 — the
   * `flag update` metadata patch). Same typing + redaction contract as
   * {@link put}; a non-OK status throws {@link ApiError} (401 → `AUTH`).
   */
  patch<TRes>(...call: ApiCall<"patch">): Promise<TRes> {
    return this.#json<TRes>("patch", call);
  }

  /**
   * Typed `DELETE` for the contract's removals (#677 — `flag delete`). A 204
   * carries no body, which {@link parseJsonBody} surfaces as `null`; the caller
   * threads the operation's response type (often `unknown`) since there is
   * nothing to read. A non-OK status throws {@link ApiError} (401 → `AUTH`).
   */
  delete<TRes>(...call: ApiCall<"delete">): Promise<TRes> {
    return this.#json<TRes>("delete", call);
  }

  /**
   * Issue a request and return the status + parsed body WITHOUT throwing on a
   * non-OK status — the caller decides (the device-token poll, whose error
   * bodies are meaningful). The method comes first and is checked against
   * what the path declares. A transport failure still throws
   * {@link NetworkError}.
   */
  request<T>(...call: AnyApiCall): Promise<ApiResponse<T>> {
    const [method, path, options] = call;
    return this.#send<T>(method, path, options);
  }

  /** {@link request}, throwing {@link ApiError} on a non-OK status. */
  async #json<T>(
    method: HttpMethod,
    [path, options]: [string, RuntimeOptions?],
  ): Promise<T> {
    const res = await this.#send<T>(method, path, options);
    if (!res.ok) {
      const message = errorMessage(res.status, res.body);
      throw new ApiError(res.status, message, res.body, res.headers);
    }
    return res.body;
  }

  async #send<T>(
    method: HttpMethod,
    template: string,
    options: RuntimeOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = `${this.#baseUrl}${expandPath(template, options.path)}${
      queryString(options.query)
    }`;
    const init: RequestInit = { method: method.toUpperCase() };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const headers = new Headers();
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
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
    return { status: res.status, ok: res.ok, body, headers: res.headers };
  }
}

/**
 * Fill a contract path template's `{name}` placeholders, each value encoded
 * with `encodeURIComponent` — exactly what the commands did by hand before the
 * paths were typed (#1188), so the wire does not change. A placeholder with no
 * value, or a value with no placeholder, is a programming error and throws:
 * the types make both impossible, and a call that slipped past them must not
 * reach the network with a half-built path. One pass, so a value is never
 * re-read as a template.
 */
export function expandPath(
  template: string,
  params: Record<string, string | number> = {},
): string {
  const used = new Set<string>();
  const path = template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new TypeError(`api path ${template}: no value for {${name}}`);
    }
    used.add(name);
    return encodeURIComponent(String(params[name]));
  });
  for (const name of Object.keys(params)) {
    if (!used.has(name)) throw new TypeError(`api path ${template}: no {${name}} to fill`);
  }
  return path;
}

/**
 * The query string of a call: `?name=value` pairs in the order given, each side
 * encoded with `encodeURIComponent` (a space is `%20`, as the commands sent it,
 * never `URLSearchParams`' `+`). An `undefined` value is left out, so an
 * optional parameter the caller did not set sends nothing. Only scalars are
 * sent: the contract's array or object parameters have no single spelling
 * here, so one throws rather than reaching the wire as `[object Object]`.
 */
export function queryString(query: Record<string, unknown> = {}): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TypeError(`api query ${name}: only a string, number or boolean is sent`);
    }
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
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
