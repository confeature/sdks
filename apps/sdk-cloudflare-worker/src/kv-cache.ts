// SPDX-License-Identifier: MIT

import type { IConfigCatCache } from "@confeature/sdk-browser-js";

/**
 * Options accepted by {@link workersKvCache}.
 */
export interface WorkersKvCacheOptions {
  /**
   * KV expiration TTL in seconds. Defaults to 60 — matches
   * `configcat-common`'s default `cacheTimeToLiveSeconds`. Workers KV
   * enforces a minimum of 60 seconds; values below that are clamped
   * server-side by Cloudflare.
   */
  ttlSeconds?: number;
}

/**
 * Default KV expiration TTL (seconds). Mirrors
 * `configcat-common`'s default `cacheTimeToLiveSeconds`. Cloudflare KV
 * enforces a 60-second floor on `expirationTtl`; smaller values are
 * silently clamped server-side.
 */
const DEFAULT_TTL_SECONDS = 60;

/**
 * Build an {@link IConfigCatCache} that persists the serialised
 * `config_v6.json` payload in a Cloudflare Workers KV namespace.
 *
 * `kv.get(key, "text")` returns `null` on miss; we normalise that to
 * `null` (which `IConfigCatCache` declares is a legal absent value)
 * so callers don't have to special-case the distinction between
 * "never written" and "expired".
 *
 * `kv.put(key, value, { expirationTtl })` is fire-and-forget at the
 * edge — KV writes propagate to every PoP within ~60 seconds, which
 * is acceptable for the polling cache (subsequent isolates either see
 * the new payload or fall back to the fetcher).
 *
 * @example
 * ```ts
 * import { getConfeatureClient, workersKvCache } from "@confeature/sdk-cloudflare-worker";
 *
 * export default {
 *   async fetch(req: Request, env: { KV: KVNamespace }): Promise<Response> {
 *     const client = getConfeatureClient({
 *       sdkKey: "configcat-sdk-1/...",
 *       cache: workersKvCache(env.KV),
 *     });
 *     const enabled = await client.getValueAsync("dark-mode", false);
 *     return Response.json({ enabled });
 *   },
 * };
 * ```
 */
export function workersKvCache(kv: KVNamespace, options?: WorkersKvCacheOptions): IConfigCatCache {
  const ttlSeconds =
    options?.ttlSeconds !== undefined &&
    Number.isFinite(options.ttlSeconds) &&
    options.ttlSeconds > 0
      ? Math.floor(options.ttlSeconds)
      : DEFAULT_TTL_SECONDS;
  return {
    async get(key: string): Promise<string | null> {
      // `kv.get(key, "text")` is the documented String type for KV
      // values; binary types are not used by sdk-browser-js's cache
      // (it persists the JSON-stringified payload).
      return kv.get(key, "text");
    },
    async set(key: string, value: string): Promise<void> {
      await kv.put(key, value, { expirationTtl: ttlSeconds });
    },
  };
}
