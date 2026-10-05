// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.OverrideEval
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class OverrideEvalTest {
    // Branch 1: no overrides → fall through.
    @Test
    fun branch1_noOverridesFallsThrough() {
        val r = OverrideEval.evaluateSync(null, "key", false)
        assertThat(r.found).isFalse
        assertThat(r.value).isNull()
    }

    // Branch 2: non-LocalOnly behaviours short-circuit. We can't actually
    // construct a non-LocalOnly behaviour in v1 (the enum declares only
    // LOCAL_ONLY), so this branch is covered by construction — the runtime
    // guard is preserved for forward compatibility.

    // Branch 3: data source returns null → fall through.
    @Test
    fun branch3_nullDataSourceMapFallsThrough() {
        val fo = FlagOverrides({ null }, OverrideBehaviour.LOCAL_ONLY)
        val r = OverrideEval.evaluateSync(fo, "key", false)
        assertThat(r.found).isFalse
        assertThat(r.value).isNull()
    }

    // Branch 4: key absent → default.
    @Test
    fun branch4_keyAbsentReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("other.key" to true)))
        val r = OverrideEval.evaluateSync(fo, "missing.key", false)
        assertThat(r.found).isTrue
        assertThat(r.value).isEqualTo(false)
    }

    // Branch 5: override slot null → default.
    @Test
    fun branch5_nullValueReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("nullable" to null)))
        val r = OverrideEval.evaluateSync(fo, "nullable", true)
        assertThat(r.found).isTrue
        assertThat(r.value).isEqualTo(true)
    }

    // Branch 6: type mismatch → default.
    @Test
    fun branch6_typeMismatchReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to "not a boolean")))
        val r = OverrideEval.evaluateSync(fo, "flag", false)
        assertThat(r.found).isTrue
        assertThat(r.value).isEqualTo(false)
    }

    // Branch 6b: null default bypasses the type check.
    @Test
    fun branch6_nullDefaultBypassesTypeCheck() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to "stringy")))
        val r = OverrideEval.evaluateSync(fo, "flag", null)
        assertThat(r.found).isTrue
        assertThat(r.value).isEqualTo("stringy")
    }

    // Branch 7: happy path → typed override value.
    @Test
    fun branch7_happyPathReturnsOverride() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true)))
        val r = OverrideEval.evaluateSync(fo, "flag", false)
        assertThat(r.found).isTrue
        assertThat(r.value).isEqualTo(true)
    }
}
