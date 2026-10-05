// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 093 / #267 — slice 4/14 — sdk-kotlin-mp online/offline triplet.
 *
 * Mirrors the upstream `com.configcat.ConfigCatClient.setOnline / setOffline / isOffline`
 * surface, including the LocalOnly + closed-client edge cases. Conformance lives in
 * [ApiSurfaceConformanceTest]; this file exercises behaviour.
 *
 * Test fixture: `:memory:` cache + the public Builder API (no Ktor engine injection — that
 * would need plumbing the Builder doesn't expose). The scheduler-with-MockEngine path is
 * therefore not exercised here; the [ApiSurfaceConformanceTest] presence check plus the
 * structural fetch gate in `fetchAndApply` cover it by construction.
 */
class OnlineOfflineTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private fun buildClient(
        pollingMode: PollingMode = PollingMode.manualPoll(),
        logger: Logger = CapturingLogger(),
        flagOverrides: FlagOverrides? = null,
    ): ConfeatureClient {
        val b = ConfeatureClient.builder(sdkKey)
            .pollingMode(pollingMode)
            .cacheDirectory(":memory:")
            .baseUrl("https://mock.confeature.test")
            .logger(logger)
        if (flagOverrides != null) b.flagOverrides(flagOverrides)
        return b.build()
    }

    // ── default state ────────────────────────────────────────────────────

    @Test
    fun freshlyConstructedClientIsOnline() {
        val client = buildClient()
        try {
            assertFalse(client.isOffline())
        } finally {
            client.close()
        }
    }

    // ── state transitions ────────────────────────────────────────────────

    @Test
    fun setOfflineFlipsTheFlag() {
        val client = buildClient()
        try {
            client.setOffline()
            assertTrue(client.isOffline())
        } finally {
            client.close()
        }
    }

    @Test
    fun setOnlineResetsTheFlag() {
        val client = buildClient()
        try {
            client.setOffline()
            assertTrue(client.isOffline())
            client.setOnline()
            assertFalse(client.isOffline())
        } finally {
            client.close()
        }
    }

    @Test
    fun settersAreIdempotent() {
        val client = buildClient()
        try {
            client.setOffline(); client.setOffline(); client.setOffline()
            assertTrue(client.isOffline())
            client.setOnline(); client.setOnline(); client.setOnline()
            assertFalse(client.isOffline())
        } finally {
            client.close()
        }
    }

    // ── forceRefresh interaction ─────────────────────────────────────────

    @Test
    fun forceRefreshReturnsFalseWhileOffline() = runBlocking {
        val client = buildClient()
        try {
            client.setOffline()
            assertFalse(client.forceRefresh())
        } finally {
            client.close()
        }
    }

    // ── LocalOnly semantics ──────────────────────────────────────────────

    @Test
    fun localOnlyClientIsOfflineByDefinition() {
        val client = buildClient(
            flagOverrides = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("feature.x" to true))),
        )
        try {
            assertTrue(client.isOffline())
        } finally {
            client.close()
        }
    }

    @Test
    fun localOnlySetOnlineLogsWarningAndIsNoOp() {
        val log = CapturingLogger()
        val client = buildClient(
            logger = log,
            flagOverrides = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("feature.x" to true))),
        )
        try {
            client.setOnline()
            assertTrue(client.isOffline(), "LocalOnly still reports offline=true")
            assertTrue(
                log.messages.any { it.startsWith("WARN") && it.contains("LOCAL_ONLY") },
                "setOnline on LocalOnly must emit a warning",
            )
        } finally {
            client.close()
        }
    }

    @Test
    fun localOnlySetOfflineIsSilentNoOp() {
        val log = CapturingLogger()
        val client = buildClient(
            logger = log,
            flagOverrides = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("feature.x" to true))),
        )
        try {
            client.setOffline()
            assertTrue(client.isOffline())
            assertFalse(
                log.messages.any { it.startsWith("WARN") },
                "setOffline on LocalOnly must be silent — no WARN",
            )
        } finally {
            client.close()
        }
    }

    // ── Closed-client semantics ──────────────────────────────────────────

    @Test
    fun closedClientReportsOffline() {
        val client = buildClient()
        client.close()
        assertTrue(client.isOffline())
    }

    @Test
    fun closedClientSetOnlineLogsWarningAndIsNoOp() {
        val log = CapturingLogger()
        val client = buildClient(logger = log)
        client.close()
        client.setOnline()
        assertTrue(
            log.messages.any { it.startsWith("WARN") && it.contains("setOnline called after close") },
            "setOnline on closed client must log a WARN",
        )
    }

    @Test
    fun closedClientSetOfflineLogsWarningAndIsNoOp() {
        val log = CapturingLogger()
        val client = buildClient(logger = log)
        client.close()
        client.setOffline()
        assertTrue(
            log.messages.any { it.startsWith("WARN") && it.contains("setOffline called after close") },
            "setOffline on closed client must log a WARN",
        )
    }

    // ── Cached value still served while offline (LocalOnly resolves via override) ─

    @Test
    fun localOnlyGetValueWorksWhileOffline() = runBlocking {
        val client = buildClient(
            flagOverrides = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("feature.x" to true))),
        )
        try {
            // LocalOnly is already offline by definition — the override path still resolves.
            assertEquals(true, client.getValue("feature.x", false))
        } finally {
            client.close()
        }
    }
}
