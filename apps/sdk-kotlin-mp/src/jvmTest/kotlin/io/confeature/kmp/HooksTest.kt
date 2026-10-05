// SPDX-License-Identifier: MIT
package io.confeature.kmp

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Spec 105 / #268 — slice 3/14 — sdk-kotlin-mp hooks/events bus.
 *
 * Mirrors the upstream `com.configcat.ConfigCatHooks` surface — four hook points (clientReady,
 * configChanged, flagEvaluated, clientError). Conformance lives in [ApiSurfaceConformanceTest];
 * this file exercises behaviour.
 *
 * Test fixture: `:memory:` cache + the public Builder API (no Ktor engine injection — that would
 * need plumbing the Builder doesn't expose). The fetch-driven hooks (clientReady, configChanged,
 * clientError) are exercised indirectly via [forceRefresh] against a non-routable host so the
 * fetch always fails — verifying onError fires and the other two stay quiet.
 */
class HooksTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private fun buildClient(): ConfeatureClient =
        ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl("https://mock.confeature.test")
            .logger(CapturingLogger())
            .build()

    @Test
    fun getHooksReturnsTheSameInstanceAcrossCalls() {
        val client = buildClient()
        try {
            assertNotNull(client.getHooks())
            assertSame(client.getHooks(), client.getHooks())
        } finally {
            client.close()
        }
    }

    @Test
    fun addOnAllFourHookPointsCompiles() {
        // Smoke test — the four `addOn*` methods exist on the bus and accept the expected
        // lambda shapes. This pins the API contract: a migrating ConfigCat KMP consumer's
        // subscription call sites compile unchanged (Principle II — drop-in compatibility).
        val client = buildClient()
        try {
            client.getHooks().addOnClientReady { /* no-op */ }
            client.getHooks().addOnConfigChanged { _ -> /* no-op */ }
            client.getHooks().addOnFlagEvaluated { _ -> /* no-op */ }
            client.getHooks().addOnError { _ -> /* no-op */ }
        } finally {
            client.close()
        }
    }

    @Test
    fun clientErrorFiresOnFetchFailure() {
        // `https://mock.confeature.test` is non-routable, so forceRefresh always returns false.
        // The FAILED outcome flips the onError hook.
        val client = buildClient()
        val lastMessage = AtomicReference<String>()
        val readyFires = AtomicInteger(0)
        val configChangedFires = AtomicInteger(0)
        try {
            client.getHooks().addOnError { lastMessage.set(it) }
            client.getHooks().addOnClientReady { readyFires.incrementAndGet() }
            client.getHooks().addOnConfigChanged { configChangedFires.incrementAndGet() }
            runBlocking { client.forceRefresh() }
            assertNotNull(lastMessage.get(), "clientError MUST fire on fetch failure")
            assertTrue(lastMessage.get().isNotEmpty())
            assertEquals(0, readyFires.get(), "clientReady MUST NOT fire on fetch failure")
            assertEquals(0, configChangedFires.get(), "configChanged MUST NOT fire on FAILED")
        } finally {
            client.close()
        }
    }

    @Test
    fun exceptionThrownByOneListenerDoesNotBreakOthers() {
        val client = buildClient()
        val downstreamFires = AtomicInteger(0)
        try {
            client.getHooks().addOnError { throw IllegalStateException("boom") }
            client.getHooks().addOnError { downstreamFires.incrementAndGet() }
            runBlocking { client.forceRefresh() }
            assertEquals(
                1,
                downstreamFires.get(),
                "a throwing listener does not prevent later listeners from firing",
            )
        } finally {
            client.close()
        }
    }
}
