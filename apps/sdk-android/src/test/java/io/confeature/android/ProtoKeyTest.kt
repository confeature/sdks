// SPDX-License-Identifier: MIT
package io.confeature.android

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as an ordinary key of
 * config_v6 `f`. A JS SDK once dropped it by copying settings into a plain object; this holds the
 * Android SDK to keeping it from the served bytes and from a local override.
 */
class ProtoKeyTest {

    private lateinit var server: MockWebServer

    @BeforeEach
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach
    fun stop() {
        server.shutdown()
    }

    @Test
    fun servedProtoFlagReturnsItsServedValue() {
        server.enqueue(MockResponse().setBody(SERVED))
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            assertThat(client.forceRefresh()).isTrue
            assertThat(client.getValue("__proto__", false, null)).isEqualTo(true)
        } finally {
            client.close()
        }
    }

    @Test
    fun localOnlyOverrideKeyedProtoReturnsTheOverride() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("__proto__" to true))))
            .build()
        try {
            assertThat(client.getValue("__proto__", false, null)).isEqualTo(true)
        } finally {
            client.close()
        }
    }

    private companion object {
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        const val SERVED = "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"}," +
            "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}"
    }
}
