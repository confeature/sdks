// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.TestFactory
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * sdk-kotlin-mp live wire-cases (#922, after sdk-go's #921).
 *
 * The JVM target's own [ConfigFetcher] — its production Ktor CIO client — against a RUNNING
 * live-contract harness serving the reference origin of the CDN read path. Every seeded wire-case
 * is replayed and judged by [WireCaseAssertions.assertWireCase], the SAME rules the hermetic
 * [WireCasesTest] applies to Ktor's MockEngine. Nothing is hand-built and no admin write is made:
 *
 * - the case set comes from the running harness (`GET /admin/state` → `keys`), never recomputed
 *   from the corpus — `http-403`, an unseeded key answered by the Worker itself, among them;
 * - the request each case sent is read back from the harness (`GET /admin/requests?sdkKey=`), and
 *   each fetch must add exactly one entry;
 * - a timeout case is ended by the fetcher's OWN deadline, a quarter of the harness's hold.
 *
 * Each case is its own dynamic test, so one failing case never hides another. Run it through the
 * manifest's `liveSuite.runner` (the harness's `--corpus-seed --exec --`).
 *
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the hermetic `check`. When
 * it is set without `LIVE_HARNESS_URL`, or the harness does not answer, the test FAILS; it never
 * skips.
 */
class WireCasesLiveTest {
    @TestFactory
    fun wireCasesLive(): List<DynamicTest> {
        assumeTrue(System.getenv("CONFEATURE_LIVE") == "1", "hermetic run: CONFEATURE_LIVE is not set")
        val url = System.getenv("LIVE_HARNESS_URL")?.trim().orEmpty()
        if (url.isEmpty()) {
            fail<Unit>(
                "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " +
                    "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never " +
                    "pass by skipping",
            )
        }
        val harness = Harness(url.trimEnd('/'))
        val state = harness.get("/admin/state")
        val keys = (state["keys"] as JsonArray).map { it.jsonPrimitive.content }.sorted()
        val faults = state["faults"] as? JsonObject ?: JsonObject(emptyMap())
        val corpus = WireCaseAssertions.casesById()

        val seededSet = dynamicTest("seeded-set") {
            assertTrue(
                keys.isNotEmpty(),
                "the harness reports no seeded case — an empty run checks nothing",
            )
            assertEquals(emptyList<String>(), keys - corpus.keys, "seeded keys missing from the corpus")
        }
        // A stray key is reported by seeded-set.
        val cases = keys.mapNotNull { id ->
            corpus[id]?.let { wireCase -> dynamicTest(id) { liveCase(harness, id, wireCase, faults) } }
        }
        // US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's 403 since #785,
        // classed like a 404 as invalidSdkKey.
        val unseeded = dynamicTest("unseeded-key") {
            val result = fetchOnce(harness.base, "never-seeded-922", DEFAULT_DEADLINE_MS, "")
            assertEquals(ConfigFetcher.Status.FAILED, result.status)
            assertEquals(
                "invalidSdkKey",
                WireCaseAssertions.kotlinMpErrorToClass(result.error),
                "errorClass (raw=${result.error})",
            )
        }
        return listOf(seededSet) + cases + unseeded
    }

