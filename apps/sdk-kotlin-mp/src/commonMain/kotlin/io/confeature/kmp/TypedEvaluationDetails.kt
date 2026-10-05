// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Typed result envelope returned by [ConfeatureClient.getValueDetails] and
 * [Snapshot.getValueDetails].
 *
 * <p>Mirrors upstream `com.configcat.TypedEvaluationDetails` 1:1 field-for-field (spec 082 / #266
 * slice 4/12). Customers migrating from `com.configcat:configcat-kotlin-client` 5.x keep their
 * property access call sites unchanged — name, arity, and shape match upstream exactly.
 *
 * <p>v1 wires [variationId], [matchedTargetingRule], and [matchedPercentageOption] as always-null
 * placeholders — the v1 evaluator produces no variations / targeting-rule matches. A future spec
 * lands the targeting roll-out.
 *
 * @param T the type of the resolved [value]; type-erased helpers use `TypedEvaluationDetails<Any?>`.
 */
public data class TypedEvaluationDetails<T>(
    /** Flag key the consumer asked for; echoed verbatim even on KEY_NOT_FOUND. */
    public val key: String,
    /**
     * Evaluated value of the flag. On any failure path this is the `defaultValue` passed by the
     * caller, and [isDefaultValue] is then `true`.
     */
    public val value: T,
    /**
     * Variation ID from the matched targeting rule / percentage option. Always `null` in v1 —
     * Confeature ships no targeting rules in the v1 corpus.
     */
    public val variationId: String? = null,
    /**
     * Wall-clock epoch-millis at which the active config was last fetched from the CDN (or
     * restored from cache). `0L` until a config has loaded.
     */
    public val fetchTimeUnixMilliseconds: Long = 0L,
    /** The [User] passed to `getValueDetails` (or the default user when none). */
    public val user: User? = null,
    /**
     * `true` when the typed accessor returned the supplied `defaultValue` for any reason
     * (missing key, type mismatch, closed client, malformed config, malformed value, unsupported
     * type).
     */
    public val isDefaultValue: Boolean = false,
    /**
     * Stable evaluator error code on every fail branch; `null` on the happy path. Codes match the
     * parity corpus' tier-0 set: `KEY_NOT_FOUND` / `TYPE_MISMATCH` / `MALFORMED_VALUE` /
     * `UNSUPPORTED_TYPE` / `NO_CONFIG` / `MALFORMED_CONFIG` / `CLIENT_CLOSED`.
     */
    public val error: String? = null,
    /** v1 placeholder — always `null` until targeting rules land. */
    public val matchedTargetingRule: TargetingRule? = null,
    /** v1 placeholder — always `null` until percentage options land. */
    public val matchedPercentageOption: PercentageOption? = null,
)
