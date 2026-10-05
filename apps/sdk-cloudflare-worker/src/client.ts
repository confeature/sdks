// SPDX-License-Identifier: MIT

import {
  ConfeatureClient,
  type IAutoPollOptions,
  type IConfigCatClient,
  type ILazyLoadingOptions,
  type IManualPollOptions,
  PollingMode,
} from "@confeature/sdk-browser-js";

/**
 * Options accepted by {@link getConfeatureClient}.
 *
 * The shape unions every polling-mode-specific option bundle exported
 * by `@confeature/sdk-browser-js` (`IAutoPollOptions`,
 * `ILazyLoadingOptions`, `IManualPollOptions` — all three extend
 * `IOptions` and add non-overlapping fields). On top of that we add
 * the canonical `sdkKey` and `pollingMode` discriminator. This
 * matches `@configcat/cloudflare-worker-client`'s `getClient`
 * parameter list with the only difference being that `cache` is
 * strongly recommended (Workers have no filesystem and no
 * `localStorage`, so the default in-memory cache evaporates between
 * isolates).
 */
export interface CloudflareWorkerClientOptions
  extends IAutoPollOptions, ILazyLoadingOptions, IManualPollOptions {
  /**
   * Required SDK key — shape `configcat-sdk-1/<22-char>/<22-char>`
   * (keys minted before #802, `confeature-sdk-1-<32-char>-<32-char>`,
   * are still accepted).
   */
  sdkKey: string;
  /**
   * Polling strategy. Defaults to `PollingMode.AutoPoll` — matches
   * `@configcat/cloudflare-worker-client`. `ManualPoll` is the
   * common choice in stateless Worker invocations where you want a
   * single `forceRefreshAsync()` per cold start.
   */
  pollingMode?: PollingMode;
}

/**
 * Factory entry — drop-in equivalent of
 * `@configcat/cloudflare-worker-client`'s `getClient(...)`.
 *
 * Wraps `ConfeatureClient` from `@confeature/sdk-browser-js` with
 * Worker-friendly defaults:
 *  - `globalThis.fetch` is used implicitly by the underlying
 *    `HttpConfigFetcher` (no override needed — workerd provides a
 *    spec-compliant `fetch`).
 *  - The customer is responsible for passing `cache: workersKvCache(env.KV)`
 *    if they want cross-isolate persistence. Without `cache`, the
 *    SDK falls through to an in-memory cache scoped to the current
 *    isolate — fine for short-lived warm Workers but discards the
 *    config on every cold start.
 *
 * Returns the canonical `IConfigCatClient` so customer code that
 * uses the `IConfigCatClient` type from `configcat-js` keeps
 * compiling without changes (Principle II — drop-in compatibility).
 *
 * @example
 * ```ts
 * import { getConfeatureClient, workersKvCache, PollingMode } from "@confeature/sdk-cloudflare-worker";
 *
 * export default {
 *   async fetch(req: Request, env: { KV: KVNamespace }): Promise<Response> {
 *     const client = getConfeatureClient({
 *       sdkKey: "configcat-sdk-1/...",
 *       pollingMode: PollingMode.ManualPoll,
 *       cache: workersKvCache(env.KV),
 *     });
 *     await client.forceRefreshAsync();
 *     const enabled = await client.getValueAsync("dark-mode", false);
 *     return Response.json({ enabled });
 *   },
 * };
 * ```
 */
export function getConfeatureClient(options: CloudflareWorkerClientOptions): IConfigCatClient {
  const { sdkKey, pollingMode, ...rest } = options;
  return ConfeatureClient.getInstance(sdkKey, pollingMode ?? PollingMode.AutoPoll, rest);
}
