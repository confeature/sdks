// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as an ordinary key of
 * config_v6 `f`. A JS SDK once dropped it by copying settings into a plain object; this holds the
 * Kotlin MP SDK to keeping it from the served bytes and from a local override.
 */
class ProtoKeyTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    private val served = "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"}," +
        "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}"

    @Test
    fun servedProtoFlagReturnsItsServedValue() = runBlocking {
        RawHttpListener(RawHttpListener.okResponse(served)).use { listener ->
            val client = ConfeatureClient.builder(sdkKey)
                .pollingMode(PollingMode.manualPoll())
                .cacheDirectory(":memory:")
                .baseUrl(listener.baseUrl)
                .logger(CapturingLogger())
                .build()
            try {
                assertTrue(client.forceRefresh())
                assertEquals(true, client.getValue("__proto__", false))
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun localOnlyOverrideKeyedProtoReturnsTheOverride() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl("https://mock.confeature.test")
            .logger(CapturingLogger())
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("__proto__" to true))))
            .build()
        try {
            assertEquals(true, client.getValue("__proto__", false))
        } finally {
            client.close()
        }
    }
}
