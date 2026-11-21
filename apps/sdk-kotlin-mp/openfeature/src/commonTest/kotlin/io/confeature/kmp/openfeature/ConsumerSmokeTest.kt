// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.isolated.ExperimentalIsolatedApi
import dev.openfeature.kotlin.sdk.isolated.createOpenFeatureAPIInstance
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.FlagOverrides
import io.confeature.kmp.TypedEvaluationDetails
import io.confeature.kmp.User
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalIsolatedApi::class)
class ConsumerSmokeTest {
    @Test
    fun officialClientEvaluatesStaticContextsAndKeepsRetiredAdapterSeparateFromTheSdk() = runTest {
        val base = ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
            .defaultUser(User("targeted"))
            .flagOverrides(FlagOverrides.localConfig(config()))
            .build()
        val details = mutableListOf<TypedEvaluationDetails<*>>()
        base.getHooks().addOnFlagEvaluated { details.add(it) }
        val primary = createOpenFeatureAPIInstance()
        val anonymous = createOpenFeatureAPIInstance()
        val adapter = ConfeatureProvider(base)
        try {
            primary.setProviderAndWait(adapter)
            anonymous.setProviderAndWait(ConfeatureProvider(base))
            primary.setEvaluationContextAndWait(ImmutableContext("targeted", mapOf("Identifier" to Value.String("bad"))))

            val targeted = primary.getClient().getBooleanDetails("flag", true)
            assertEquals(true, targeted.value)
            assertEquals("fixture-targeted", targeted.variant)
            assertEquals(Reason.TARGETING_MATCH.name, targeted.reason)
            assertNull(targeted.errorCode)

            val default = anonymous.getClient().getBooleanDetails("flag", false)
            assertEquals(false, default.value)
            assertEquals("fixture-default", default.variant)
            assertNull(default.errorCode)

            val decimal = primary.getClient().getDoubleDetails("decimal", 0.0)
            assertEquals(1.0, decimal.value)
            assertNull(decimal.errorCode)
            assertEquals(1L, primary.getClient().getLongDetails("integer", Long.MAX_VALUE).value)
            val missing = primary.getClient().getLongDetails("missing", Long.MAX_VALUE)
            assertEquals(Long.MAX_VALUE, missing.value)
            assertEquals(ErrorCode.FLAG_NOT_FOUND, missing.errorCode)
            assertEquals(5, details.size)
            assertTrue(details.all { it.user == null })

            primary.setProviderAndWait(ConfeatureProvider(base))
            assertEquals(ErrorCode.PROVIDER_NOT_READY, adapter.getBooleanEvaluation("flag", false, null).errorCode)
            assertEquals(true, base.getValueDetails("flag", false).value)
        } finally {
            primary.shutdown()
            anonymous.shutdown()
            base.close()
        }
    }

    private fun config(): Map<String, Any?> = mapOf(
        "f" to mapOf(
            "flag" to mapOf(
                "t" to 0,
                "v" to mapOf("b" to false),
                "i" to "fixture-default",
                "r" to listOf(
                    mapOf(
                        "c" to listOf(mapOf("u" to mapOf("a" to "Identifier", "c" to 0, "l" to listOf("targeted")))),
                        "s" to mapOf("v" to mapOf("b" to true), "i" to "fixture-targeted"),
                    ),
                ),
            ),
            "decimal" to mapOf("t" to 3, "v" to mapOf("d" to 1.0)),
            "integer" to mapOf("t" to 2, "v" to mapOf("i" to 1)),
        ),
    )
}
