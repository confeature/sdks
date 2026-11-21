// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.EvaluationRequest
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
        val request = EvaluationRequest(key, defaultValue, Evaluator.fromPublicUser(effectiveUser))
        val result = resolveCachedDetails(configRoot, flagOverrides, request)
        return result.toDetails(key, effectiveUser, fetchTimeUnixMillis)
    }
}

/** One resolver for the immutable snapshot and the synchronous companion bridge. */
internal fun resolveCachedDetails(
    configRoot: Map<String, Any?>?,
    flagOverrides: FlagOverrides?,
    request: EvaluationRequest,
): Evaluator.Result {
    val local = flagOverrides?.takeIf { it.behaviour == OverrideBehaviour.LOCAL_ONLY }
    if (local != null) {
        // Keep the full Config V2 root so salt, segments and variation IDs survive LocalOnly.
        val root = local.dataSource.getConfigRootSync()
        if (root == null) {
            val key = request.key
            val defaultValue = request.fallback
            val values = local.dataSource.getOverridesSync()
            if (values == null || !values.containsKey(key)) {
                return Evaluator.Result(defaultValue, Evaluator.Error.KEY_NOT_FOUND)
            }
            val value = values[key] ?: return Evaluator.Result(defaultValue, Evaluator.Error.MALFORMED_VALUE)
            val matches = request.providerType?.matchesLocalValue(value)
                ?: (defaultValue == null || value::class == defaultValue::class)
            return if (matches) {
                Evaluator.Result(value, Evaluator.Error.NONE)
            } else {
                Evaluator.Result(defaultValue, Evaluator.Error.TYPE_MISMATCH)
            }
        }
        return Evaluator.evaluateCached(root, request)
    }
    return Evaluator.evaluateCached(configRoot, request)
}

internal fun Evaluator.Result.toDetails(
    key: String,
    user: User?,
    fetchTime: Long,
): TypedEvaluationDetails<Any?> = TypedEvaluationDetails(
    key = key,
    value = value,
    variationId = variationId,
    fetchTimeUnixMilliseconds = fetchTime,
    user = user,
    isDefaultValue = error != Evaluator.Error.NONE,
    error = error.takeUnless { it == Evaluator.Error.NONE }?.name,
)
