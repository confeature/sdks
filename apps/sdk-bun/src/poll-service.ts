// SPDX-License-Identifier: MIT

import {
  ClientCacheState,
  type FetchOutcome,
  type IConfigFetcher,
  type LoggerWrapper,
  ProjectConfig,
  RefreshResult,
} from "@confeature/sdk-shared";

import { BunFileConfigCache } from "./bun-file-cache.ts";
import type { Hooks } from "./hooks.ts";
import { PollingMode, type ResolvedOptions } from "./options.ts";

/**
 * Polling service shared across AutoPoll / LazyLoad / ManualPoll modes.
 *
 * Each mode is a behaviour toggle, not a separate class:
 *  - `AutoPoll`: kicks an initial fetch + arms a `setTimeout` chain that
 *    re-fires every `pollIntervalMs`.
 *  - `LazyLoad`: kicks an initial fetch (so the cache is warm) but does
 *    NOT arm a recurring timer; instead `ensureFresh()` triggers a
 *    background refresh whenever the cache age exceeds `cacheTtlMs`.
 *  - `ManualPoll`: NO initial fetch, NO timer — only `forceRefreshAsync`
 *    triggers network activity.
 *
 * Lifecycle invariants:
 *  - at most one in-flight fetch (AbortController stored on `inFlight`),
 *  - at most one pending timer (only present in AutoPoll mode),
 *  - after `dispose()`: zero fetches, zero timers; `getCurrent()` still
 *    returns the last good payload so a late `getValueAsync` race during
 *    shutdown still falls back gracefully.
 *
 * Bun-specific note (research §R8): Bun's `setTimeout`/`clearTimeout`
 * are spec-compatible with Node and the browser — no Bun-specific
 * timer API is needed.
 */
export class ConfigPollService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  /**
   * Concurrent `refreshAsync()` calls share the same outcome — matches
   * `configcat-common` which keeps `enqueuedFetchAsync` as the single
   * source of truth while a fetch is in flight.
   */
  private inFlightRefreshPromise: Promise<RefreshResult> | null = null;
  /**
   * LazyLoad bookkeeping: while a background refresh is in flight we
   * don't fire another from `ensureFresh()`. Cleared in the same place
   * `inFlightRefreshPromise` is cleared.
   */
  private backgroundRefresh: Promise<RefreshResult> | null = null;
  private stopped = false;
  private offline: boolean;
  private readonly readyPromise: Promise<ClientCacheState>;
  private resolveReady: ((state: ClientCacheState) => void) | null = null;
  private initialFetchSettled = false;
  private readonly initWaitTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    private readonly sdkKey: string,
    private readonly fetcher: IConfigFetcher,
    private readonly cache: BunFileConfigCache,
    private readonly options: ResolvedOptions,
    private readonly pollingMode: PollingMode,
    private readonly logger: LoggerWrapper,
    private readonly hooks: Hooks,
  ) {
    this.offline = options.offline;

    let resolver: (state: ClientCacheState) => void = () => {};
    this.readyPromise = new Promise((resolve) => {
      resolver = resolve;
    });
    this.resolveReady = resolver;

    if (options.maxInitWaitTimeMs >= 0) {
      this.initWaitTimer = setTimeout(() => {
        this.markReady();
      }, options.maxInitWaitTimeMs);
    } else {
      this.initWaitTimer = null;
    }

    if (this.offline) {
      // Offline at construction: no fetch, but ready immediately.
      this.markReady();
      return;
    }

    if (this.pollingMode === PollingMode.AutoPoll) {
      // Cold start — kick the first poll on next tick.
      void this.poll();
    } else if (this.pollingMode === PollingMode.LazyLoad) {
      // Lazy-load: kick a single initial fetch so the cache is warm,
      // but don't arm the recurring timer. Subsequent freshness is
      // driven by `ensureFresh()` (called from the client's eval path).
      void this.refreshAsync().catch(() => {
        /* swallow — failures are already logged inside refreshInner */
      });
    } else {
      // ManualPoll: no implicit fetch — only `forceRefreshAsync` may
      // trigger one. Mark ready immediately if the cache was hydrated,
      // otherwise wait for `forceRefreshAsync`.
      const cached = this.cache.getCurrent();
      if (cached.configJson !== null) {
        this.markReady();
      }
    }
  }

  /** Current cached payload. Never throws. */
  getCurrent(): ProjectConfig {
    return this.cache.getCurrent();
  }

  /**
   * LazyLoad-only freshness check. AutoPoll + ManualPoll: no-op.
   *
   * If the current cache entry has gone stale relative to
   * `cacheTtlMs`, fire a background refresh. We don't await it — the
   * eval path still sees the stale value (matches configcat-js's
   * documented lazy semantics).
   */
  ensureFresh(): void {
    if (this.pollingMode !== PollingMode.LazyLoad) return;
    if (this.stopped || this.offline) return;
    if (this.backgroundRefresh) return;
    const cfg = this.cache.getCurrent();
    if (cfg.configJson !== null && !cfg.isExpired(this.options.cacheTtlMs)) return;
    this.backgroundRefresh = this.refreshAsync().finally(() => {
      this.backgroundRefresh = null;
    });
  }

  /**
   * Resolve once the initial fetch settles or `maxInitWaitTimeMs` elapses.
   */
  waitForReady(): Promise<ClientCacheState> {
    return this.readyPromise;
  }

  /**
   * Trigger a one-off refresh outside the poll cadence. Matches
   * `configcat-common`'s `forceRefreshAsync` semantics.
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

  /** Toggle online mode. `true` re-arms AutoPoll, `false` stops everything. */
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
    } else if (!this.stopped && this.pollingMode === PollingMode.AutoPoll) {
      void this.poll();
    }
  }

  isOffline(): boolean {
    return this.offline;
  }

  // ---- internal -------------------------------------------------------

  /**
   * One AutoPoll iteration: refresh, then schedule the next.
   * No-op outside AutoPoll mode.
   */
  private async poll(): Promise<void> {
    if (this.stopped || this.offline) return;
    if (this.pollingMode !== PollingMode.AutoPoll) return;
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
    if (this.pollingMode !== PollingMode.AutoPoll) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  /**
   * One fetch + cache-swap. Errors are caught, logged, and the previous
   * `ProjectConfig` is preserved (stale-on-error).
   *
   * Concurrent callers share the same in-flight promise (matches
   * `configcat-common`'s `enqueuedFetchAsync` semantics).
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
      outcome = await this.fetcher.fetchAsync(prev.eTag, ac.signal);
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
      const prev = this.cache.getCurrent();
      this.cache.set(prev.withFreshFetchTime(now));
      result = RefreshResult.success();
    } else {
      // outcome.status === "failed" — stale-on-error: cache untouched.
      // A key-free Error carrying the fixed reason: ConfigCat's API shape (an
      // errorException is present), never a library message quoting the URL (#803).
      result = RefreshResult.failure(outcome.errorMessage, new Error(outcome.errorMessage));
    }

    this.inFlightRefreshPromise = null;
    this.markReady();
    return result;
  }

  /** Resolve `waitForReady` exactly once with the current cache state. */
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
