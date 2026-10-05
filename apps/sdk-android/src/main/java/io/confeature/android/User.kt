// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Targeting context passed to [ConfeatureClient.getValue].
 *
 * Field names mirror ConfigCat's `com.configcat.User` 1:1 per constitution Principle II.
 * [identifier] is the only required field; [email], [country], and [custom] are optional and feed
 * targeting-rule comparisons.
 *
 * **Typed custom attributes (spec 151 / #468):** like ConfigCat's `com.configcat.User`, [custom]
 * values are `Any` (Java `Object`), not just `String`. The evaluator converts a non-`String`
 * attribute exactly as ConfigCat does before comparison/stringification:
 * - [Number] → its invariant decimal / exponent string (ECMAScript `Number.toString`).
 * - [Boolean] → `"true"` / `"false"`.
 * - `List<String>` (a string array) → its compact JSON-array string.
 * - [java.util.Date] / [java.time.Instant] → Unix epoch **seconds** (`getTime() / 1000.0`),
 *   matching ConfigCat's `Date` handling.
 *
 * A [String] attribute flows through unchanged (byte-identical to the prior string-only path).
 *
 * Instances are immutable. Build via [User.builder].
 */
public class User private constructor(
    public val identifier: String,
    public val email: String?,
    public val country: String?,
    public val custom: Map<String, Any>,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is User) return false
        return identifier == other.identifier &&
            email == other.email &&
            country == other.country &&
            custom == other.custom
    }

    override fun hashCode(): Int {
        var result = identifier.hashCode()
        result = 31 * result + (email?.hashCode() ?: 0)
        result = 31 * result + (country?.hashCode() ?: 0)
        result = 31 * result + custom.hashCode()
        return result
    }

    /** Builder for [User]. */
    public class Builder internal constructor(private val identifier: String) {
        private var email: String? = null
        private var country: String? = null
        private var custom: Map<String, Any> = emptyMap()

        /** Sets [User.email]. */
        public fun email(email: String?): Builder {
            this.email = email
            return this
        }

        /** Sets [User.country]. */
        public fun country(country: String?): Builder {
            this.country = country
            return this
        }

        /**
         * Sets [User.custom] (defensively copied; insertion order preserved).
         *
         * Values are `Any` (Java `Object`) — typed custom attributes (number / boolean /
         * `List<String>` / [java.util.Date] / [java.time.Instant]) are converted by the evaluator
         * exactly as ConfigCat does. A `String` value flows through unchanged.
         */
        public fun custom(custom: Map<String, Any>?): Builder {
            this.custom =
                if (custom == null) {
                    emptyMap()
                } else {
                    // LinkedHashMap copy preserves insertion order for
                    // deterministic logging in tests.
                    java.util.Collections.unmodifiableMap(LinkedHashMap(custom))
                }
            return this
        }

        /** Builds the immutable [User]. */
        public fun build(): User = User(identifier, email, country, custom)
    }

    public companion object {
        /** Returns a new builder seeded with [identifier]. */
        @JvmStatic
        public fun builder(identifier: String): Builder = Builder(identifier)
    }
}
