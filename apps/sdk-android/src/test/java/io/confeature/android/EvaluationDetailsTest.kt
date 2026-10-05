// SPDX-License-Identifier: MIT
package io.confeature.android

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Spec 081 / #266 slice 3/12 — unit tests for [ConfeatureClient.getValueDetails] and
 * [ConfeatureClient.getAllValues].
 *
 * Mirrors the 9-test set landed for sdk-java (spec 080 / PR #285). Uses [OverrideBehaviour.LOCAL_ONLY]
 * with [MapOverrideDataSource] so the tests do not require network access or a mocked CDN.
 */
class EvaluationDetailsTest {
    private companion object {
        const val VALID_SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    private fun buildClient(overrides: Map<String, Any?>): ConfeatureClient =
        ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overrides)))
            .build()

    @Test
    fun getValueDetails_returnsEnvelopeWithValueFromOverrides() {
        val client = buildClient(mapOf("flag" to true))
        try {
            val details = client.getValueDetails("flag", false, null)
            assertThat(details.key).isEqualTo("flag")
            assertThat(details.value).isEqualTo(true)
            assertThat(details.variationId).isNull()
            assertThat(details.isDefaultValue).isFalse
            assertThat(details.error).isNull()
            assertThat(details.matchedTargetingRule).isNull()
            assertThat(details.matchedPercentageOption).isNull()
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_returnsDefaultOnMissingKeyWithErrorCode() {
        val client = buildClient(mapOf("other.key" to true))
        try {
            val details = client.getValueDetails("missing.key", false, null)
            assertThat(details.key).isEqualTo("missing.key")
            assertThat(details.value).isEqualTo(false)
            assertThat(details.isDefaultValue).isTrue
            // LocalOnly contract: missing key surfaces as KEY_NOT_FOUND. Without overrides, the
            // evaluator path would return NO_CONFIG. Either is acceptable per the spec.
            assertThat(details.error).isIn("KEY_NOT_FOUND", "NO_CONFIG")
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_onClosedClient_returnsClientClosedError() {
        val client = buildClient(mapOf("flag" to true))
        client.close()
        val details = client.getValueDetails("flag", false, null)
        assertThat(details.key).isEqualTo("flag")
        assertThat(details.value).isEqualTo(false)
        assertThat(details.isDefaultValue).isTrue
        assertThat(details.error).isEqualTo("CLIENT_CLOSED")
    }

    @Test
    fun getValueDetails_onTypeMismatch_returnsDefault() {
        // Override is a boolean; ask for a String default → TYPE_MISMATCH.
        val client = buildClient(mapOf("flag" to true))
        try {
            val details = client.getValueDetails("flag", "default-string", null)
            assertThat(details.value).isEqualTo("default-string")
            assertThat(details.isDefaultValue).isTrue
            assertThat(details.error).isEqualTo("TYPE_MISMATCH")
        } finally {
            client.close()
        }
    }

    @Test
    fun getAllValues_returnsResolvedMapForAllOverrides() {
        val client = buildClient(
            linkedMapOf(
                "flag.a" to true,
                "flag.b" to false,
                "flag.s" to "hello",
            ),
        )
        try {
            val all = client.getAllValues(null)
            assertThat(all).hasSize(3)
            assertThat(all).containsEntry("flag.a", true)
            assertThat(all).containsEntry("flag.b", false)
            assertThat(all).containsEntry("flag.s", "hello")
        } finally {
            client.close()
        }
    }

    @Test
    fun getAllValues_onClosedClient_returnsEmptyMap() {
        val client = buildClient(mapOf("flag" to true))
        client.close()
        assertThat(client.getAllValues(null)).isEmpty()
    }

    @Test
    fun getAllValues_withNoConfig_returnsEmptyMap() {
        // No overrides; no cached config; manual-poll so no fetch happens.
        val client = ConfeatureClient.builder(VALID_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(emptyMap())))
            .build()
        try {
            assertThat(client.getAllValues(null)).isEmpty()
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueDetails_userPropagation() {
        val client = buildClient(mapOf("flag" to true))
        try {
            val user = User.builder("targeting-id-123").email("test@example.com").build()
            val details = client.getValueDetails("flag", false, user)
            assertThat(details.user).isSameAs(user)
        } finally {
            client.close()
        }
    }

    @Test
    fun snapshot_getValueDetails_mirrorsClient() {
        val client = buildClient(mapOf("flag" to true))
        try {
            val clientDetails = client.getValueDetails("flag", false, null)
            val snap = client.snapshot()
            val snapDetails = snap.getValueDetails("flag", false, null)
            assertThat(snapDetails.key).isEqualTo(clientDetails.key)
            assertThat(snapDetails.value).isEqualTo(clientDetails.value)
            assertThat(snapDetails.isDefaultValue).isEqualTo(clientDetails.isDefaultValue)
            assertThat(snapDetails.error).isEqualTo(clientDetails.error)
            assertThat(snapDetails.fetchTimeUnixMilliseconds)
                .isEqualTo(clientDetails.fetchTimeUnixMilliseconds)
        } finally {
            client.close()
        }
    }
}
