// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import io.confeature.kmp.internal.SdkKey
import io.confeature.kmp.internal.classifyFetchError
import io.confeature.kmp.internal.configFileUrl
import io.confeature.kmp.internal.escapePathSegment
import io.confeature.kmp.internal.isUsableBaseUrl
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.SendCountExceedException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The one config-URL function (#803 FR-001) and the fixed-reason error classifier (FR-002).
 * Pure common logic, so it runs on every target.
 *
 * The path mirrors ConfigCat's Kotlin Multiplatform SDK (`com.configcat.fetch.ConfigFetcher`,
 * configcat-kotlin-client 5.1.0), which appends the raw `sdkKey`:
 * `$baseUrl/configuration-files/$sdkKey/config_v6.json`.
 */
class ConfigUrlTest {

    private val base = "https://cdn.example.test"
    private val legacyKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    private val configCatKey = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

    @Test
    fun legacyKey_travelsRawAsOneSegment() {
        assertEquals(
            "$base/configuration-files/$legacyKey/config_v6.json",
            configFileUrl(base, legacyKey),
        )
    }

    @Test
    fun configCatKey_travelsRawAsThreeSegments() {
        assertEquals(
            "$base/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/" +
                "FAKEfixtureKeyNotRea02/config_v6.json",
            configFileUrl(base, configCatKey),
        )
    }

    @Test
    fun trailingSlashOnBase_isTrimmed() {
        assertEquals(configFileUrl(base, legacyKey), configFileUrl("$base/", legacyKey))
    }

    @Test
    fun noV2Prefix_andNoCacheKeyTail() {
        val url = configFileUrl(base, configCatKey)!!
        assertFalse(url.contains("/v2/"))
        assertFalse(url.contains(SdkKey.cacheKeyTail(SdkKey.deriveCacheKey(configCatKey))))
    }

    @Test
    fun malformedKey_isEscapedIntoOneSegment() {
        assertEquals(
            "$base/configuration-files/not%2Fa%20key%3F%25%23/config_v6.json",
            configFileUrl(base, "not/a key?%#"),
        )
        // A ConfigCat-like key with a short part fails the shape: its `/` must not split the path.
        assertEquals(
            "$base/configuration-files/configcat-sdk-1%2Fshort%2Fparts/config_v6.json",
            configFileUrl(base, "configcat-sdk-1/short/parts"),
        )
        // A key that LOOKS like a dot segment once joined with other characters is still one
        // segment; only the bare "", "." and ".." are refused.
        assertEquals("$base/configuration-files/...%2F/config_v6.json", configFileUrl(base, ".../"))
    }

    @Test
    fun emptyDotAndDotDot_areRefused() {
        assertNull(configFileUrl(base, ""))
        assertNull(configFileUrl(base, "."))
        assertNull(configFileUrl(base, ".."))
    }

    @Test
    fun escapePathSegment_matchesGoPathEscape() {
        assertEquals("AZaz09-_.~\$&+=:@", escapePathSegment("AZaz09-_.~\$&+=:@"))
        assertEquals("%2F%3F%23%25%20%3B%2C%C3%A9", escapePathSegment("/?#% ;,é"))
        // Real Go output: url.PathEscape("bad key$&+:=@,;!'()*~/x?y#z%..") — copied, not recomputed.
        assertEquals(
            "bad%20key\$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
            escapePathSegment("bad key\$&+:=@,;!'()*~/x?y#z%.."),
        )
    }

    @Test
    fun usableBaseUrl_isAbsoluteHttpOrHttpsWithAHost() {
        for (ok in listOf(
            "https://cdn.example.test",
            "http://127.0.0.1:8080",
            "HTTPS://cdn.example.test/",
            "https://cdn.example.test/prefix",
            "http://[::1]:8080",
        )) {
            assertTrue(isUsableBaseUrl(ok), ok)
        }
        for (bad in listOf(
            "cdn.example.test",
            "localhost:8080",
            "/relative",
            "ftp://cdn.example.test",
            "https://",
            "https:///path",
            "https://user@/x",
            "https://cdn.example.test?q=1",
            "https://cdn.example.test#f",
            "https://cdn.example.test:notaport",
        )) {
            assertFalse(isUsableBaseUrl(bad), bad)
        }
    }

    @Test
    fun classifyFetchError_returnsFixedCodes() {
        assertEquals(
            ConfigFetcher.TIMEOUT,
            classifyFetchError(HttpRequestTimeoutException("https://x/$legacyKey", 1L), "fb"),
        )
        assertEquals(
            ConfigFetcher.TOO_MANY_REDIRECTS,
            classifyFetchError(SendCountExceedException("max send count"), "fb"),
        )
        assertEquals(
            ConfigFetcher.TIMEOUT,
            classifyFetchError(
                IllegalStateException("wrapped", HttpRequestTimeoutException("u", 1L)),
                "fb",
            ),
        )
        assertEquals("fb", classifyFetchError(IllegalStateException(legacyKey), "fb"))
    }
}
