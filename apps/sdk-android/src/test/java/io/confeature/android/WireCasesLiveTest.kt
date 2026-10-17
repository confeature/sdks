// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.ConfigFetcher
import io.confeature.android.internal.JsonParser
import java.time.Duration
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * sdk-android live wire-cases (#922, after sdk-go's #921).
 *
 * sdk-android's own [ConfigFetcher] — its real OkHttp stack — against a RUNNING live-contract
 * harness serving the reference origin of the CDN read path. Every seeded wire-case is replayed
 * and judged by [WireCaseAssertions.assertWireCase], the SAME rules the hermetic [WireCasesTest]
 * applies to a MockWebServer. Nothing is hand-built and no admin write is made:
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
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the hermetic `test`. When
 * it is set without `LIVE_HARNESS_URL`, or the harness does not answer, the test FAILS; it never
 * skips.
 */
class WireCasesLiveTest {
    @TestFactory
    @Suppress("UNCHECKED_CAST")
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
        val state = harness.get("/admin/state", null)
        val keys = (state["keys"] as List<String>).sorted()
        val faults = state["faults"] as? Map<String, Any?> ?: emptyMap()
        val corpus = WireCaseAssertions.casesById()

        val seededSet = dynamicTest("seeded-set") {
            assertThat(keys)
                .`as`("the harness reports no seeded case — an empty run checks nothing")
                .isNotEmpty()
            assertThat(keys - corpus.keys).`as`("seeded keys missing from the corpus").isEmpty()
        }
        // A stray key is reported by seeded-set.
        val cases = keys.mapNotNull { id ->
            corpus[id]?.let { wireCase -> dynamicTest(id) { liveCase(harness, id, wireCase, faults) } }
        }
        // US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's 403 since #785,
        // classed like a 404 as invalidSdkKey.
        val unseeded = dynamicTest("unseeded-key") {
            val result = ConfigFetcher(harness.base, "never-seeded-922", DEFAULT_DEADLINE, TestLogger())
                .use { it.fetch("") }
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FAILED)
            assertThat(WireCaseAssertions.androidErrorToClass(result.error))
                .`as`("errorClass (raw=%s)", result.error)
                .isEqualTo("invalidSdkKey")
        }
        return listOf(seededSet) + cases + unseeded
    }

    /** One seeded case: one fetch, exactly one logged request, judged by the shared rules. */
    @Suppress("UNCHECKED_CAST")
    private fun liveCase(
        harness: Harness,
        id: String,
        wireCase: Map<String, Any?>,
        faults: Map<String, Any?>,
    ) {
        val hold = holdMillis(id, wireCase, faults)
        val deadline = if (hold > 0) Duration.ofMillis(hold / 4) else DEFAULT_DEADLINE
        // The harness seeds each case under its id; a case that pins given.sdkKey is configured
        // with that key instead (#803 FR-003).
        val sdkKey = WireCaseAssertions.sdkKeyFor(wireCase, id)
        val loggedBefore = harness.requestsFor(sdkKey).size
        val prevETag = (wireCase["given"] as Map<String, Any?>)["previousEtag"] as String?

        val started = System.nanoTime()
        val result = ConfigFetcher(harness.base, sdkKey, deadline, TestLogger()).use {
            it.fetch(prevETag ?: "")
        }
        val elapsedMs = (System.nanoTime() - started) / 1_000_000L

        val log = harness.requestsFor(sdkKey)
        // Exactly one request per fetch: a retrying SDK, or a request logged by an earlier run,
        // must not stand in for the one under test.
        assertThat(log.size - loggedBefore).`as`("requests one fetch sent (case %s)", id).isEqualTo(1)
        if (hold > 0) {
            // The fetcher's own deadline ended the fetch, not the harness releasing it.
            assertThat(elapsedMs).`as`("fetch time vs the harness's %d ms hold", hold).isLessThan(hold)
        }
        val last = log.last()
        WireCaseAssertions.assertWireCase(
            id,
            wireCase,
            sdkKey,
            WireCaseAssertions.SentRequest(
                (last["url"] as String).substringBefore('?'),
                last["ifNoneMatch"] as String?,
            ),
            result,
        )
    }

    /**
     * The harness's hold for a timeout case — the fetcher's deadline is derived from it (#783 A8) —
     * or 0 for any other behaviour. A timeout case seeded without a hold fails.
     */
    @Suppress("UNCHECKED_CAST")
    private fun holdMillis(id: String, wireCase: Map<String, Any?>, faults: Map<String, Any?>): Long {
        if ((wireCase["server"] as Map<String, Any?>)["behavior"] != "timeout") return 0
        val ms = (faults[id] as? Map<String, Any?>)?.get("ms")
        assertThat(ms).`as`("%s is seeded without a timeout fault", id).isInstanceOf(Number::class.java)
        val hold = (ms as Number).toLong()
        assertThat(hold).`as`("%s timeout hold", id).isPositive()
        return hold
    }

    /** The running harness the suite reads from: read-only admin routes only. */
    private class Harness(val base: String) {
        private val client = OkHttpClient.Builder().callTimeout(Duration.ofSeconds(10)).build()

        /** The harness's JSON answer to `GET path[?sdkKey=]`; any other status fails. */
        fun get(path: String, sdkKey: String?): Map<String, Any?> {
            val target = "$base$path".toHttpUrl().newBuilder()
            if (sdkKey != null) target.addQueryParameter("sdkKey", sdkKey)
            client.newCall(Request.Builder().url(target.build()).build()).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                assertThat(resp.code).`as`("harness %s answered %s", path, raw).isEqualTo(200)
                return JsonParser.parseObject(raw)
            }
        }

        /** The requests the harness logged for [sdkKey], oldest first. */
        @Suppress("UNCHECKED_CAST")
        fun requestsFor(sdkKey: String): List<Map<String, Any?>> {
            val body = get("/admin/requests", sdkKey)
            assertThat(body["ok"]).`as`("harness refused /admin/requests: %s", body).isEqualTo(true)
            return body["requests"] as List<Map<String, Any?>>
        }
    }

    private companion object {
        /** The deadline of every case the harness does not hold. */
        val DEFAULT_DEADLINE: Duration = Duration.ofSeconds(10)
    }
}
