// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Selects how [ConfeatureClient] refreshes the cached configuration.
 *
 * <p>Mirrors ConfigCat's `PollingMode` factory surface 1:1 (constitution Principle II). Three
 * factories cover the supported variants:
 *
 * - [autoPoll] — periodic background fetch.
 * - [lazyLoad] — on-demand fetch when the cache is stale.
 * - [manualPoll] — only explicit `forceRefresh` fetches.
 *
 * <p>Defaults match ConfigCat verbatim: AutoPoll → 60s poll, 5s init wait; LazyLoad → 60s cache
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
        private val DEFAULT_POLL_INTERVAL: Duration = 60.seconds
        private val DEFAULT_MAX_INIT_WAIT_TIME: Duration = 5.seconds
        private val DEFAULT_CACHE_REFRESH_INTERVAL: Duration = 60.seconds

        /** AutoPoll with the documented defaults (60s poll, 5s init wait). */
        public fun autoPoll(): PollingMode = autoPoll(DEFAULT_POLL_INTERVAL, DEFAULT_MAX_INIT_WAIT_TIME)

        /** AutoPoll with explicit timings. Both must be positive. */
        public fun autoPoll(pollInterval: Duration, maxInitWaitTime: Duration): PollingMode {
            requirePositive(pollInterval, "pollInterval")
            requirePositive(maxInitWaitTime, "maxInitWaitTime")
            return PollingMode(Kind.AUTO_POLL, pollInterval, maxInitWaitTime, null)
        }

        /** LazyLoad with the documented default (60s cache refresh interval). */
        public fun lazyLoad(): PollingMode = lazyLoad(DEFAULT_CACHE_REFRESH_INTERVAL)

        /** LazyLoad with an explicit cache refresh interval. Must be positive. */
        public fun lazyLoad(cacheRefreshInterval: Duration): PollingMode {
            requirePositive(cacheRefreshInterval, "cacheRefreshInterval")
            return PollingMode(Kind.LAZY_LOAD, null, null, cacheRefreshInterval)
        }

        /** ManualPoll: never fetches automatically. */
        public fun manualPoll(): PollingMode = PollingMode(Kind.MANUAL_POLL, null, null, null)

        private fun requirePositive(d: Duration, name: String) {
            require(d.isPositive()) { "$name must be positive (was $d)" }
        }
    }
}
