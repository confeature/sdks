// SPDX-License-Identifier: MIT
package io.confeature.android

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ConfeatureClientTest {
    private companion object {
        const val VALID_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    @Test
    fun builder_rejectsEmptySdkKey() {
        assertThatThrownBy { ConfeatureClient.builder("").build() }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun close_isIdempotent() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .build()
        client.close()
        client.close() // second close MUST not throw.
        assertThat(client.getValue("anything", true, null)).isEqualTo(true)
    }

    @Test
    fun getValue_withLocalOverridesReturnsOverride() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .build()
        try {
            assertThat(client.getValue("flag", false, null)).isEqualTo(true)
        } finally {
            client.close()
        }
    }

    @Test
    fun getValue_missingKeyReturnsDefault() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(emptyMap())))
            .build()
        try {
            assertThat(client.getValue("never.set", true, null)).isEqualTo(true)
            assertThat(client.getValue("never.set", false, null)).isEqualTo(false)
        } finally {
            client.close()
        }
    }

    @Test
    fun forceRefresh_localOnlyIsNoOpSuccess() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(emptyMap())))
            .build()
        try {
            assertThat(client.forceRefresh()).isTrue
        } finally {
            client.close()
        }
    }

    @Test
    fun snapshot_withLocalOverridesReturnsOverride() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .build()
        try {
            val snap = client.snapshot()
            assertThat(snap.getValue("flag", false, null)).isEqualTo(true)
        } finally {
            client.close()
        }
    }

    @Test
    fun getValue_typedOverloadCoercesPrimitive() {
        val client = ConfeatureClient.builder(VALID_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .build()
        try {
            val result = client.getValue("flag", false, null, Boolean::class.javaObjectType)
            assertThat(result).isEqualTo(true)
        } finally {
            client.close()
        }
    }

    // NOTE: get_withContext_usesAndroidCacheDir was removed in #173.
    //
    // The test exercised `ConfeatureClient.defaultCacheDirFor(Context)`,
    // a single-line public factory (`File(ctx.applicationContext.cacheDir,
    // "confeature").absolutePath`). It required a real Robolectric runtime
    // (`ApplicationProvider.getApplicationContext()` registers via
    // `InstrumentationRegistry`). The project's JUnit 5 setup
    // (`useJUnitPlatform()`) doesn't bridge to Robolectric's @RunWith
    // (JUnit 4 only); adding a JUnit5↔Robolectric extension dep just to
    // verify a 1-line trivially-correct method isn't worth the burden.
    // The method's correctness is provable by inspection and is exercised
    // end-to-end by android-instrumented tests (separate task).
}
