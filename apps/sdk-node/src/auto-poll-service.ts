// SPDX-License-Identifier: MIT

import { InMemoryConfigCache } from "./config-cache.ts";
import type { FetchOutcome, IConfigFetcher } from "./config-fetcher.ts";
import type { Hooks } from "./hooks.ts";
import {
  ClientCacheState,
  ProjectConfig,
  RefreshResult,
  type LoggerWrapper,
} from "@confeature/sdk-shared";
import type { ResolvedOptions } from "./options.ts";
/**
 * Background polling service.
 *
 * Lifecycle:
 *  - constructor → kicks off the first fetch immediately and schedules
 *    the next poll via `setTimeout` (NOT `setInterval` — see research.md
 *    §R3 for the drift rationale).
 *  - `getCurrent()` returns the most recently cached payload (or empty
 *    before the first successful fetch).
 *  - `forceRefreshAsync()` fires a fetch outside the poll cadence and
 *    resolves with a {@link RefreshResult}.
 *  - `waitForReady()` resolves once the initial fetch has settled (or
 *    the `maxInitWaitTimeMs` budget elapses).
 *  - `dispose()` aborts the in-flight fetch + clears the pending timer.
 *    Pending `fetch()` rejections are swallowed.
 *
 * Invariants:
 *  - at most one in-flight fetch (AbortController stored on `inFlight`),
 *  - at most one pending timer,
 *  - after dispose: zero fetches, zero timers; `getCurrent()` still
 *    returns the last good payload (so a late `getValueAsync` race
 *    during shutdown still falls back gracefully).
 */
