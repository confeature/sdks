// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.FlagEvaluationDetails
import dev.openfeature.kotlin.sdk.FlagEvaluationOptions
import dev.openfeature.kotlin.sdk.Hook
import dev.openfeature.kotlin.sdk.HookContext
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.exceptions.OpenFeatureError
import dev.openfeature.kotlin.sdk.isolated.ExperimentalIsolatedApi
import dev.openfeature.kotlin.sdk.isolated.createOpenFeatureAPIInstance
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.FlagOverrides
import io.confeature.kmp.TypedEvaluationDetails
import io.confeature.kmp.User
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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

            val client = primary.getClient()
            val targeted = client.getBooleanDetails("flag", true)
            assertEquals(true, targeted.value)
            assertEquals("fixture-targeted", targeted.variant)
            assertEquals(Reason.TARGETING_MATCH.name, targeted.reason)
            assertNull(targeted.errorCode)

            val default = anonymous.getClient().getBooleanDetails("flag", false)
            assertEquals(false, default.value)
            assertEquals("fixture-default", default.variant)
            assertNull(default.errorCode)

            val decimal = client.getDoubleDetails("decimal", 0.0)
            assertEquals(1.0, decimal.value)
            assertNull(decimal.errorCode)
            assertEquals(1, client.getIntegerDetails("integer", 0).value)
            assertEquals(1L, client.getLongDetails("integer", Long.MAX_VALUE).value)
            val missing = client.getLongDetails("missing", Long.MAX_VALUE)
            assertEquals(Long.MAX_VALUE, missing.value)
            assertEquals(ErrorCode.FLAG_NOT_FOUND, missing.errorCode)
            val mistyped = client.getDoubleDetails("integer", 2.5)
            assertEquals(2.5, mistyped.value)
            assertEquals(ErrorCode.TYPE_MISMATCH, mistyped.errorCode)

            val split = client.getBooleanDetails("rollout", false)
            assertEquals(true, split.value)
            assertEquals("fixture-split", split.variant)
            assertEquals(Reason.SPLIT.name, split.reason)
            assertNull(split.errorCode)
            assertEquals(false, anonymous.getClient().getBooleanValue("rollout", true))

            val fallback = Value.Structure(mapOf("note" to Value.String("fixture")))
            val objectDetails = client.getObjectDetails("flag", fallback)
            assertEquals(fallback, objectDetails.value)
            assertEquals(ErrorCode.TYPE_MISMATCH, objectDetails.errorCode)
            assertEquals(9, details.size)
            assertTrue(details.all { it.user == null })

            primary.setProviderAndWait(ConfeatureProvider(base))
            assertFailsWith<OpenFeatureError.ProviderNotReadyError> {
                adapter.getBooleanEvaluation("flag", false, null)
            }
            assertEquals(true, base.getValueDetails("flag", false).value)
        } finally {
            primary.shutdown()
            anonymous.shutdown()
            base.close()
        }
    }

    @Test
    fun officialClientRunsAfterHooksForSuccessAndErrorHooksForAFallback() = runTest {
        val base = ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
            .flagOverrides(FlagOverrides.localConfig(config()))
            .build()
        val api = createOpenFeatureAPIInstance()
        try {
            api.setProviderAndWait(ConfeatureProvider(base))
            val events = mutableListOf<String>()
            val hook = object : Hook<Boolean> {
                override fun after(
                    ctx: HookContext<Boolean>,
                    details: FlagEvaluationDetails<Boolean>,
                    hints: Map<String, Any>,
                ) {
                    events.add("after")
                }

                override fun error(ctx: HookContext<Boolean>, error: Exception, hints: Map<String, Any>) {
                    assertTrue(error is OpenFeatureError.FlagNotFoundError)
                    events.add("error")
                }

                override fun finallyAfter(
                    ctx: HookContext<Boolean>,
                    details: FlagEvaluationDetails<Boolean>,
                    hints: Map<String, Any>,
                ) {
                    events.add("finally")
                }
            }
            val options = FlagEvaluationOptions(hooks = listOf(hook))
            val client = api.getClient()
            val resolved = client.getBooleanDetails("flag", true, options)
            assertEquals(false, resolved.value)
            assertNull(resolved.errorCode)
            val fallback = client.getBooleanDetails("missing", true, options)
            assertEquals(true, fallback.value)
            assertEquals(ErrorCode.FLAG_NOT_FOUND, fallback.errorCode)
            assertEquals(Reason.ERROR.name, fallback.reason)
            assertEquals(listOf("after", "finally", "error", "finally"), events)
        } finally {
            try {
                api.shutdown()
            } finally {
                base.close()
            }
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
            "rollout" to mapOf(
                "t" to 0,
                "v" to mapOf("b" to false),
                "p" to listOf(mapOf("p" to 100, "v" to mapOf("b" to true), "i" to "fixture-split")),
            ),
        ),
    )
}