    /** One seeded case: one fetch, exactly one logged request, judged by the shared rules. */
    private fun liveCase(harness: Harness, id: String, wireCase: JsonObject, faults: JsonObject) {
        val hold = holdMillis(id, wireCase, faults)
        val deadline = if (hold > 0) hold / 4 else DEFAULT_DEADLINE_MS
        // The harness seeds each case under its id; a case that pins given.sdkKey is configured
        // with that key instead (#803 FR-003).
        val given = wireCase["given"] as JsonObject
        val sdkKey = WireCaseAssertions.field(given, "sdkKey") ?: id
        val loggedBefore = harness.requestsFor(sdkKey).size

        val started = System.nanoTime()
        val previousEtag = WireCaseAssertions.field(given, "previousEtag").orEmpty()
        val result = fetchOnce(harness.base, sdkKey, deadline, previousEtag)
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI

        val log = harness.requestsFor(sdkKey)
        // Exactly one request per fetch: a retrying SDK, or a request logged by an earlier run,
        // must not stand in for the one under test.
        assertEquals(1, log.size - loggedBefore, "requests one fetch sent (case=$id)")
        if (hold > 0) {
            // The fetcher's own deadline ended the fetch, not the harness releasing it.
            assertTrue(elapsedMs < hold, "case=$id took $elapsedMs ms, the harness holds for $hold ms")
        }
        val last = log.last()
        val target = WireCaseAssertions.field(last, "url").orEmpty()
        WireCaseAssertions.assertWireCase(
            id,
            wireCase,
            sdkKey,
            WireCaseAssertions.SentRequest(
                target.substringBefore('?'),
                harness.base + target,
                WireCaseAssertions.field(last, "ifNoneMatch"),
            ),
            result,
        )
    }

    /** One fetch through the production client, closed afterwards. */
    private fun fetchOnce(base: String, sdkKey: String, deadlineMs: Long, previousEtag: String) =
        ConfigFetcher(
            baseUrl = base,
            sdkKey = sdkKey,
            timeoutMillis = deadlineMs,
            logger = CapturingLogger(),
        ).let { fetcher ->
            try {
                runBlocking { fetcher.fetch(previousEtag) }
            } finally {
                fetcher.close()
            }
        }

    /**
     * The harness's hold for a timeout case — the fetcher's deadline is derived from it (#783 A8) —
     * or 0 for any other behaviour. A timeout case seeded without a hold fails.
     */
    private fun holdMillis(id: String, wireCase: JsonObject, faults: JsonObject): Long {
        if (WireCaseAssertions.field(wireCase["server"] as? JsonObject, "behavior") != "timeout") return 0
        val hold = ((faults[id] as? JsonObject)?.get("ms") as? JsonPrimitive)?.longOrNull ?: 0L
        assertTrue(hold > 0, "$id is seeded without a timeout fault")
        return hold
    }

    /** The running harness the suite reads from: read-only admin routes only. */
    private class Harness(val base: String) {
        /** The harness's JSON answer to `GET pathAndQuery`; any other status fails. */
        fun get(pathAndQuery: String): JsonObject {
            val connection = URI(base + pathAndQuery).toURL().openConnection() as HttpURLConnection
            connection.connectTimeout = HARNESS_TIMEOUT_MS
            connection.readTimeout = HARNESS_TIMEOUT_MS
            try {
                val status = connection.responseCode
                val stream = if (status < HttpURLConnection.HTTP_BAD_REQUEST) {
                    connection.inputStream
                } else {
                    connection.errorStream
                }
                val raw = stream?.use { String(it.readBytes(), StandardCharsets.UTF_8) }.orEmpty()
                assertEquals(HttpURLConnection.HTTP_OK, status, "harness $pathAndQuery answered $raw")
                return Json.parseToJsonElement(raw).jsonObject
            } finally {
                connection.disconnect()
            }
        }

        /** The requests the harness logged for [sdkKey], oldest first. */
        fun requestsFor(sdkKey: String): List<JsonObject> {
            val body = get("/admin/requests?sdkKey=" + URLEncoder.encode(sdkKey, "UTF-8"))
            val ok = (body["ok"] as? JsonPrimitive)?.content
            assertEquals("true", ok, "harness refused /admin/requests: $body")
            return (body["requests"] as JsonArray).map { it.jsonObject }
        }
    }

    private companion object {
        /** The deadline of every case the harness does not hold (ms). */
        const val DEFAULT_DEADLINE_MS = 10_000L

        /** Connect and read timeout of an admin call to the harness (ms). */
        const val HARNESS_TIMEOUT_MS = 10_000

        const val NANOS_PER_MILLI = 1_000_000L
    }
}