export class AutoPollConfigService {
  private readonly cache = new InMemoryConfigCache();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  /**
   * Concurrent `refreshAsync()` calls share the same outcome — matches
   * `configcat-common` which keeps `enqueuedFetchAsync` as the single
   * source of truth while a fetch is in flight. The pending promise is
   * cleared in a `finally` so subsequent refreshes start fresh.
   */
  private inFlightRefreshPromise: Promise<RefreshResult> | null = null;
  private stopped = false;
  private offline: boolean;
  private readyPromise: Promise<ClientCacheState>;
  private resolveReady: ((state: ClientCacheState) => void) | null = null;
  private initialFetchSettled = false;
  private readonly initWaitTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    private readonly sdkKey: string,
    private readonly fetcher: IConfigFetcher,
    private readonly options: ResolvedOptions,
    private readonly logger: LoggerWrapper,
    private readonly hooks: Hooks,
  ) {
    this.offline = options.offline;

    let resolver: (state: ClientCacheState) => void = () => {};
    this.readyPromise = new Promise((resolve) => {
      resolver = resolve;
    });
    this.resolveReady = resolver;

    // Optional `maxInitWaitTimeMs` guard: even if the initial fetch
    // never settles (e.g. the CDN is down forever), `waitForReady`
    // resolves after this budget with the cache state at that moment.
    if (options.maxInitWaitTimeMs >= 0) {
      this.initWaitTimer = setTimeout(() => {
        this.markReady();
      }, options.maxInitWaitTimeMs);
    } else {
      this.initWaitTimer = null;
    }

    if (!this.offline) {
      // Cold start — kick the first poll on next tick. We don't await it
      // from the constructor (constructors aren't async); the caller
      // uses `waitForReady()` to gate on initial freshness.
      void this.poll();
    } else {
      // Offline at construction: no fetch, but ready immediately.
      this.markReady();
    }
  }

  /**
   * Current cached payload. Never throws; returns `ProjectConfig.empty()`
   * before the first successful fetch.
   */
  getCurrent(): ProjectConfig {
    return this.cache.getCurrent();
  }

  /**
   * Resolve once the initial fetch settles or `maxInitWaitTimeMs` elapses.
   * Returned state reflects the cache at the resolution point.
   */
  waitForReady(): Promise<ClientCacheState> {
    return this.readyPromise;
  }

  /**
   * Trigger a one-off refresh outside the poll cadence. Does NOT reset
   * the next-tick countdown (matches `configcat-common`).
   */
  async forceRefreshAsync(): Promise<RefreshResult> {
    if (this.stopped) {
      return RefreshResult.failure("Service disposed; refresh ignored.");
    }
    if (this.offline) {
      return RefreshResult.failure("Client is offline; refresh skipped.");
    }
    return this.refreshAsync();
  }

  /** Stop polling, abort in-flight fetch, clear timers. Idempotent. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.initWaitTimer !== null) {
      clearTimeout(this.initWaitTimer);
    }
    if (this.inFlight) {
      try {
        this.inFlight.abort();
      } catch {
        /* swallow — AbortController.abort is spec-noexcept anyway */
      }
      this.inFlight = null;
    }
    // Unblock anyone still waiting on `waitForReady`.
    this.markReady();
  }

  /** Toggle online mode. `false` stops polling; `true` re-arms it. */
  setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    if (offline) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.inFlight) {
        try {
          this.inFlight.abort();
        } catch {
          /* swallow */
        }
        this.inFlight = null;
      }
    } else if (!this.stopped) {
      void this.poll();
    }
  }

  isOffline(): boolean {
    return this.offline;
  }

  // ---- internal -------------------------------------------------------

  /** One poll iteration: refresh, then schedule the next. */
  private async poll(): Promise<void> {
    if (this.stopped || this.offline) return;
    try {
      await this.refreshAsync();
    } catch {
      // refreshAsync is supposed to swallow its own errors; defensive guard.
      // The error is dropped: it may quote the URL, which holds the key
      // (#803, FR-002) — the same rule as the refresh path.
      this.logger.fetchFailed(this.sdkKey, "poll-throw");
    }
    if (this.stopped || this.offline) return;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped || this.offline) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  /**
   * One fetch + cache-swap. Errors are caught, logged, and the previous
   * `ProjectConfig` is preserved (stale-on-error per US2 acceptance).
   *
   * Concurrent callers (the polling loop + a `forceRefreshAsync`) share
   * the same in-flight promise — matches `configcat-common`'s
   * `enqueuedFetchAsync` semantics. Single network round-trip, single
   * cache swap, single `RefreshResult` echoed to every caller.
   */
  private refreshAsync(): Promise<RefreshResult> {
    if (this.offline) {
      return Promise.resolve(RefreshResult.failure("Client is offline; refresh skipped."));
    }
    if (this.inFlightRefreshPromise) {
      return this.inFlightRefreshPromise;
    }
    const promise = this.refreshInner();
    this.inFlightRefreshPromise = promise;
    return promise;
  }

  private async refreshInner(): Promise<RefreshResult> {
    // Per-fetch AbortController (timeout) — combine with the dispose
    // signal so dispose cancels the fetch immediately.
    const ac = new AbortController();
    this.inFlight = ac;
    const timeoutHandle = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        /* swallow */
      }
    }, this.options.requestTimeoutMs);

    let outcome: FetchOutcome;
    try {
      const prev = this.cache.getCurrent();
      outcome = await this.fetcher.fetchAsync(this.sdkKey, prev.eTag, ac.signal);
    } catch {
      // Defensive: the fetcher contract says it must not reject, but if
      // a custom fetcher does, we still convert to a failure outcome. The
      // error itself is dropped: it may quote the URL, which holds the key
      // (#803, FR-002).
      this.logger.fetchFailed(this.sdkKey, "exception");
      outcome = {
        status: "failed",
        errorCode: "FETCH_FAILED",
        errorMessage: "Fetcher threw unexpectedly.",
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (this.inFlight === ac) this.inFlight = null;
    }

    // Disposed mid-fetch — drop the result on the floor.
    if (this.stopped) {
      this.inFlightRefreshPromise = null;
      this.markReady();
      return RefreshResult.failure("Service disposed during refresh.");
    }

    const now = Date.now();
    let result: RefreshResult;
    if (outcome.status === "fetched") {
      const next = new ProjectConfig(outcome.configJson, outcome.eTag, now);
      this.cache.set(next);
      try {
        this.hooks.emit("configChanged", outcome.configJson);
      } catch {
        /* swallow listener errors */
      }
      result = RefreshResult.success();
    } else if (outcome.status === "notModified") {
      // Touch the freshness stamp but keep the same parsed payload + ETag.
      const prev = this.cache.getCurrent();
      this.cache.set(prev.withFreshFetchTime(now));
      result = RefreshResult.success();
    } else {
      // outcome.status === "failed" — stale-on-error: cache untouched.
      // A key-free Error carrying the fixed reason: ConfigCat's API shape (an
      // errorException is present), never a library message quoting the URL (#803).
      result = RefreshResult.failure(outcome.errorMessage, new Error(outcome.errorMessage));
    }

    // Clear coalescence slot BEFORE resolving waiters so a follow-up
    // refresh kicked off in the same microtask sees a clean slate.
    this.inFlightRefreshPromise = null;
    this.markReady();
    return result;
  }

  /**
   * Resolve `waitForReady` exactly once with the current cache state.
   * Subsequent calls are no-ops.
   */
  private markReady(): void {
    if (this.initialFetchSettled) return;
    this.initialFetchSettled = true;
    const current = this.cache.getCurrent();
    const state =
      current.configJson === null
        ? ClientCacheState.NoFlagData
        : ClientCacheState.HasUpToDateFlagData;
    if (this.resolveReady) {
      this.resolveReady(state);
      this.resolveReady = null;
    }
    try {
      this.hooks.emit("clientReady");
    } catch {
      /* swallow listener errors */
    }
  }
}
