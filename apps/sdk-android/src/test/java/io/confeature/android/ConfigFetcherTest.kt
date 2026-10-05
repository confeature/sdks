// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.ConfigFetcher
import java.time.Duration
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource
import org.junit.jupiter.params.provider.ValueSource

class ConfigFetcherTest {
    private companion object {
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        const val PART_A = "FAKEfixtureKeyNotRea01"
        const val PART_B = "FAKEfixtureKeyNotRea02"
        const val CONFIGCAT_KEY = "configcat-sdk-1/$PART_A/$PART_B"
        const val CONFIG = "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},\"f\":{},\"s\":[]}"
    }

    private lateinit var server: MockWebServer
    private lateinit var logger: TestLogger

    @BeforeEach
    fun start() {
        server = MockWebServer()
        server.start()
        logger = TestLogger()
    }

    @AfterEach
    fun stop() {
        server.shutdown()
    }

    @Test
    fun fetch_200_parsesBodyAndCapturesEtag() {
        server.enqueue(
            MockResponse()
                .setHeader("ETag", "\"abc123\"")
                .setBody("{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},\"f\":{},\"s\":[]}"),
        )
        ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FETCHED)
            assertThat(result.etag).isEqualTo("\"abc123\"")
            assertThat(result.body).containsKey("f")
            assertThat(result.rawBody).contains("\"f\"")
        }
    }

    @Test
    fun fetch_304_returnsNotModified() {
        server.enqueue(MockResponse().setResponseCode(304).setHeader("ETag", "\"abc123\""))
        ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger).use { fetcher ->
            val result = fetcher.fetch("\"abc123\"")
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.NOT_MODIFIED)
            assertThat(result.etag).isEqualTo("\"abc123\"")
            val req = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertThat(req.getHeader("If-None-Match")).isEqualTo("\"abc123\"")
        }
    }

    @Test
    fun fetch_500_reportsFailureWithRedactedSdkKey() {
        server.enqueue(MockResponse().setResponseCode(500))
        ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FAILED)
            assertThat(result.error).contains("HTTP 500")
            assertThat(logger.allMessages()).noneMatch { it.contains(SDK_KEY) }
        }
    }

    @Test
    fun fetch_emitsExpectedUserAgent() {
        server.enqueue(MockResponse().setBody("{}"))
        ConfigFetcher(server.url("/").toString(), SDK_KEY, Duration.ofSeconds(5), logger).use { fetcher ->
            fetcher.fetch("")
            val req = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertThat(req.getHeader("User-Agent")).isEqualTo("confeature-android-sdk/${Version.SDK_VERSION}")
        }
    }

    /**
     * The path of the one recorded request AS IT WENT ON THE WIRE (#803): the raw request-target
     * of the request line (`GET <target> HTTP/1.1`), query excluded — never MockWebServer's
     * re-parsed `requestUrl`, never the string the fetcher built, so an OkHttp re-encoding or a
     * mock-side decode cannot hide a byte difference.
     */
    private fun recordedPath(): String {
        val req = server.takeRequest(5, TimeUnit.SECONDS)
        assertThat(req).`as`("the fetcher MUST issue a request").isNotNull
        return wirePath(req!!)
    }

    private fun fetcherFor(key: String, timeout: Duration = Duration.ofSeconds(5)): ConfigFetcher =
        ConfigFetcher(server.url("/").toString(), key, timeout, logger)

    @Test
    fun fetch_legacyKey_travelsRawAsOneSegment() {
        // #803 FR-001 — com.configcat.ConfigFetcher#getRequest (configcat-android-client 10.4.3)
        // builds url + "/configuration-files/" + sdkKey + "/config_v6.json": the key raw, no /v2/,
        // no hash.
        server.enqueue(MockResponse().setBody(CONFIG))
        fetcherFor(SDK_KEY).use { fetcher ->
            assertThat(fetcher.fetch("").status).isEqualTo(ConfigFetcher.Status.FETCHED)
            assertThat(recordedPath()).isEqualTo("/configuration-files/$SDK_KEY/config_v6.json")
        }
    }

    @Test
    fun fetch_configCatShapedKey_travelsRawAsThreeSegments() {
        server.enqueue(MockResponse().setBody(CONFIG))
        fetcherFor(CONFIGCAT_KEY).use { fetcher ->
            assertThat(fetcher.fetch("").status).isEqualTo(ConfigFetcher.Status.FETCHED)
            assertThat(recordedPath())
                .isEqualTo("/configuration-files/configcat-sdk-1/$PART_A/$PART_B/config_v6.json")
        }
    }

    /**
     * #803 FR-001 — a malformed key is escaped into ONE segment exactly as Go's `url.PathEscape`.
     * Every expected value is a literal copied from `go run` output of `url.PathEscape(input)`
     * (go1.x `net/url`), never one computed by the escaper under test.
     */
    @ParameterizedTest
    @CsvSource(
        delimiter = '|',
        quoteCharacter = '`',
        value = [
            // keeps $ & + : = @ (RFC 3986's unreserved-only set would escape them) and escapes
            // , ; ! ' ( ) * (encodeURIComponent would keep ! ' ( ) *).
            "bad key$&+:=@,;!'()*~/x?y#z%..|bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
            // é € 😀 are 2-, 3- and 4-byte UTF-8; 😀 is a surrogate pair in UTF-16 and must be
            // escaped by the code point's UTF-8 bytes, never per UTF-16 unit.
            "bad key$&+:=@,;!'()*~/x?y#z%\u00e9\u20ac\ud83d\ude00..|bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80..",
            "\ud83d\ude00|%F0%9F%98%80",
            "$&+:=@|$&+:=@",
            ",;!'()*|%2C%3B%21%27%28%29%2A",
            "A-Z_a.z~09|A-Z_a.z~09",
            "é☃|%C3%A9%E2%98%83",
            "a\"<>[]^{}\\b|a%22%3C%3E%5B%5D%5E%7B%7D%5Cb",
        ],
    )
    fun escapePathSegment_matchesGoPathEscape(input: String, goPathEscape: String) {
        assertThat(ConfigFetcher.escapePathSegment(input)).isEqualTo(goPathEscape)
    }

    @Test
    fun escapePathSegment_controlBytesAndPipe_matchGoPathEscape() {
        // Go: url.PathEscape("\x00\x7f|`") == "%00%7F%7C%60" (bytes CsvSource cannot carry).
        assertThat(ConfigFetcher.escapePathSegment("\u0000\u007f|`")).isEqualTo("%00%7F%7C%60")
    }

    @Test
    fun fetch_malformedKey_isEscapedIntoOneSegmentOnTheWire() {
        // The corpus case request-path-malformed-key, checked on the raw request line: OkHttp
        // must send exactly the bytes Go's url.PathEscape produces — no `$` → `%24`, no decoded
        // `%2C`, and the trailing `..` stays inside the segment.
        server.enqueue(MockResponse().setBody(CONFIG))
        fetcherFor("bad key$&+:=@,;!'()*~/x?y#z%\u00e9\u20ac\ud83d\ude00..").use { fetcher ->
            assertThat(fetcher.fetch("").status).isEqualTo(ConfigFetcher.Status.FETCHED)
            assertThat(recordedPath()).isEqualTo(
                "/configuration-files/bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25" +
                    "%C3%A9%E2%82%AC%F0%9F%98%80../config_v6.json",
            )
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["", ".", ".."])
    fun fetch_keyThatCannotBeASegment_requestsNothing(key: String) {
        fetcherFor(key).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FAILED)
            assertThat(result.error).isEqualTo("INVALID_SDK_KEY")
            assertThat(server.requestCount).isZero()
            assertThat(logger.allMessages()).anyMatch { it.contains("INVALID_SDK_KEY") }
        }
    }

    @Test
    fun fetch_malformedBaseUrl_failsWithAFixedCode() {
        ConfigFetcher("not a url", CONFIGCAT_KEY, Duration.ofSeconds(5), logger).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.error).isEqualTo("invalid_request")
            assertKeyFree(result, CONFIGCAT_KEY)
        }
    }

    @Test
    fun fetch_ifNoneMatchOkHttpRefuses_isDroppedAndTheFetchSelfHeals() {
        // #803 — OkHttp rejects a non-ASCII header value with an IllegalArgumentException quoting
        // the value. Failing on it would fail every later fetch (the client stores and persists
        // the ETag), so the refused ETag is dropped: the fetch goes out without If-None-Match,
        // succeeds, and the ETag it returns makes the next fetch conditional again.
        server.enqueue(MockResponse().setHeader("ETag", "\"v2\"").setBody(CONFIG))
        server.enqueue(MockResponse().setResponseCode(304).setHeader("ETag", "\"v2\""))
        val refused = "\"$PART_A\u00e9\""
        fetcherFor(CONFIGCAT_KEY).use { fetcher ->
            val first = assertDoesNotThrow<ConfigFetcher.FetchResult> { fetcher.fetch(refused) }
            assertThat(first.status).`as`("error=%s", first.error).isEqualTo(ConfigFetcher.Status.FETCHED)
            assertThat(first.etag).isEqualTo("\"v2\"")
            val firstReq = server.takeRequest(5, TimeUnit.SECONDS)
            assertThat(firstReq).isNotNull
            assertThat(firstReq!!.getHeader("If-None-Match")).`as`("the refused ETag is dropped").isNull()
            assertThat(logger.allMessages()).anyMatch {
                it.startsWith("WARN: ") && it.contains("fetching without If-None-Match")
            }

            val second = fetcher.fetch(first.etag)
            assertThat(second.status).isEqualTo(ConfigFetcher.Status.NOT_MODIFIED)
            assertThat(server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("If-None-Match"))
                .isEqualTo("\"v2\"")
            assertThat(server.requestCount).isEqualTo(2)
            assertKeyFree(first, CONFIGCAT_KEY)
            assertKeyFree(second, CONFIGCAT_KEY)
        }
    }

    @Test
    fun client_serverSentNonAsciiEtag_laterFetchesStillSucceed() {
        // The end-to-end shape of the bug: a server sends an ETag OkHttp reads leniently but will
        // not send back. The client stores it; every later refresh must still succeed.
        server.enqueue(MockResponse().addHeaderLenient("ETag", "\"v1\u00e9\"").setBody(CONFIG))
        server.enqueue(MockResponse().setHeader("ETag", "\"v2\"").setBody(CONFIG))
        server.enqueue(MockResponse().setResponseCode(304).setHeader("ETag", "\"v2\""))
        val client = ConfeatureClient.builder(SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .baseUrl(server.url("/").toString())
            .logger(logger)
            .build()
        try {
            assertThat(client.forceRefresh()).`as`("first refresh").isTrue
            assertThat(client.forceRefresh()).`as`("refresh after a non-ASCII ETag").isTrue
            assertThat(client.forceRefresh()).`as`("refresh after the ETag healed").isTrue
            val requests = (1..3).map { server.takeRequest(5, TimeUnit.SECONDS)!! }
            assertThat(requests.map { it.getHeader("If-None-Match") })
                .containsExactly(null, null, "\"v2\"")
            assertThat(server.requestCount).isEqualTo(3)
        } finally {
            client.close()
        }
    }

    @Test
    fun fetch_uncheckedLibraryError_logsItsClassNameOnlyAndNeverThrows() {
        // #803 — the RuntimeException catch-all (e.g. a SecurityException when the app lacks the
        // INTERNET permission). No JVM transport raises one, so the call factory seam does; its
        // message quotes the key, as a library message quoting the URL would.
        val throwing = object : Call.Factory {
            override fun newCall(request: Request): Call =
                throw SecurityException("Permission denied (missing INTERNET permission?): ${request.url}")
        }
        ConfigFetcher(server.url("/").toString(), CONFIGCAT_KEY, Duration.ofSeconds(5), logger, throwing).use { fetcher ->
            val result = assertDoesNotThrow<ConfigFetcher.FetchResult> { fetcher.fetch("") }
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FAILED)
            assertThat(result.error).isEqualTo("network_error")
            assertThat(logger.allMessages()).anyMatch {
                it.contains("reason=network_error exception=SecurityException")
            }
            assertThat(logger.allMessages()).noneMatch { it.contains("Permission denied") }
            assertKeyFree(result, CONFIGCAT_KEY)
        }
    }

    /**
     * #803 — the keyed URL and the call-factory seam stay out of the JVM-public surface. Kotlin
     * `internal` is PUBLIC in bytecode (a getter/setter named `getUrl$<module>` /
     * `setCallFactory$<module>`), so this reads what Java — or reflection — actually sees:
     * every public zero-argument method is invoked and every public field read, and none may
     * return the key or any part of it; no public method may take a [Call.Factory], so nothing can
     * swap the transport after construction.
     */
    @Test
    fun configFetcher_publicJvmSurface_exposesNoKeyedUrlAndNoTransportSetter() {
        val malformed = "bad key/$PART_A"
        for (key in listOf(CONFIGCAT_KEY, SDK_KEY, malformed)) {
            ConfigFetcher(server.url("/").toString(), key, Duration.ofSeconds(5), logger).use { fetcher ->
                val secrets = listOf(key, PART_A, PART_B, ConfigFetcher.escapePathSegment(malformed))
                val type = ConfigFetcher::class.java
                for (m in type.methods) {
                    assertThat(m.parameterTypes.toList())
                        .`as`("public %s takes a Call.Factory", m)
                        .doesNotContain(Call.Factory::class.java)
                    if (m.parameterCount != 0 || m.returnType == Void.TYPE) continue
                    val target = if (java.lang.reflect.Modifier.isStatic(m.modifiers)) null else fetcher
                    val shown = m.invoke(target)?.toString() ?: continue
                    for (secret in secrets) {
                        assertThat(shown).`as`("public %s returns the key", m).doesNotContain(secret)
                    }
                }
                for (f in type.fields) {
                    assertThat(f.type).`as`("public field %s", f).isNotEqualTo(Call.Factory::class.java)
                    val target = if (java.lang.reflect.Modifier.isStatic(f.modifiers)) null else fetcher
                    val shown = f.get(target)?.toString() ?: continue
                    for (secret in secrets) {
                        assertThat(shown).`as`("public field %s holds the key", f).doesNotContain(secret)
                    }
                }
                assertThat(type.methods.map { it.name })
                    .noneMatch { it.startsWith("getUrl") || it.startsWith("setCallFactory") }
            }
        }
    }

    @Test
    fun testLogger_recordsTheThrowableAndItsWholeChain() {
        // The key-free assertions are only as strong as the logger they read: a throwable passed
        // to error() — its message, its cause chain, its suppressed list — must show up in
        // allMessages(), exactly as a real logger would print it.
        val cause = IllegalStateException("cause quotes $PART_A")
        val top = RuntimeException("top", cause)
        top.addSuppressed(IllegalArgumentException("suppressed quotes $PART_B"))
        logger.error("plain message", top)
        assertThat(logger.throwables()).containsExactly(top)
        assertThat(logger.allMessages()).anyMatch { it.contains(PART_A) }
        assertThat(logger.allMessages()).anyMatch { it.contains(PART_B) }
        assertThat(logger.allMessages()).anyMatch { it.contains("java.lang.IllegalStateException") }
    }

    @Test
    fun fetch_malformedJson_logsAFixedReason() {
        server.enqueue(MockResponse().setBody("{not json $CONFIGCAT_KEY"))
        fetcherFor(CONFIGCAT_KEY).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.error).isEqualTo("MALFORMED_JSON")
            assertKeyFree(result, CONFIGCAT_KEY)
        }
    }

    /**
     * #803 FR-002/FR-004 — the URL now carries the key, so a forced timeout, a mid-body reset and
     * a redirect loop must each fail with a fixed code, and neither the full key nor any 22-char
     * part may reach a log line or the fetch result's error.
     */
    @ParameterizedTest
    @ValueSource(strings = ["timeout", "mid-body reset", "redirect loop"])
    fun fetch_forcedTransportFailure_isKeyFree(failure: String) {
        val expectedCode: String
        when (failure) {
            "timeout" -> {
                server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
                expectedCode = "timeout"
            }
            "mid-body reset" -> {
                server.enqueue(
                    MockResponse()
                        .setBody(CONFIG + CONFIG + CONFIG)
                        .throttleBody(16, 100, TimeUnit.MILLISECONDS)
                        .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
                )
                expectedCode = "body_read_failed"
            }
            else -> {
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse =
                        MockResponse()
                            .setResponseCode(302)
                            .setHeader("Location", request.requestUrl.toString())
                }
                expectedCode = "too_many_redirects"
            }
        }
        val timeout = if (failure == "timeout") Duration.ofMillis(300) else Duration.ofSeconds(5)
        fetcherFor(CONFIGCAT_KEY, timeout).use { fetcher ->
            val result = fetcher.fetch("")
            assertThat(result.status).isEqualTo(ConfigFetcher.Status.FAILED)
            assertThat(result.error).isEqualTo(expectedCode)
            assertThat(logger.allMessages()).anyMatch { it.contains("reason=$expectedCode") }
            assertKeyFree(result, CONFIGCAT_KEY)
        }
    }

    /**
     * Neither the key nor a 22-char part reaches the result or a log entry (an entry includes any
     * throwable's whole chain, see [TestLogger]), and the fetcher hands the logger NO library
     * exception at all — OkHttp's messages can quote the request URL, so a fixed code is the only
     * thing passed on, whatever the exception happens to say today.
     */
    private fun assertKeyFree(result: ConfigFetcher.FetchResult, key: String) {
        for (secret in listOf(key, PART_A, PART_B)) {
            assertThat(result.error).doesNotContain(secret)
            assertThat(logger.allMessages()).noneMatch { it.contains(secret) }
        }
        assertThat(logger.throwables()).`as`("the fetcher passes no library exception on").isEmpty()
    }
}

/** The request-target of [req]'s raw request line, query excluded — the path as sent. */
internal fun wirePath(req: RecordedRequest): String {
    val parts = req.requestLine.split(' ')
    assertThat(parts).`as`("request line %s", req.requestLine).hasSize(3)
    return parts[1].substringBefore('?')
}
