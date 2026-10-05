// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class PollingModeTest {

    @Test
    fun autoPoll_defaults() {
        val mode = PollingMode.autoPoll()
        assertEquals(PollingMode.Kind.AUTO_POLL, mode.kind)
        assertEquals(60.seconds, mode.pollInterval)
        assertEquals(5.seconds, mode.maxInitWaitTime)
        assertNull(mode.cacheRefreshInterval)
    }

    @Test
    fun autoPoll_customTimings() {
        val mode = PollingMode.autoPoll(30.seconds, 2.seconds)
        assertEquals(30.seconds, mode.pollInterval)
        assertEquals(2.seconds, mode.maxInitWaitTime)
    }

    @Test
    fun autoPoll_rejectsNonPositivePollInterval() {
        assertFailsWith<IllegalArgumentException> {
            PollingMode.autoPoll(0.milliseconds, 1.seconds)
        }
    }

    @Test
    fun autoPoll_rejectsNonPositiveMaxInitWait() {
        assertFailsWith<IllegalArgumentException> {
            PollingMode.autoPoll(1.seconds, 0.milliseconds)
        }
    }

    @Test
    fun lazyLoad_defaults() {
        val mode = PollingMode.lazyLoad()
        assertEquals(PollingMode.Kind.LAZY_LOAD, mode.kind)
        assertEquals(60.seconds, mode.cacheRefreshInterval)
        assertNull(mode.pollInterval)
        assertNull(mode.maxInitWaitTime)
    }

    @Test
    fun lazyLoad_rejectsNonPositiveRefresh() {
        assertFailsWith<IllegalArgumentException> {
            PollingMode.lazyLoad(0.milliseconds)
        }
    }

    @Test
    fun manualPoll_isInert() {
        val mode = PollingMode.manualPoll()
        assertEquals(PollingMode.Kind.MANUAL_POLL, mode.kind)
        assertNull(mode.pollInterval)
        assertNull(mode.maxInitWaitTime)
        assertNull(mode.cacheRefreshInterval)
    }

    @Test
    fun kind_enumExposesThreeValues() {
        // Compile-time guarantee — the enum is checked exhaustively in
        // ConfeatureClient.init / ConfigFetcher. Verifies forward-compat.
        val all = PollingMode.Kind.values()
        assertEquals(3, all.size)
        assertNotNull(all.firstOrNull { it == PollingMode.Kind.AUTO_POLL })
        assertNotNull(all.firstOrNull { it == PollingMode.Kind.LAZY_LOAD })
        assertNotNull(all.firstOrNull { it == PollingMode.Kind.MANUAL_POLL })
    }
}
