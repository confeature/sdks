// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.isolated.ExperimentalIsolatedApi
import dev.openfeature.kotlin.sdk.isolated.createOpenFeatureAPIInstance
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.ConfigCache
import io.confeature.kmp.PollingMode
import io.confeature.kmp.TypedEvaluationDetails
import io.confeature.kmp.User
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds

@OptIn(ExperimentalIsolatedApi::class)
class NetworkFixtureTest {
    @Test
    fun theFixtureTransportRejectsAnUnapprovedOriginAndDoesNotFollowRedirects() = runTest {
        for (url in listOf(FIXTURE_CANARY_ORIGIN, "$FIXTURE_ORIGIN/fixture-redirect")) {
            val sdk = ConfeatureClient.builder(FIXTURE_KEY)
                .baseUrl(url)
                .pollingMode(PollingMode.manualPoll())
                .cacheDirectory(":memory:")
                .build()
            try {
                assertFalse(sdk.forceRefresh(), "fixture request must fail closed")
            } finally {
                sdk.close()
            }
        }
    }

    @Test
    fun registeredOpenFeatureClientUsesTheSeededConfigAndExplicitStaticContext() = runTest {
        val sdk = ConfeatureClient.builder(FIXTURE_KEY)
            .baseUrl(FIXTURE_ORIGIN)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .defaultUser(User("application-default", country = "FR"))
            .build()
        val hooks = mutableListOf<TypedEvaluationDetails<*>>()
        sdk.getHooks().addOnFlagEvaluated { hooks.add(it) }
        val listenerCount = sdk.getHooks().fixtureListenerCount()
        assertEquals(1, listenerCount)
        val targetedApi = createOpenFeatureAPIInstance()
        val anonymousApi = createOpenFeatureAPIInstance()
        try {
            targetedApi.setProviderAndWait(ConfeatureProvider(sdk))
            anonymousApi.setProviderAndWait(ConfeatureProvider(sdk))
            assertEquals(listenerCount, sdk.getHooks().fixtureListenerCount())
            val targeted = targetedApi.getClient()
            val anonymous = anonymousApi.getClient()
            val cold = targeted.getStringDetails("region", "fallback")
            assertEquals("fallback", cold.value)
            assertEquals(ErrorCode.PROVIDER_NOT_READY, cold.errorCode)
            assertTrue(sdk.forceRefresh())

            targetedApi.setEvaluationContextAndWait(
                ImmutableContext(attributes = mapOf("Country" to Value.String("FR"))),
            )
            val match = targeted.getStringDetails("region", "00123")
            assertEquals("00123", match.value)
            assertEquals("region-match", match.variant)
            assertEquals(Reason.TARGETING_MATCH.name, match.reason)
            assertNull(match.errorCode)
            val unmatched = anonymous.getStringDetails("region", "fallback")
            assertEquals("true", unmatched.value)
            assertEquals("region-default", unmatched.variant)
            assertNull(unmatched.errorCode)
            assertEquals(3, hooks.size)
            assertTrue(hooks.all { it.user == null })
            targetedApi.setProviderAndWait(ConfeatureProvider(sdk))
            assertEquals(listenerCount, sdk.getHooks().fixtureListenerCount())
        } finally {
            try {
                targetedApi.shutdown()
                anonymousApi.shutdown()
                assertEquals(listenerCount, sdk.getHooks().fixtureListenerCount())
            } finally {
                sdk.close()
            }
        }
    }

    @Test
    fun concurrentLazyLoadCallsUseStaleValuesUntilTheSharedReloadFinishes() = runTest {
        // Use real time for the SDK's wall-clock TTL and its transport.
        withContext(Dispatchers.Default) {
            withTimeout(15_000) { exerciseLazyLoad() }
        }
    }

    private suspend fun exerciseLazyLoad() {
        val firstWrite = CompletableDeferred<Unit>()
        val releaseWrite = CompletableDeferred<Unit>()
        val firstConfig = CompletableDeferred<Unit>()
        val freshConfig = CompletableDeferred<Unit>()
        val cache = object : ConfigCache {
            override suspend fun read(cacheKey: String): String? = null

            override suspend fun write(cacheKey: String, value: String) {
                if (firstWrite.complete(Unit)) releaseWrite.await()
            }
        }
        val ttl = 100.milliseconds
        val sdk = ConfeatureClient.builder(FIXTURE_LAZY_KEY)
            .baseUrl(FIXTURE_ORIGIN)
            .pollingMode(PollingMode.lazyLoad(ttl))
            .cache(cache)
            .build()
        sdk.getHooks().addOnConfigChanged {
            if (!firstConfig.complete(Unit)) {
                sdk.setOffline()
                freshConfig.complete(Unit)
            }
        }
        val api = createOpenFeatureAPIInstance()
        try {
            api.setProviderAndWait(ConfeatureProvider(sdk))
            val client = api.getClient()
            val cold = client.getStringDetails("region", "fallback")
            assertEquals("fallback", cold.value)
            assertEquals(ErrorCode.PROVIDER_NOT_READY, cold.errorCode)
            firstWrite.await()
            delay(ttl.inWholeMilliseconds + 50)

            val stale = coroutineScope {
                List(16) { async { client.getStringDetails("region", "fallback") } }.awaitAll()
            }
            assertTrue(stale.all { it.value == "stale" && it.variant == "stale" && it.errorCode == null })
            assertFalse(freshConfig.isCompleted)
            releaseWrite.complete(Unit)
            while (!freshConfig.isCompleted) {
                client.getStringDetails("region", "fallback")
                delay(10)
            }
            val fresh = client.getStringDetails("region", "fallback")
            assertEquals("fresh", fresh.value)
            assertEquals("fresh", fresh.variant)
            assertNull(fresh.errorCode)
            assertTrue(sdk.isOffline())
        } finally {
            releaseWrite.complete(Unit)
            try {
                api.shutdown()
            } finally {
                sdk.close()
            }
        }
    }
}
