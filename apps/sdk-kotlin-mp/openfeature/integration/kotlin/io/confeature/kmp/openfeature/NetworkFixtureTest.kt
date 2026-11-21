// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.isolated.ExperimentalIsolatedApi
import dev.openfeature.kotlin.sdk.isolated.createOpenFeatureAPIInstance
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.PollingMode
import io.confeature.kmp.TypedEvaluationDetails
import io.confeature.kmp.User
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalIsolatedApi::class)
class NetworkFixtureTest {
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
        val targetedApi = createOpenFeatureAPIInstance()
        val anonymousApi = createOpenFeatureAPIInstance()
        try {
            targetedApi.setProviderAndWait(ConfeatureProvider(sdk))
            anonymousApi.setProviderAndWait(ConfeatureProvider(sdk))
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
        } finally {
            try {
                targetedApi.shutdown()
                anonymousApi.shutdown()
            } finally {
                sdk.close()
            }
        }
    }
}
