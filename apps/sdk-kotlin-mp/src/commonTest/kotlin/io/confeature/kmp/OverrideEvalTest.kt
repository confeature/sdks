// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.OverrideEval
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Common 7-branch parity gate — mirrors `apps/sdk-java/.../OverrideEvalTest.java` 1:1.
 *
 * Runs on every platform via `kotlin-test` so the override-eval contract is verified
 * for JVM, iOS, JS, and Android targets simultaneously. Constitution Principle II
 * (NON-NEGOTIABLE) — any drift here means the common code has diverged from the
 * canonical TS / Python / Go / .NET / Java algorithm.
 */
class OverrideEvalTest {

    // Branch 1: no overrides configured → fall through to the cache path.
    @Test
    fun branch1_noOverridesFallsThrough() {
        val r = OverrideEval.evaluateSync(null, "key", false)
        assertFalse(r.found)
        assertNull(r.value)
    }

    // Branch 2 is unreachable in v1: the OverrideBehaviour enum declares only
    // LOCAL_ONLY. The runtime guard is preserved for forward compatibility.

    // Branch 3: data source returns null → fall through.
    @Test
    fun branch3_nullDataSourceMapFallsThrough() {
        val fo = FlagOverrides(
            object : OverrideDataSource {
                override fun getOverridesSync(): Map<String, Any>? = null
            },
            OverrideBehaviour.LOCAL_ONLY,
        )
        val r = OverrideEval.evaluateSync(fo, "key", false)
        assertFalse(r.found)
        assertNull(r.value)
    }

    // Branch 4: key absent → return default (LocalOnly contract — don't fall through).
    @Test
    fun branch4_keyAbsentReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("other.key" to true)))
        val r = OverrideEval.evaluateSync(fo, "missing.key", false)
        assertTrue(r.found)
        assertEquals(false, r.value)
    }

    // Branch 5: override slot null → return default. `MapOverrideDataSource` rejects
    // nullable values via `Map<String, Any>` typing, so we exercise the branch by
    // hand-rolling a data source that returns a map carrying a null slot.
    @Test
    fun branch5_nullValueReturnsDefault() {
        val ds = object : OverrideDataSource {
            @Suppress("UNCHECKED_CAST")
            override fun getOverridesSync(): Map<String, Any>? =
                mapOf<String, Any?>("nullable" to null) as Map<String, Any>
        }
        val fo = FlagOverrides.localOnly(ds)
        val r = OverrideEval.evaluateSync(fo, "nullable", true)
        assertTrue(r.found)
        assertEquals(true, r.value)
    }

    // Branch 6: TYPE_MISMATCH — override is a String but default is Boolean.
    @Test
    fun branch6_typeMismatchReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to "not a boolean")))
        val r = OverrideEval.evaluateSync(fo, "flag", false)
        assertTrue(r.found)
        assertEquals(false, r.value)
    }

    // Branch 6b: null default bypasses the type check (matches TS / Java semantics).
    @Test
    fun branch6_nullDefaultBypassesTypeCheck() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to "stringy")))
        val r = OverrideEval.evaluateSync(fo, "flag", null)
        assertTrue(r.found)
        assertEquals("stringy", r.value)
    }

    // Branch 7: happy path — typed override value flows through.
    @Test
    fun branch7_happyPathReturnsOverride() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true)))
        val r = OverrideEval.evaluateSync(fo, "flag", false)
        assertTrue(r.found)
        assertEquals(true, r.value)
    }
}
