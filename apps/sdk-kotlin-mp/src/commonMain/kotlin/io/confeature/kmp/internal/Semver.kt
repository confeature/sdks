// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * ConfigCat-semantics semver parse + compare, ported field-for-field from
 * `packages/sdk-shared/src/semver.ts` (the spec-117 reference, itself a port of ConfigCat common-js
 * `Semver.ts`; transliterated from the Android port `io.confeature.android.internal.Semver`).
 *
 * A semver library is deliberately NOT used — npm/other-lib precedence diverges from ConfigCat on
 * loose-parse and pre-release edge cases and would fail the vendored `testmatrix_semantic*` rows.
 *
 * Key behaviours: strict (non-loose) FULL grammar with an optional leading `v`; parse on trim;
 * unparseable → `null` (never a throw — the caller treats `null` as a validation error); a version
 * WITHOUT a pre-release ranks HIGHER than one WITH; build metadata is ignored for precedence.
 */
internal class Semver private constructor(
    private val version: String,
    private val major: Long,
    private val minor: Long,
    private val patch: Long,
    /** Pre-release identifiers — each either a [Long] (numeric) or a [String]. */
    private val prerelease: List<Any>,
) {
    /**
     * Compare against [other]: `<0` if this is lower-precedence, `0` if equal, `>0` if higher. Build
     * metadata is ignored.
     */
    fun compare(other: Semver): Int {
        if (other.version == this.version) return 0
        val main = compareMain(other)
        return if (main != 0) main else comparePre(other)
    }

    private fun compareMain(other: Semver): Int {
        var c = compareIdentifiers(this.major, other.major)
        if (c != 0) return c
        c = compareIdentifiers(this.minor, other.minor)
        if (c != 0) return c
        return compareIdentifiers(this.patch, other.patch)
    }

    private fun comparePre(other: Semver): Int {
        val thisHas = this.prerelease.isNotEmpty()
        val otherHas = other.prerelease.isNotEmpty()
        return when {
            thisHas && !otherHas -> -1
            !thisHas && otherHas -> 1
            !thisHas -> 0
            else -> comparePrereleaseIdentifiers(this.prerelease, other.prerelease)
        }
    }

    /**
     * Compare two non-empty pre-release lists identifier by identifier; when one is a prefix of the
     * other, the longer one ranks higher.
     */
    private fun comparePrereleaseIdentifiers(a: List<Any>, b: List<Any>): Int {
        for (i in 0 until minOf(a.size, b.size)) {
            if (a[i] != b[i]) return compareIdentifiers(a[i], b[i])
        }
        return when {
            a.size == b.size -> 0
            a.size > b.size -> 1
            else -> -1
        }
    }

    internal companion object {
        private const val NUMERIC_IDENTIFIER = "0|[1-9]\\d*"
        private const val NON_NUMERIC_IDENTIFIER = "\\d*[a-zA-Z-][a-zA-Z0-9-]*"
        private val MAIN_VERSION =
            "($NUMERIC_IDENTIFIER)\\.($NUMERIC_IDENTIFIER)\\.($NUMERIC_IDENTIFIER)"
        private val PRERELEASE_IDENTIFIER = "(?:$NUMERIC_IDENTIFIER|$NON_NUMERIC_IDENTIFIER)"
        private val PRERELEASE = "(?:-($PRERELEASE_IDENTIFIER(?:\\.$PRERELEASE_IDENTIFIER)*))"
        private const val BUILD_IDENTIFIER = "[0-9A-Za-z-]+"
        private val BUILD = "(?:\\+($BUILD_IDENTIFIER(?:\\.$BUILD_IDENTIFIER)*))"
        private val FULL = Regex("^v?$MAIN_VERSION$PRERELEASE?$BUILD?$")

        private const val MAX_LENGTH = 256
        private const val MAX_SAFE_INTEGER = 9007199254740991L
        private val NUMERIC_RE = Regex("^[0-9]+$")

        /**
         * Parse a version string under ConfigCat's strict grammar, returning `null` on any failure
         * (length, grammar, out-of-range core component) — never throwing. Trims the input first.
         */
        fun parse(input: String?): Semver? {
            if (input == null) return null
            val trimmed = input.trim()
            if (trimmed.length > MAX_LENGTH) return null
            val m = FULL.matchEntire(trimmed) ?: return null

            val major = m.groupValues[1].toLong()
            val minor = m.groupValues[2].toLong()
            val patch = m.groupValues[3].toLong()
            if (!isSafeComponent(major) || !isSafeComponent(minor) || !isSafeComponent(patch)) {
                return null
            }

            val prerelease = parsePrerelease(m.groups[4]?.value)
            return Semver(canonicalString(major, minor, patch, prerelease), major, minor, patch, prerelease)
        }

        /** A core component must be a non-negative JS safe integer. */
        private fun isSafeComponent(value: Long): Boolean = value in 0L..MAX_SAFE_INTEGER

        private fun parsePrerelease(preGroup: String?): List<Any> {
            if (preGroup.isNullOrEmpty()) return emptyList()
            return preGroup.split(".").map { prereleaseIdentifier(it) }
        }

        /**
         * A numeric identifier becomes a [Long] when in range, guarding against overflow /
         * leading-zero ids the way the TS numberifier does; otherwise it stays a string.
         */
        private fun prereleaseIdentifier(id: String): Any {
            val num = if (NUMERIC_RE.matches(id)) id.toLongOrNull() else null
            return if (num != null && num >= 0 && num < MAX_SAFE_INTEGER) num else id
        }

        private fun canonicalString(major: Long, minor: Long, patch: Long, prerelease: List<Any>): String {
            val canonical = StringBuilder()
            canonical.append(major).append('.').append(minor).append('.').append(patch)
            if (prerelease.isNotEmpty()) {
                canonical.append('-')
                for (i in prerelease.indices) {
                    if (i > 0) canonical.append('.')
                    canonical.append(prerelease[i])
                }
            }
            return canonical.toString()
        }

        /**
         * Compare two identifiers exactly as common-js `compareIdentifiers`: both numeric → numeric
         * compare; a numeric identifier is lower-precedence than an alphanumeric one; otherwise
         * ASCII-lexical.
         */
        private fun compareIdentifiers(a: Any, b: Any): Int {
            val anum = a is Long || NUMERIC_RE.matches(a.toString())
            val bnum = b is Long || NUMERIC_RE.matches(b.toString())
            if (anum && bnum) {
                val av = if (a is Long) a else a.toString().toLong()
                val bv = if (b is Long) b else b.toString().toLong()
                return av.compareTo(bv)
            }
            if (a.toString() == b.toString()) return 0
            if (anum) return -1
            if (bnum) return 1
            return if (a.toString() < b.toString()) -1 else 1
        }
    }
}
