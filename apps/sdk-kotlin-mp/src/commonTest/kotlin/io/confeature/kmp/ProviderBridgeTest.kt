// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.Evaluator
import io.confeature.kmp.internal.ProviderResult.Match
import io.confeature.kmp.internal.ProviderResult.Status
import io.confeature.kmp.internal.ProviderValueType
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProviderBridgeTest {
    @Test
    fun usesExplicitIdentityAndOmitsItFromHooks() = runTest {
        val client = clientWithOverrides(FlagOverrides.localConfig(config()))
        val events = mutableListOf<TypedEvaluationDetails<*>>()
        client.getHooks().addOnFlagEvaluated { events.add(it) }
        try {
            val targeted = client.getValueDetailsForProvider(
                "flag", false, Evaluator.fromPublicUser(User("targeted")), ProviderValueType.BOOLEAN,
            )
            assertEquals(true, targeted.value)
            assertEquals("targeted-variant", targeted.variationId)
            assertEquals(Match.TARGETING_RULE, targeted.match)
            val anonymous = client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN)
            assertEquals(Status.RESOLVED, anonymous.status)
            assertEquals(false, anonymous.value)
            assertEquals("default-variant", anonymous.variationId)
            assertNull(anonymous.match)
            assertEquals(2, events.size)
            assertTrue(events.all { it.user == null })
            val native = client.getValueDetails("flag", false)
            assertEquals(User("targeted"), native.user)
            assertEquals(true, native.value)
        } finally {
            client.close()
        }
    }

    @Test
    fun respectsWireNumericTypesAndRetainsCallerFallback() {
        val client = clientWithOverrides(FlagOverrides.localConfig(config()))
        try {
            val decimal = client.getValueDetailsForProvider("decimal", 0.0, null, ProviderValueType.DOUBLE)
            assertEquals(Status.RESOLVED, decimal.status)
            assertEquals(1.0, decimal.value)
            val wrongDecimal = client.getValueDetailsForProvider("integer", 12.0, null, ProviderValueType.DOUBLE)
            assertEquals(Status.TYPE_MISMATCH, wrongDecimal.status)
            assertEquals(12.0, wrongDecimal.value)
            val integer = client.getValueDetailsForProvider("integer", Long.MAX_VALUE, null, ProviderValueType.INTEGER)
            assertEquals(Status.RESOLVED, integer.status)
            assertEquals(1, integer.value)
            val missing = client.getValueDetailsForProvider("missing", Long.MAX_VALUE, null, ProviderValueType.INTEGER)
            assertEquals(Status.NOT_FOUND, missing.status)
            assertEquals(Long.MAX_VALUE, missing.value)
        } finally {
            client.close()
        }
    }

    @Test
    fun doesNotChooseADefaultPercentageBucketWithoutAnIdentifier() {
        val client = clientWithOverrides(FlagOverrides.localConfig(config()))
        val context = object : Evaluator.UserView {
            override fun identifier(): String? = null
            override fun attribute(name: String): Any? = if (name == "Country") "FR" else null
        }
        try {
            val anonymous = client.getValueDetailsForProvider("rollout", false, context, ProviderValueType.BOOLEAN)
            assertEquals(false, anonymous.value)
            assertNull(anonymous.match)
            val identified = client.getValueDetailsForProvider(
                "rollout", false, Evaluator.fromPublicUser(User("another")), ProviderValueType.BOOLEAN,
            )
            assertEquals(true, identified.value)
            assertEquals(Match.PERCENTAGE_OPTION, identified.match)
            assertEquals("split-variant", identified.variationId)
        } finally {
            client.close()
        }
    }

    @Test
    fun keepsFlatOverridesTypedWhenTheHookAndLoggerFail() {
        val logs = mutableListOf<String>()
        val loggedFailures = mutableListOf<Throwable?>()
        val logger = object : Logger by Logger.default() {
            override fun error(message: String, throwable: Throwable?) {
                logs.add(message)
                loggedFailures.add(throwable)
                kotlin.error("fixture logger failure")
            }
        }
        val overrides = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("int" to 1, "fraction" to 1.25)))
        val client = clientWithOverrides(overrides, logger)
        val details = mutableListOf<TypedEvaluationDetails<*>>()
        client.getHooks().addOnFlagEvaluated { error("fixture raw context sentinel") }
        client.getHooks().addOnFlagEvaluated { details.add(it) }
        try {
            val wrong = client.getValueDetailsForProvider("int", 0.0, null, ProviderValueType.DOUBLE)
            assertEquals(Status.TYPE_MISMATCH, wrong.status)
            val valid = client.getValueDetailsForProvider("fraction", 0.0, null, ProviderValueType.DOUBLE)
            assertEquals(Status.RESOLVED, valid.status)
            assertEquals(1.25, valid.value)
            val wrongInt = client.getValueDetailsForProvider("fraction", 0, null, ProviderValueType.INTEGER)
            assertEquals(Status.TYPE_MISMATCH, wrongInt.status)
            assertEquals(3, details.size)
            assertEquals(List(3) { "ConfeatureHooks: onFlagEvaluated listener raised." }, logs)
            assertTrue(loggedFailures.all { it == null })
        } finally {
            client.close()
        }
    }

    @Test
    fun emitsOnlyEstablishedMetadataAndMapsOpaqueFailures() = runTest {
        val client = clientWithOverrides(FlagOverrides.localConfig(config()))
        val events = mutableListOf<TypedEvaluationDetails<*>>()
        client.getHooks().addOnFlagEvaluated { events.add(it) }
        try {
            val noVariant = client.getValueDetailsForProvider(
                "anonymous-variant", false, Evaluator.fromPublicUser(User("targeted")), ProviderValueType.BOOLEAN,
            )
            assertEquals(Status.RESOLVED, noVariant.status)
            assertEquals(Match.TARGETING_RULE, noVariant.match)
            assertNull(noVariant.variationId)
            assertEquals("default-variant", client.getValueDetails("anonymous-variant", false).variationId)

            val invalid = client.getValueDetailsForProvider("not-finite", 3.5, null, ProviderValueType.DOUBLE)
            assertEquals(Status.PARSE_ERROR, invalid.status)
            assertEquals(3.5, invalid.value)
            assertTrue(events.last().isDefaultValue)

            val failingContext = object : Evaluator.UserView {
                override fun identifier(): String = "targeted"
                override fun attribute(name: String): Any? = error("fixture raw context sentinel")
            }
            val failed = client.getValueDetailsForProvider("flag", false, failingContext, ProviderValueType.BOOLEAN)
            assertEquals(Status.GENERAL, failed.status)
            assertEquals(false, failed.value)
            assertEquals("EVALUATION_ERROR", events.last().error)
            assertNull(events.last().user)
        } finally {
            client.close()
        }
    }

    private fun clientWithOverrides(overrides: FlagOverrides, logger: Logger = Logger.default()): ConfeatureClient =
        ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .defaultUser(User("targeted"))
            .flagOverrides(overrides)
            .logger(logger)
            .build()

    private fun config(): Map<String, Any?> = mapOf(
        "f" to mapOf(
            "flag" to targetedFlag("targeted-variant"),
            "anonymous-variant" to targetedFlag(null),
            "decimal" to mapOf("t" to 3, "v" to mapOf("d" to 1.0)),
            "not-finite" to mapOf("t" to 3, "v" to mapOf("d" to Double.POSITIVE_INFINITY)),
            "integer" to mapOf("t" to 2, "v" to mapOf("i" to 1)),
            "rollout" to mapOf(
                "t" to 0,
                "v" to mapOf("b" to false),
                "p" to listOf(mapOf("p" to 100, "v" to mapOf("b" to true), "i" to "split-variant")),
            ),
        ),
    )

    private fun targetedFlag(variant: String?): Map<String, Any?> = mapOf(
        "t" to 0,
        "v" to mapOf("b" to false),
        "i" to "default-variant",
        "r" to listOf(
            mapOf(
                "c" to listOf(mapOf("u" to mapOf("a" to "Identifier", "c" to 0, "l" to listOf("targeted")))),
                "s" to mapOf("v" to mapOf("b" to true), "i" to variant),
            ),
        ),
    )
}
