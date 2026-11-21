// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/** Config V2 type requested by a companion, independent of the fallback's runtime type. */
public enum class ProviderValueType(internal val settingType: Int) {
    BOOLEAN(SettingType.BOOL),
    STRING(SettingType.STRING),
    INTEGER(SettingType.INT),
    DOUBLE(SettingType.DOUBLE);

    internal fun matchesLocalValue(value: Any): Boolean =
        when (this) {
            BOOLEAN -> value is Boolean
            STRING -> value is String
            // Kotlin/JS lowers both is-checks to typeof number. KClass still distinguishes
            // signed Int values from Double. A full config carries its wire type independently.
            INTEGER -> value::class == Int::class
            DOUBLE -> value::class == Double::class && (value as Double).isFinite()
        }

    internal fun readWireValue(raw: Any?): Any? =
        when (this) {
            BOOLEAN -> raw as? Boolean
            STRING -> raw as? String
            INTEGER -> exactInt(raw)
            DOUBLE -> ConfigValues.readDouble(raw)?.takeIf(Double::isFinite)
        }
}

/** Read an integer without truncating a fraction or saturating outside the Config V2 range. */
internal fun exactInt(raw: Any?): Int? {
    val value = ConfigValues.readDouble(raw) ?: return null
    val integral = value.toInt()
    return integral.takeIf { it.toDouble() == value }
}

/** Context-free evaluation result for the optional provider companion. */
public class ProviderResult internal constructor(
    public val value: Any?,
    public val variationId: String?,
    public val status: Status,
    public val match: Match?,
) {
    /** Typed outcomes independent of the SDK's legacy error strings. */
    public enum class Status { RESOLVED, NOT_READY, NOT_FOUND, TYPE_MISMATCH, PARSE_ERROR, GENERAL }

    /** The evaluator resolved a targeting rule or a percentage option. */
    public enum class Match { TARGETING_RULE, PERCENTAGE_OPTION }
}

internal fun Evaluator.Result.toProviderResult(): ProviderResult {
    val status = when (error) {
        Evaluator.Error.NONE -> ProviderResult.Status.RESOLVED
        Evaluator.Error.NO_CONFIG -> ProviderResult.Status.NOT_READY
        Evaluator.Error.KEY_NOT_FOUND -> ProviderResult.Status.NOT_FOUND
        Evaluator.Error.TYPE_MISMATCH, Evaluator.Error.UNSUPPORTED_TYPE -> ProviderResult.Status.TYPE_MISMATCH
        Evaluator.Error.MALFORMED_CONFIG, Evaluator.Error.MALFORMED_VALUE -> ProviderResult.Status.PARSE_ERROR
    }
    val match = when {
        matchedPercentageOption -> ProviderResult.Match.PERCENTAGE_OPTION
        matchedTargetingRule -> ProviderResult.Match.TARGETING_RULE
        else -> null
    }
    return ProviderResult(value, variationId, status, match)
}
