// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.Evaluator
import io.confeature.kmp.internal.OverrideEval

/**
 * Immutable read-side view returned by `ConfeatureClient.snapshot()`.
 *
 * <p>Mirrors ConfigCat's `ConfeatureClientSnapshot`: customers that want a stable view of the
 * config across multiple evaluations (e.g. a request scope) can take a snapshot once and then
 * resolve every key against the same captured state.
 *
 * <p>Override resolution runs FIRST (spec-036 correctness, inherited from day one), then falls
 * through to the v1 boolean evaluator against the captured config.
 *
 * <p>[fetchTimeUnixMillis] is the wall-clock epoch-millis of the live client's last successful
 * fetch / cache restore, captured at snapshot construction. Surfaced via
 * [TypedEvaluationDetails.fetchTimeUnixMilliseconds] on every [getValueDetails] call.
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
     * <p>Override resolution runs FIRST. Falls through to the v1 boolean evaluator against the
     * captured config. Returns [defaultValue] on any failure path (key absent, unsupported type,
     * type mismatch).
     */
    public fun getValue(key: String, defaultValue: Any?, user: User? = null): Any? {
        if (flagOverrides != null) {
            val overrideResult = OverrideEval.evaluateSync(flagOverrides, key, defaultValue)
            if (overrideResult.found) return overrideResult.value
            // Non-LocalOnly behaviours are not wired in v1 — the client logs
            // a WARNING + returns defaultValue at the boundary. The snapshot
            // path is symmetrical: fall through to the captured config.
        }

        val effectiveUser = user ?: defaultUser
        return Evaluator.evaluate(configRoot, key, defaultValue, effectiveUser).value
    }

    /**
     * Returns the union of cached-config + override keys, sorted ordinally for deterministic
     * output. Mirrors ConfigCat's `ConfigCatClient#getAllKeys()` return shape
     * (`Collection<String>`). Returns an empty collection when neither the captured config nor
     * any overrides expose keys.
     */
    public fun getAllKeys(): Collection<String> {
        val keys = mutableSetOf<String>()
        settings?.keys?.let { keys.addAll(it) }
        flagOverrides?.dataSource?.getOverridesSync()?.keys?.let { keys.addAll(it) }
        return keys.sorted()
    }

    /**
     * Resolves [key] and wraps the outcome in a [TypedEvaluationDetails] envelope.
     *
     * <p>Mirrors [getValue] but surfaces the variation id / fetch time / targeting-rule envelope
     * upstream consumers rely on. Spec 082 / #266 slice 4/12. Non-suspend at the snapshot level —
     * the snapshot is purely in-memory, no fetch is ever triggered here.
     *
     * <p>For consumers configured with [OverrideBehaviour.LOCAL_ONLY], the override map is the
     * only source of truth: a key present in the map yields the typed value with `error=null`;
     * a missing key yields the default with `error="KEY_NOT_FOUND"`. Without overrides (or with
     * non-LocalOnly behaviour), the evaluator's result is reported directly.
     */
    public fun getValueDetails(
        key: String,
        defaultValue: Any?,
        user: User? = null,
    ): TypedEvaluationDetails<Any?> {
        val effectiveUser = user ?: defaultUser
        val isLocalOnly = flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY

        // Full-config override route (spec 135 / spec 152): when the LocalOnly source carries a
        // complete `{p,f,s}` root (a ConfigOverrideDataSource), resolve through the real Evaluator —
        // salt (`p.s`) + segments (`s`) + targeting rules intact — and PROPAGATE the matched
        // variationId into the details envelope. The value-only LocalOnly map branch below cannot
        // produce a variationId (it never runs the rule engine), so a full-config tuple MUST take
        // this branch or `getValueDetails().variationId` is silently dropped (the #395 gap class).
        if (isLocalOnly) {
            val overrideConfigRoot = flagOverrides!!.dataSource.getConfigRootSync()
            if (overrideConfigRoot != null) {
                val result = Evaluator.evaluate(overrideConfigRoot, key, defaultValue, effectiveUser)
                val errorCode = if (result.error == Evaluator.Error.NONE) null else result.error.name
                return TypedEvaluationDetails(
                    key = key,
                    value = result.value,
                    variationId = result.variationId,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = errorCode != null,
                    error = errorCode,
                )
            }
        }

        if (isLocalOnly) {
            // LocalOnly contract: distinguish "override hit" from "missing key returning
            // default". We re-query the map to disambiguate — OverrideEval.evaluateSync
            // returns the default on both KEY_NOT_FOUND and TYPE_MISMATCH branches,
            // indistinguishable from a legitimate hit whose value equals the default.
            val overridesMap = flagOverrides!!.dataSource.getOverridesSync()
            val keyPresent = overridesMap != null && overridesMap.containsKey(key)
            if (!keyPresent) {
                return TypedEvaluationDetails(
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
                return TypedEvaluationDetails(
                    key = key,
                    value = defaultValue,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = true,
                    error = "MALFORMED_VALUE",
                )
            }
            if (defaultValue != null && candidate::class != defaultValue::class) {
                // Branch 6 — TYPE_MISMATCH.
                return TypedEvaluationDetails(
                    key = key,
                    value = defaultValue,
                    fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                    user = effectiveUser,
                    isDefaultValue = true,
                    error = "TYPE_MISMATCH",
                )
            }
            // Branch 7 — happy path.
            return TypedEvaluationDetails(
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
        return TypedEvaluationDetails(
            key = key,
            value = result.value,
            variationId = result.variationId,
            fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
            user = effectiveUser,
            isDefaultValue = errorCode != null,
            error = errorCode,
        )
    }
}
