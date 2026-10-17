// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * The sensitive (SHA-256 salted) comparators: text equals / is-one-of / starts-with / ends-with,
 * and array contains. The SDK hashes the attribute with the config + context salts and compares
 * the hash to the config's operand; the cleartext is never in the config.
 */
internal object SensitiveComparators {
    fun evaluateSensitiveTextEquals(
        text: String,
        comparisonValue: String,
        salt: HashSalt,
        negate: Boolean,
    ): Boolean {
        val hash = Hashing.hashComparisonValue(text, salt.config, salt.context)
        return (hash == comparisonValue) != negate
    }

    fun evaluateSensitiveTextIsOneOf(
        text: String,
        comparisonValues: List<String>,
        salt: HashSalt,
        negate: Boolean,
    ): Boolean {
        val hash = Hashing.hashComparisonValue(text, salt.config, salt.context)
        return comparisonValues.contains(hash) != negate
    }

    /**
     * Sensitive startsWith/endsWith-any-of. Each operand is `"<byteLen>_<hash>"`; the SDK hashes the
     * matching-length BYTE prefix/suffix of the attribute and compares to `<hash>`.
     */
    fun evaluateSensitiveTextSliceEqualsAnyOf(
        text: String,
        comparisonValues: List<String>,
        salt: HashSalt,
        startsWith: Boolean,
        negate: Boolean,
    ): Boolean {
        val textUtf8 = text.encodeToByteArray()
        for (item in comparisonValues) {
            if (sliceHashMatches(textUtf8, item, salt, startsWith)) return !negate
        }
        return negate
    }

    /**
     * Whether the `"<byteLen>_<hash>"` operand [item] matches the attribute: an operand with no
     * `_`, a non-numeric length, or a length past the attribute's bytes is skipped (no match).
     */
    private fun sliceHashMatches(
        textUtf8: ByteArray,
        item: String,
        salt: HashSalt,
        startsWith: Boolean,
    ): Boolean {
        val index = item.indexOf('_')
        val sliceLength = if (index < 0) null else item.substring(0, index).toIntOrNull()
        if (sliceLength == null || textUtf8.size < sliceLength) return false
        val sliceUtf8 = ByteArray(sliceLength)
        if (startsWith) {
            textUtf8.copyInto(sliceUtf8, 0, 0, sliceLength)
        } else {
            textUtf8.copyInto(sliceUtf8, 0, textUtf8.size - sliceLength, textUtf8.size)
        }
        val hash = Hashing.hashComparisonValueSlice(sliceUtf8, salt.config, salt.context)
        return hash == item.substring(index + 1)
    }

    fun evaluateSensitiveArrayContainsAnyOf(
        array: List<String>,
        comparisonValues: List<String>,
        salt: HashSalt,
        negate: Boolean,
    ): Boolean {
        for (item in array) {
            val hash = Hashing.hashComparisonValue(item, salt.config, salt.context)
            if (comparisonValues.contains(hash)) return !negate
        }
        return negate
    }
}
