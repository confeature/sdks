// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import io.confeature.android.ConfigOverrideDataSource
import io.confeature.android.FlagOverrides
import io.confeature.android.OverrideBehaviour
import io.confeature.android.User

/**
 * Synchronous override evaluation — port of the canonical TS `evaluateOverrideSync`.
 *
 * 7-branch decision tree, byte-identical to:
 * - `packages/sdk-shared/src/override-eval.ts` (TS — canonical).
 * - `apps/sdk-python/.../override_eval.py`.
 * - `apps/sdk-go/internal/overrideeval/eval.go`.
 * - `apps/sdk-dotnet/.../Internal/OverrideEval.cs`.
 * - `apps/sdk-java/.../internal/OverrideEval.java`.
 *
 * The helper is intentionally pure: no logger access, no SDK-key access, no I/O. Pure data in →
 * typed override or sentinel out.
 */
public object OverrideEval {
    /**
     * Result envelope. `found=false` → caller falls through to the cache (Branches 1-3).
     * `found=true` → [value] is the resolved override result, possibly the supplied default
     * (Branches 4-6: LocalOnly contract — don't fall through). Branch 7 returns the typed override
     * value.
     */
    public data class EvalResult(val found: Boolean, val value: Any?)

    /**
     * Walks the 7-branch decision tree.
     *
     * Algorithm — byte-identical to TS / Python / Go / .NET / Java ports:
     * 1. `flagOverrides == null` → `(false, null)` // fall through.
     * 2. `behaviour != LOCAL_ONLY` → `(false, null)` // deferred.
     * 3. `dataSource.getOverridesSync()` returns null → `(false, null)`.
     * 4. key absent → `(true, defaultValue)` // LocalOnly contract.
     * 5. candidate value `null` → `(true, defaultValue)` // empty override.
     * 6. `candidate.javaClass != defaultValue.javaClass` (and default not null) → `(true, defaultValue)` // TYPE_MISMATCH.
     * 7. happy path → `(true, candidate)`.
     *
     * The TYPE_MISMATCH branch (6) preserves the LocalOnly contract: a `null` default bypasses
     * the type check (matches the TS `defaultValue !== null` ternary).
     */
    @JvmStatic
    public fun evaluateSync(flagOverrides: FlagOverrides?, key: String, defaultValue: Any?): EvalResult {
        // Branch 1: no overrides configured → caller falls through.
        if (flagOverrides == null) return EvalResult(false, null)

        // Branch 2: non-LocalOnly behaviours short-circuit. (v1 enum only
        // declares LOCAL_ONLY, but this guard future-proofs the algorithm
        // for when LOCAL_OVER_REMOTE / REMOTE_OVER_LOCAL land.)
        if (flagOverrides.behaviour != OverrideBehaviour.LOCAL_ONLY) {
            return EvalResult(false, null)
        }

        // Branch 3: no synchronous data source available → fall through.
        val overrides = flagOverrides.dataSource.getOverridesSync() ?: return EvalResult(false, null)

        // From here we are committed to the LocalOnly contract: NEVER fall
        // through to the cache — return either the typed override or the
        // supplied default.

        // Branch 4: key absent → return default.
        if (!overrides.containsKey(key)) return EvalResult(true, defaultValue)

        // Branch 5: override slot empty / null → return default.
        val candidate = overrides[key] ?: return EvalResult(true, defaultValue)

        // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
        // A null defaultValue bypasses the check (matches the TS semantics).
        if (defaultValue != null && candidate.javaClass != defaultValue.javaClass) {
            return EvalResult(true, defaultValue)
        }

        // Branch 7: happy path — typed override value.
        return EvalResult(true, candidate)
    }

    /**
     * Full-config override resolution — port of the canonical TS `evaluateFullConfigOverrideSync`
     * (spec 135 / #440).
     *
     * When the override source is a [ConfigOverrideDataSource], resolves [key] through the real
     * [Evaluator] so targeting rules / segments / prerequisites / percentage options apply offline
     * — the rule-bearing sibling of [evaluateSync]'s flat lookup.
     *
     * Returns `(false, null)` when overrides are absent, behaviour is non-LocalOnly, or the source
     * is NOT a full-config source (caller falls through to the flat-map helper). Returns
     * `(true, value)` with the rule-resolved value otherwise — the LocalOnly contract never falls
     * through to the cache (the evaluator already returns `defaultValue` for any non-clean
     * resolution).
     *
     * INV-4: the evaluator receives the FULL config map (salt `p.s` + segments `s`), never just
     * `f` (the spec-129 dropped-salt regression class). The evaluator never throws — any failure
     * resolves to the caller's default.
     */
    private fun evaluateFullConfigSync(
        flagOverrides: FlagOverrides?,
        key: String,
        defaultValue: Any?,
        user: User?,
    ): EvalResult {
        val source = flagOverrides?.dataSource
        if (flagOverrides == null ||
            flagOverrides.behaviour != OverrideBehaviour.LOCAL_ONLY ||
            source !is ConfigOverrideDataSource
        ) {
            return EvalResult(false, null)
        }
        // Pass the FULL config map (salt + segments + f), never just `f` (INV-4).
        val result = Evaluator.evaluate(source.config, key, defaultValue, user)
        return EvalResult(true, result.value)
    }

    /**
     * Shared override router — port of the canonical TS `evaluateOverride` (spec 135 / #440).
     * Dispatches between the flat-map path and the full-config path so the client call site
     * changes minimally.
     *
     * A [ConfigOverrideDataSource] routes through the real [Evaluator]; every other source
     * (map / custom) keeps the existing byte-identical flat-map resolution. Dispatch is on the
     * source TYPE, not the resolved value, so a full-config source whose evaluator returns the
     * default still stays on the rule path. Preserves the LocalOnly no-fall-through contract on
     * both paths.
     */
    @JvmStatic
    public fun evaluate(flagOverrides: FlagOverrides?, key: String, defaultValue: Any?, user: User?): EvalResult {
        if (flagOverrides != null &&
            flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY &&
            flagOverrides.dataSource is ConfigOverrideDataSource
        ) {
            return evaluateFullConfigSync(flagOverrides, key, defaultValue, user)
        }
        return evaluateSync(flagOverrides, key, defaultValue)
    }
}
