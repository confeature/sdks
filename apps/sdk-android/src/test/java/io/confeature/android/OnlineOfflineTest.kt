// SPDX-License-Identifier: MIT
package io.confeature.android

import java.time.Duration
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Spec 092 / #267 — slice 3/14 — sdk-android online/offline triplet.
 *
 * Mirrors the upstream `com.configcat.ConfigCatClient.setOnline / setOffline / isOffline` surface,
 * including the LocalOnly + closed-client edge cases. The reflective conformance check lives in
 * [ApiSurfaceConformanceTest]; this file exercises behaviour.
 */
class OnlineOfflineTest {

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

    // ── default state ────────────────────────────────────────────────────

    @Test
    fun freshlyConstructedClientIsOnline() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            assertThat(client.isOffline()).isFalse
        } finally {
            client.close()
        }
    }

    // ── basic state transitions ──────────────────────────────────────────

    @Test
    fun setOfflineFlipsTheFlag() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            client.setOffline()
            assertThat(client.isOffline()).isTrue
        } finally {
            client.close()
        }
    }

    @Test
    fun setOnlineResetsTheFlag() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            client.setOffline()
            assertThat(client.isOffline()).isTrue
            client.setOnline()
            assertThat(client.isOffline()).isFalse
        } finally {
            client.close()
        }
    }

    @Test
    fun settersAreIdempotent() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            client.setOffline(); client.setOffline(); client.setOffline()
            assertThat(client.isOffline()).isTrue
            client.setOnline(); client.setOnline(); client.setOnline()
            assertThat(client.isOffline()).isFalse
        } finally {
            client.close()
        }
    }

    // ── forceRefresh interaction ─────────────────────────────────────────

    @Test
    fun forceRefreshReturnsFalseWhileOffline() {
        // No response enqueued — if forceRefresh DID issue HTTP it would fail. Asserting it
        // returns false without any outbound request is the strongest behavioural guard.
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build()
        try {
            client.setOffline()
            assertThat(client.forceRefresh()).isFalse
            assertThat(server.requestCount).isZero
        } finally {
            client.close()
        }
    }

    @Test
    fun forceRefreshRoundtripsAfterToggling() {
        server.enqueue(MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY))
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            client.setOffline()
            assertThat(client.forceRefresh()).isFalse
            assertThat(server.requestCount).isZero
            client.setOnline()
            assertThat(client.forceRefresh()).isTrue
            assertThat(server.requestCount).isEqualTo(1)
        } finally {
            client.close()
        }
    }

    // ── AutoPoll scheduler honours the offline flag ──────────────────────

    @Test
    fun autoPollSchedulerSuppressesFetchWhileOffline() {
        // Short interval + 200ms init wait so we can toggle offline before the first tick.
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.autoPoll(Duration.ofMillis(100), Duration.ofMillis(200)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build()
        try {
            client.setOffline()
            Thread.sleep(700)
            assertThat(server.requestCount).describedAs("offline scheduler must not fetch").isZero
        } finally {
            client.close()
        }
    }

    @Test
    fun autoPollSchedulerResumesAfterSetOnline() {
        server.enqueue(MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY))
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.autoPoll(Duration.ofMillis(100), Duration.ofMillis(200)))
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .httpTimeout(Duration.ofMillis(500))
            .build()
        try {
            client.setOffline()
            Thread.sleep(400)
            assertThat(server.requestCount).isZero
            client.setOnline()
            Thread.sleep(600)
            assertThat(server.requestCount)
                .describedAs("scheduler must resume after setOnline")
                .isGreaterThanOrEqualTo(1)
        } finally {
            client.close()
        }
    }

    // ── LocalOnly client semantics ───────────────────────────────────────

    @Test
    fun localOnlyClientIsOfflineByDefinition() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(
                FlagOverrides(MapOverrideDataSource(mapOf("feature.dark-mode" to true)), OverrideBehaviour.LOCAL_ONLY),
            )
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            assertThat(client.isOffline()).isTrue
        } finally {
            client.close()
        }
    }

    @Test
    fun localOnlySetOnlineLogsWarningAndIsNoOp() {
        val log = TestLogger()
        val client = ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(
                FlagOverrides(MapOverrideDataSource(mapOf("feature.dark-mode" to true)), OverrideBehaviour.LOCAL_ONLY),
            )
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build()
        try {
            client.setOnline()
            assertThat(client.isOffline()).describedAs("LocalOnly still reports offline=true").isTrue
            assertThat(log.allMessages())
                .describedAs("setOnline on LocalOnly emits a warning")
                .anyMatch { it.startsWith("WARN") && it.contains("LOCAL_ONLY") }
        } finally {
            client.close()
        }
    }

    @Test
    fun localOnlySetOfflineIsSilentNoOp() {
        val log = TestLogger()
        val client = ConfeatureClient.builder(SDK_KEY)
            .flagOverrides(
                FlagOverrides(MapOverrideDataSource(mapOf("feature.dark-mode" to true)), OverrideBehaviour.LOCAL_ONLY),
            )
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build()
        try {
            client.setOffline()
            assertThat(client.isOffline()).isTrue
            assertThat(log.allMessages())
                .describedAs("setOffline on LocalOnly is silent — no WARN")
                .noneMatch { it.startsWith("WARN") }
        } finally {
            client.close()
        }
    }

    // ── Closed-client semantics ──────────────────────────────────────────

    @Test
    fun closedClientReportsOffline() {
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        client.close()
        assertThat(client.isOffline()).isTrue
    }

    @Test
    fun closedClientSetOnlineLogsWarningAndIsNoOp() {
        val log = TestLogger()
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build()
        client.close()
        client.setOnline()
        assertThat(log.allMessages())
            .anyMatch { it.startsWith("WARN") && it.contains("setOnline called after close") }
    }

    @Test
    fun closedClientSetOfflineLogsWarningAndIsNoOp() {
        val log = TestLogger()
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(log)
            .build()
        client.close()
        client.setOffline()
        assertThat(log.allMessages())
            .anyMatch { it.startsWith("WARN") && it.contains("setOffline called after close") }
    }

    // ── getValue still serves the cached config while offline ────────────

    @Test
    fun getValueServesCachedConfigWhileOffline() {
        server.enqueue(MockResponse().setHeader("ETag", "\"etag-1\"").setBody(CONFIG_BODY))
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .build()
        try {
            assertThat(client.forceRefresh()).isTrue
            client.setOffline()
            assertThat(client.getValue("feature.dark-mode", false, null)).isEqualTo(true)
        } finally {
            client.close()
        }
    }
}
