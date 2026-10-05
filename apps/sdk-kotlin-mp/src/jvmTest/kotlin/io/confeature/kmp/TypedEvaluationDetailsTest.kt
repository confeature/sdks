// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Spec 082 / #266 slice 4/12 — unit tests for [ConfeatureClient.getValueDetails] and
 * [ConfeatureClient.getAllValues].
 *
 * <p>Mirrors the 9-test set landed for sdk-android (spec 081 / PR #286) adapted to the suspend
 * Kotlin Multiplatform shape — every client-level assertion is driven through
 * [kotlinx.coroutines.test.runTest] so the suspend functions execute on a test coroutine. Uses
 * [OverrideBehaviour.LOCAL_ONLY] with [MapOverrideDataSource] so no network access or mocked CDN
 * is required.
 */
class TypedEvaluationDetailsTest {
    private companion object {
        const val VALID_SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    private fun buildClient(overrides: Map<String, Any>): ConfeatureClient =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overrides)))
            .build()

    @Test
    fun getValueDetails_returnsEnvelopeWithValueFromOverrides() = runTest {
        val client = buildClient(mapOf("flag" to true))
        try {
            val details = client.getValueDetails("flag", false, null)
            assertEquals("flag", details.key)
            assertEquals(true, details.value)
            assertNull(details.variationId)
            assertFalse(details.isDefaultValue)
            assertNull(details.error)
            assertNull(details.matchedTargetingRule)
            assertNull(details.matchedPercentageOption)
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_returnsDefaultOnMissingKeyWithErrorCode() = runTest {
        val client = buildClient(mapOf("other.key" to true))
        try {
            val details = client.getValueDetails("missing.key", false, null)
            assertEquals("missing.key", details.key)
            assertEquals(false, details.value)
            assertTrue(details.isDefaultValue)
            // LocalOnly contract: missing key surfaces as KEY_NOT_FOUND. Without overrides, the
            // evaluator path would return NO_CONFIG. Either is acceptable per the spec.
            assertTrue(
                details.error == "KEY_NOT_FOUND" || details.error == "NO_CONFIG",
                "expected KEY_NOT_FOUND or NO_CONFIG; got ${details.error}",
            )
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_onClosedClient_returnsClientClosedError() = runTest {
        val client = buildClient(mapOf("flag" to true))
        client.close()
        val details = client.getValueDetails("flag", false, null)
        assertEquals("flag", details.key)
        assertEquals(false, details.value)
        assertTrue(details.isDefaultValue)
        assertEquals("CLIENT_CLOSED", details.error)
    }

    @Test
    fun getValueDetails_onTypeMismatch_returnsDefault() = runTest {
        // Override is a boolean; ask for a String default → TYPE_MISMATCH.
        val client = buildClient(mapOf("flag" to true))
        try {
            val details = client.getValueDetails("flag", "default-string", null)
            assertEquals("default-string", details.value)
            assertTrue(details.isDefaultValue)
            assertEquals("TYPE_MISMATCH", details.error)
        } finally {
            client.close()
        }
    }

    @Test
    fun getAllValues_returnsResolvedMapForAllOverrides() = runTest {
        val client = buildClient(
            linkedMapOf(
                "flag.a" to true,
                "flag.b" to false,
                "flag.s" to "hello",
            ),
        )
        try {
            val all = client.getAllValues(null)
            assertEquals(3, all.size)
            assertEquals(true, all["flag.a"])
            assertEquals(false, all["flag.b"])
            assertEquals("hello", all["flag.s"])
        } finally {
            client.close()
        }
    }

    @Test
    fun getAllValues_onClosedClient_returnsEmptyMap() = runTest {
        val client = buildClient(mapOf("flag" to true))
        client.close()
        assertTrue(client.getAllValues(null).isEmpty())
    }

    @Test
    fun getAllValues_withNoConfig_returnsEmptyMap() = runTest {
        // No overrides; no cached config; manual-poll so no fetch happens.
        val client = ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(emptyMap())))
            .build()
        try {
            assertTrue(client.getAllValues(null).isEmpty())
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_userPropagation() = runTest {
        val client = buildClient(mapOf("flag" to true))
        try {
            val user = User("targeting-id-123", email = "test@example.com")
            val details = client.getValueDetails("flag", false, user)
            assertSame(user, details.user)
        } finally {
            client.close()
        }
    }

    @Test
    fun snapshot_getValueDetails_mirrorsClient() = runTest {
        val client = buildClient(mapOf("flag" to true))
        try {
            val clientDetails = client.getValueDetails("flag", false, null)
            val snap = client.snapshot()
            val snapDetails = snap.getValueDetails("flag", false, null)
            assertEquals(clientDetails.key, snapDetails.key)
            assertEquals(clientDetails.value, snapDetails.value)
            assertEquals(clientDetails.isDefaultValue, snapDetails.isDefaultValue)
            assertEquals(clientDetails.error, snapDetails.error)
            assertEquals(
                clientDetails.fetchTimeUnixMilliseconds,
                snapDetails.fetchTimeUnixMilliseconds,
            )
        } finally {
            client.close()
        }
    }
}
