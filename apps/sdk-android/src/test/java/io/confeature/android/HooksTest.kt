// SPDX-License-Identifier: MIT
package io.confeature.android

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Spec 104 / #268 — slice 2/14 — sdk-android hooks/events bus.
 *
 * Mirrors the upstream `com.configcat.ConfigCatHooks` surface — four hook points (clientReady,
 * configChanged, flagEvaluated, clientError). The reflective conformance check lives in
 * [ApiSurfaceConformanceTest]; this file exercises behaviour.
 */
class HooksTest {

    private companion object {
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        const val CONFIG_BODY =
            "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"}," +
                "\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"vid\",\"r\":[]}}," +
                "\"s\":[]}"
    }

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
    fun getHooksReturnsTheSameInstanceAcrossCalls() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            assertThat(client.getHooks()).isNotNull
            assertThat(client.getHooks()).isSameAs(client.getHooks())
        } finally {
            client.close()
        }
    }

    @Test
    fun clientReadyFiresOnceAfterFirstSuccessfulFetch() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))

        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        val fires = AtomicInteger(0)
        try {
            client.getHooks().addOnClientReady { fires.incrementAndGet() }
            assertThat(client.forceRefresh()).isTrue
            assertThat(client.forceRefresh()).isTrue
            assertThat(fires.get())
                .describedAs("clientReady fires exactly once")
                .isEqualTo(1)
        } finally {
            client.close()
        }
    }

    @Test
    fun configChangedFiresOnEverySuccessfulFetchAndCarriesSettings() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))

        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        val fires = AtomicInteger(0)
        val lastSettings = AtomicReference<Map<String, Any?>>()
        try {
            client.getHooks().addOnConfigChanged { settings ->
                fires.incrementAndGet()
                lastSettings.set(settings)
            }
            assertThat(client.forceRefresh()).isTrue
            assertThat(client.forceRefresh()).isTrue
            assertThat(fires.get())
                .describedAs("configChanged fires per successful fetch")
                .isEqualTo(2)
            assertThat(lastSettings.get()).containsKey("feature.dark-mode")
        } finally {
            client.close()
        }
    }

    @Test
    fun flagEvaluatedFiresOnEveryGetValueDetailsCall() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))

        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        val fires = AtomicInteger(0)
        val lastKey = AtomicReference<String>()
        try {
            client.forceRefresh()
            client.getHooks().addOnFlagEvaluated { details ->
                fires.incrementAndGet()
                lastKey.set(details.key)
            }
            client.getValueDetails("feature.dark-mode", false, null)
            client.getValueDetails("feature.unknown", false, null)
            assertThat(fires.get())
                .describedAs("flagEvaluated fires once per getValueDetails")
                .isEqualTo(2)
            assertThat(lastKey.get()).isEqualTo("feature.unknown")
        } finally {
            client.close()
        }
    }

    @Test
    fun clientErrorFiresOnFetchFailure() {
        server.enqueue(MockResponse().setResponseCode(500))

        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        val lastMessage = AtomicReference<String>()
        try {
            client.getHooks().addOnError { lastMessage.set(it) }
            assertThat(client.forceRefresh()).isFalse
            assertThat(lastMessage.get())
                .describedAs("clientError carries a non-empty message on fetch failure")
                .isNotNull()
                .isNotEmpty()
        } finally {
            client.close()
        }
    }

    @Test
    fun exceptionThrownByOneListenerDoesNotBreakOthers() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(CONFIG_BODY))

        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        val downstreamFires = AtomicInteger(0)
        try {
            client.getHooks().addOnConfigChanged { throw RuntimeException("boom") }
            client.getHooks().addOnConfigChanged { downstreamFires.incrementAndGet() }
            assertThat(client.forceRefresh()).isTrue
            assertThat(downstreamFires.get())
                .describedAs("a throwing listener does not prevent later listeners from firing")
                .isEqualTo(1)
        } finally {
            client.close()
        }
    }
}
