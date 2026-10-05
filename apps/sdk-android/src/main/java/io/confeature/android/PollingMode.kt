// SPDX-License-Identifier: MIT
package io.confeature.android

import java.time.Duration

/**
 * Selects how [ConfeatureClient] refreshes the cached configuration.
 *
 * Mirrors ConfigCat's `com.configcat.PollingMode` factory surface 1:1 (constitution Principle II).
 * Three factories cover the supported variants:
 * - [autoPoll] — periodic background fetch.
 * - [lazyLoad] — on-demand fetch when the cache is stale.
 * - [manualPoll] — only explicit `forceRefresh` fetches.
 *
 * Defaults match ConfigCat verbatim: AutoPoll → 60s poll, 5s init wait; LazyLoad → 60s cache
 * refresh interval.
 */
public class PollingMode private constructor(
    public val kind: Kind,
    public val pollInterval: Duration?,
    public val maxInitWaitTime: Duration?,
    public val cacheRefreshInterval: Duration?,
) {
    /** Enumerates the supported variants. */
    public enum class Kind { AUTO_POLL, LAZY_LOAD, MANUAL_POLL }

    public companion object {
        private val DEFAULT_POLL_INTERVAL: Duration = Duration.ofSeconds(60)
        private val DEFAULT_MAX_INIT_WAIT_TIME: Duration = Duration.ofSeconds(5)
        private val DEFAULT_CACHE_REFRESH_INTERVAL: Duration = Duration.ofSeconds(60)

        /** AutoPoll with the documented defaults (60s poll, 5s init wait). */
        @JvmStatic
        public fun autoPoll(): PollingMode = autoPoll(DEFAULT_POLL_INTERVAL, DEFAULT_MAX_INIT_WAIT_TIME)

        /** AutoPoll with explicit timings. Both must be positive. */
        @JvmStatic
        public fun autoPoll(pollInterval: Duration, maxInitWaitTime: Duration): PollingMode {
            requirePositive(pollInterval, "pollInterval")
            requirePositive(maxInitWaitTime, "maxInitWaitTime")
            return PollingMode(Kind.AUTO_POLL, pollInterval, maxInitWaitTime, null)
        }

        /** Convenience: AutoPoll with seconds, matching ConfigCat's overload shape. */
        @JvmStatic
        public fun autoPoll(pollIntervalSeconds: Long, maxInitWaitTimeSeconds: Long): PollingMode =
            autoPoll(Duration.ofSeconds(pollIntervalSeconds), Duration.ofSeconds(maxInitWaitTimeSeconds))

        /** LazyLoad with the documented default (60s cache refresh interval). */
        @JvmStatic
        public fun lazyLoad(): PollingMode = lazyLoad(DEFAULT_CACHE_REFRESH_INTERVAL)

        /** LazyLoad with an explicit cache refresh interval. Must be positive. */
        @JvmStatic
        public fun lazyLoad(cacheRefreshInterval: Duration): PollingMode {
            requirePositive(cacheRefreshInterval, "cacheRefreshInterval")
            return PollingMode(Kind.LAZY_LOAD, null, null, cacheRefreshInterval)
        }

        /** Convenience: LazyLoad with seconds. */
        @JvmStatic
        public fun lazyLoad(cacheRefreshIntervalSeconds: Long): PollingMode =
            lazyLoad(Duration.ofSeconds(cacheRefreshIntervalSeconds))

        /** ManualPoll: never fetches automatically. */
        @JvmStatic
        public fun manualPoll(): PollingMode = PollingMode(Kind.MANUAL_POLL, null, null, null)

        private fun requirePositive(d: Duration, name: String) {
            if (d.isZero || d.isNegative) {
                throw IllegalArgumentException("$name must be positive (was $d)")
            }
        }
    }
}
