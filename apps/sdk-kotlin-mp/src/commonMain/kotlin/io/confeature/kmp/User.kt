// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Targeting context passed to [ConfeatureClient.getValue].
 *
 * <p>Field names mirror ConfigCat's Kotlin Multiplatform SDK `com.configcat.ConfigCatUser` 1:1 per
 * constitution Principle II. [identifier] is the only required field; [email], [country], and
 * [custom] are optional and feed targeting-rule comparisons.
 *
 * <p>[custom] is a typed bag — `Map<String, Any>` — matching upstream `ConfigCatUser(custom:
 * Map<String, Any>)`. Values may be:
 * <ul>
 *   <li>[String] — verbatim text (also the only legal type for sensitive-text / semver comparators);
 *   <li>a [Number] (Int / Long / Double / …) — fed to NUMBER comparators as-is, or to DATETIME
 *       comparators as Unix epoch SECONDS (fractional allowed). A date attribute is passed as its
 *       epoch-seconds Number, exactly as upstream `ConfigCatUser` serialises a date;
 *   <li>a [Boolean];
 *   <li>a `List<String>` / array of strings — fed to ARRAY comparators.
 * </ul>
 * Non-string values are stringified for cleartext / sensitive-text comparators using ConfigCat's
 * invariant rules (number → invariant decimal, list → ConfigCat JSON array, boolean → "true"/"false")
 * inside the evaluator, so the STRING path is byte-identical whether a caller supplies a String or
 * the native typed value.
 *
 * <p>Instances are immutable.
 */
public data class User(
    /** Targeting identifier. Never null; may be the empty string. */
    val identifier: String,
    /** Optional email for email-based targeting rules. */
    val email: String? = null,
    /** Optional country for country-based targeting rules. */
    val country: String? = null,
    /** Typed custom attribute bag (String / Number / Boolean / List<String>). Empty by default. */
    val custom: Map<String, Any> = emptyMap(),
)
