// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.Evaluator
import io.confeature.android.internal.OverrideEval

/**
 * Immutable read-side view returned by [ConfeatureClient.snapshot].
 *
 * Mirrors ConfigCat's `com.configcat.ConfigCatClientSnapshot`: customers that want a stable view of
 * the config across multiple evaluations (e.g. a request scope) can take a snapshot once and then
 * resolve every key against the same captured state.
 *
 * Override resolution runs FIRST (spec-036 correctness, inherited from day one), then falls
 * through to the v1 boolean evaluator against the captured config.
 *
 * [fetchTimeUnixMillis] is the wall-clock epoch-millis of the live client's last successful fetch
 * / cache restore, captured at snapshot construction. Surfaced via
 * [EvaluationDetails.fetchTimeUnixMilliseconds] on every [getValueDetails] call.
 */
public class Snapshot(
    public val settings: Map<String, Any?>?,
    private val configRoot: Map<String, Any?>?,
    private val flagOverrides: FlagOverrides?,
    private val defaultUser: User?,
    private val fetchTimeUnixMillis: Long = 0L,
) {
    /**
     * Resolves [key] against the captured config + any configured overrides.
     *
     * Override resolution runs FIRST. Falls through to the v1 boolean evaluator against the
     * captured config. Returns [defaultValue] on any failure path (key absent, unsupported type,
     * type mismatch).
     */
    public fun getValue(key: String, defaultValue: Any?, user: User?): Any? {
        val effectiveUser = user ?: defaultUser
        // Override path FIRST — route through the full-config-aware router (spec
        // 135 / #440) so a rule-bearing ConfigOverrideDataSource resolves
        // targeting rules through the real evaluator (user threaded); the
        // flat-map source keeps the byte-identical value-only path.
        if (flagOverrides != null) {
            val overrideResult = OverrideEval.evaluate(flagOverrides, key, defaultValue, effectiveUser)
            if (overrideResult.found) return overrideResult.value
            // Non-LocalOnly behaviours are not wired in v1 — the client logs
            // a WARNING + returns defaultValue at the boundary. The snapshot
            // path is symmetrical: fall through to the captured config.
        }
        return Evaluator.evaluate(configRoot, key, defaultValue, effectiveUser).value
    }

    /**
     * Returns the union of cached-config + override keys, sorted ordinally for deterministic
     * output. Mirrors ConfigCat's `com.configcat.ConfigCatClient#getAllKeys()` return shape
     * (`Collection<String>`). Returns an empty collection when neither the cached config nor
     * any overrides expose keys.
     */
    public fun getAllKeys(): Collection<String> {
        val keys = sortedSetOf<String>()
        settings?.keys?.let { keys.addAll(it) }
        flagOverrides?.dataSource?.getOverridesSync()?.keys?.let { keys.addAll(it) }
        return keys.toList()
    }

    /**
     * Resolves [key] and wraps the outcome in an [EvaluationDetails] envelope.
     *
     * Mirrors [getValue] but surfaces the variation id / fetch time / targeting-rule envelope
     * upstream consumers rely on. Spec 081 / #266 slice 3/12.
     *
     * For consumers configured with [OverrideBehaviour.LOCAL_ONLY], the override map is the
     * only source of truth: a key present in the map yields the typed value with `error=null`;
     * a missing key yields the default with `error="KEY_NOT_FOUND"`. Without overrides (or with
     * non-LocalOnly behaviour), the evaluator's result is reported directly.
     */
    public fun getValueDetails(key: String, defaultValue: Any?, user: User?): EvaluationDetails<Any?> {
        val effectiveUser = user ?: defaultUser
        val isLocalOnly = flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY
        // Full-config LocalOnly source (spec 135 / #440, spec 152 / #475): route through the real
        // Evaluator so targeting rules / segments / percentage options resolve offline AND the
        // matched variationId / rule / option propagate into the details envelope. The flat-map
        // disambiguation branch below (a value-only map source) cannot produce a variationId — it
        // is the #395 gap class. Dispatch on the source TYPE, exactly like OverrideEval.evaluate.
        if (isLocalOnly && flagOverrides!!.dataSource is ConfigOverrideDataSource) {
            val source = flagOverrides.dataSource as ConfigOverrideDataSource
            val result = Evaluator.evaluate(source.config, key, defaultValue, effectiveUser)
            val errorCode = if (result.error == Evaluator.Error.NONE) null else result.error.name
            return EvaluationDetails(
                key = key,
                value = result.value,
                variationId = result.variationId,
                fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                user = effectiveUser,
                isDefaultValue = errorCode != null,
                error = errorCode,
                matchedTargetingRule = if (result.matchedTargetingRule) TargetingRule() else null,
                matchedPercentageOption = if (result.matchedPercentageOption) PercentageOption() else null,
            )
        }
        if (isLocalOnly) {
            // LocalOnly contract: distinguish "override hit" from "missing key returning
            // default". We re-query the map to disambiguate — OverrideEval.evaluateSync
            // returns the default on both KEY_NOT_FOUND and TYPE_MISMATCH branches,
            // indistinguishable from a legitimate hit whose value equals the default.
            val overridesMap = flagOverrides!!.dataSource.getOverridesSync()
            val keyPresent = overridesMap != null && overridesMap.containsKey(key)
            if (!keyPresent) {
                return EvaluationDetails(
                    key = key,
                    value = defaultValue,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = true,
                    error = "KEY_NOT_FOUND",
                )
            }
            val candidate = overridesMap!![key]
            if (candidate == null) {
                // Branch 5 — empty/null override slot returns default.
                return EvaluationDetails(
                    key = key,
                    value = defaultValue,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = true,
                    error = "MALFORMED_VALUE",
                )
            }
            if (defaultValue != null && candidate.javaClass != defaultValue.javaClass) {
                // Branch 6 — TYPE_MISMATCH.
                return EvaluationDetails(
                    key = key,
                    value = defaultValue,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = true,
                    error = "TYPE_MISMATCH",
                )
            }
            // Branch 7 — happy path.
            return EvaluationDetails(
                key = key,
                value = candidate,
                fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                user = effectiveUser,
                isDefaultValue = false,
                error = null,
            )
        }

        val result = Evaluator.evaluate(configRoot, key, defaultValue, effectiveUser)
        val errorCode = if (result.error == Evaluator.Error.NONE) null else result.error.name
        return EvaluationDetails(
            key = key,
            value = result.value,
            variationId = result.variationId,
            fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
            user = effectiveUser,
            isDefaultValue = errorCode != null,
            error = errorCode,
            matchedTargetingRule = if (result.matchedTargetingRule) TargetingRule() else null,
            matchedPercentageOption = if (result.matchedPercentageOption) PercentageOption() else null,
        )
    }
}
