// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.time.Duration;
import java.util.Objects;

/**
 * Selects how {@code ConfeatureClient} refreshes the cached configuration.
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.PollingMode} factory surface 1:1 (constitution
 * Principle II). Three factories cover the supported variants:
 *
 * <ul>
 *   <li>{@link #autoPoll(Duration, Duration)} — periodic background fetch.
 *   <li>{@link #lazyLoad(Duration)} — on-demand fetch when the cache is stale.
 *   <li>{@link #manualPoll()} — only explicit {@code forceRefresh} fetches.
 * </ul>
 *
 * <p>Defaults match ConfigCat verbatim: AutoPoll → 60s poll, 5s init wait; LazyLoad → 60s cache
 * refresh interval.
 */
public final class PollingMode {

  /** Enumerates the supported variants. */
  public enum Kind {
    AUTO_POLL,
    LAZY_LOAD,
    MANUAL_POLL
  }

  private static final Duration DEFAULT_POLL_INTERVAL = Duration.ofSeconds(60);
  private static final Duration DEFAULT_MAX_INIT_WAIT_TIME = Duration.ofSeconds(5);
  private static final Duration DEFAULT_CACHE_REFRESH_INTERVAL = Duration.ofSeconds(60);

  private final Kind kind;
  private final Duration pollInterval;
  private final Duration maxInitWaitTime;
  private final Duration cacheRefreshInterval;

  private PollingMode(
      Kind kind, Duration pollInterval, Duration maxInitWaitTime, Duration cacheRefreshInterval) {
    this.kind = kind;
    this.pollInterval = pollInterval;
    this.maxInitWaitTime = maxInitWaitTime;
    this.cacheRefreshInterval = cacheRefreshInterval;
  }

  /** AutoPoll with the documented defaults (60s poll, 5s init wait). */
  public static PollingMode autoPoll() {
    return autoPoll(DEFAULT_POLL_INTERVAL, DEFAULT_MAX_INIT_WAIT_TIME);
  }

  /** AutoPoll with explicit timings. Both must be positive. */
  public static PollingMode autoPoll(Duration pollInterval, Duration maxInitWaitTime) {
    requirePositive(pollInterval, "pollInterval");
    requirePositive(maxInitWaitTime, "maxInitWaitTime");
    return new PollingMode(Kind.AUTO_POLL, pollInterval, maxInitWaitTime, null);
  }

  /** Convenience: AutoPoll with seconds, matching ConfigCat's overload shape. */
  public static PollingMode autoPoll(long pollIntervalSeconds, long maxInitWaitTimeSeconds) {
    return autoPoll(
        Duration.ofSeconds(pollIntervalSeconds), Duration.ofSeconds(maxInitWaitTimeSeconds));
  }

  /** LazyLoad with the documented default (60s cache refresh interval). */
  public static PollingMode lazyLoad() {
    return lazyLoad(DEFAULT_CACHE_REFRESH_INTERVAL);
  }

  /** LazyLoad with an explicit cache refresh interval. Must be positive. */
  public static PollingMode lazyLoad(Duration cacheRefreshInterval) {
    requirePositive(cacheRefreshInterval, "cacheRefreshInterval");
    return new PollingMode(Kind.LAZY_LOAD, null, null, cacheRefreshInterval);
  }

  /** Convenience: LazyLoad with seconds. */
  public static PollingMode lazyLoad(long cacheRefreshIntervalSeconds) {
    return lazyLoad(Duration.ofSeconds(cacheRefreshIntervalSeconds));
  }

  /** ManualPoll: never fetches automatically. */
  public static PollingMode manualPoll() {
    return new PollingMode(Kind.MANUAL_POLL, null, null, null);
  }

  /** Returns the variant. */
  public Kind getKind() {
    return kind;
  }

  /** Returns the AutoPoll interval, or {@code null} for other variants. */
  public Duration getPollInterval() {
    return pollInterval;
  }

  /** Returns the AutoPoll init-wait, or {@code null} for other variants. */
  public Duration getMaxInitWaitTime() {
    return maxInitWaitTime;
  }

  /** Returns the LazyLoad cache refresh interval, or {@code null} for other variants. */
  public Duration getCacheRefreshInterval() {
    return cacheRefreshInterval;
  }

  private static void requirePositive(Duration d, String name) {
    Objects.requireNonNull(d, name);
    if (d.isZero() || d.isNegative()) {
      throw new IllegalArgumentException(name + " must be positive (was " + d + ")");
    }
  }
}
