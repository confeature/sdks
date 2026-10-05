// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Snapshot is a read-only view; tests exercise the same override-first / evaluator-fallback flow as
 * [ConfeatureClient.getValue] without the IO surface.
 */
class SnapshotTest {

    private fun booleanSettings(value: Boolean): Map<String, Any?> = mapOf(
        "flag" to mapOf("t" to 0, "v" to mapOf("b" to value)),
    )

    /** Wraps the `f` settings map into the full `{f:…}` config root the evaluator now reads. */
    private fun rootOf(settings: Map<String, Any?>?): Map<String, Any?>? =
        settings?.let { mapOf("f" to it) }

    @Test
    fun snapshot_resolvesAgainstCapturedConfig() {
        val settings = booleanSettings(true)
        val s = Snapshot(settings, rootOf(settings), null, null)
        assertEquals(true, s.getValue("flag", false))
    }

    @Test
    fun snapshot_keyMissingReturnsDefault() {
        val settings = booleanSettings(true)
        val s = Snapshot(settings, rootOf(settings), null, null)
        assertEquals(false, s.getValue("missing", false))
    }

    @Test
    fun snapshot_overrideShortCircuitsEvaluator() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true)))
        // Settings say false but the override forces true.
        val settings = booleanSettings(false)
        val s = Snapshot(settings, rootOf(settings), fo, null)
        assertEquals(true, s.getValue("flag", false))
    }

    @Test
    fun snapshot_nullSettingsReturnsDefault() {
        val s = Snapshot(null, null, null, null)
        assertEquals(true, s.getValue("flag", true))
    }

    @Test
    fun snapshot_defaultUserUsedWhenCallerOmitsUser() {
        val settings = booleanSettings(true)
        // Targeting rules don't kick in for the boolean-only evaluator, so the
        // default-user wiring is verified by exercising the path (no exception,
        // value returns).
        val s = Snapshot(settings, rootOf(settings), null, User("default-user"))
        assertEquals(true, s.getValue("flag", false))
    }

    @Test
    fun snapshot_overrideMissingKeyReturnsDefault() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("other" to true)))
        val s = Snapshot(null, null, fo, null)
        // LocalOnly + missing key → default.
        assertNull(s.getValue("flag", null))
    }
}
