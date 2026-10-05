// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.FlagOverrides
import io.confeature.kmp.OverrideBehaviour

/**
 * Synchronous override evaluation — port of the canonical TS `evaluateOverrideSync`.
 *
 * <p>7-branch decision tree, byte-identical to:
 *
 * - `packages/sdk-shared/src/override-eval.ts` (TS — canonical).
 * - `apps/sdk-python/.../override_eval.py`.
 * - `apps/sdk-go/internal/overrideeval/eval.go`.
 * - `apps/sdk-dotnet/.../Internal/OverrideEval.cs`.
 * - `apps/sdk-java/.../OverrideEval.java`.
 *
 * <p>The helper is intentionally pure: no logger access, no SDK-key access, no I/O. Pure data in →
 * typed override or sentinel out.
 */
public object OverrideEval {
    /**
     * Result envelope. `found=false` → caller falls through to the cache (Branches 1-3).
     * `found=true` → `value` is the resolved override result, possibly the supplied default
     * (Branches 4-6: LocalOnly contract — don't fall through). Branch 7 returns the typed override
     * value.
     */
    public data class EvalResult(val found: Boolean, val value: Any?)

    /**
     * Walks the 7-branch decision tree.
     *
     * <p>Algorithm — byte-identical to TS / Python / Go / .NET / Java ports:
     *
     * 1. `flagOverrides == null` → `(false, null)` // fall through.
     * 2. `behaviour != LOCAL_ONLY` → `(false, null)` // deferred.
     * 3. `dataSource.getOverridesSync()` returns null → `(false, null)`.
     * 4. key absent → `(true, defaultValue)` // LocalOnly contract.
     * 5. candidate value null → `(true, defaultValue)` // empty override.
     * 6. `candidate::class != defaultValue::class` (and default not null) → `(true, defaultValue)`
     *    // TYPE_MISMATCH.
     * 7. happy path → `(true, candidate)`.
     *
     * <p>The TYPE_MISMATCH branch (6) preserves the LocalOnly contract: a null default bypasses
     * the type check (matches the TS `defaultValue !== null` ternary; Kotlin's null is the
     * equivalent sentinel).
     */
    public fun evaluateSync(
        flagOverrides: FlagOverrides?,
        key: String,
        defaultValue: Any?,
    ): EvalResult {
        // Branch 1: no overrides configured → caller falls through.
        if (flagOverrides == null) return EvalResult(false, null)

        // Branch 2: non-LocalOnly behaviours short-circuit.
        if (flagOverrides.behaviour != OverrideBehaviour.LOCAL_ONLY) return EvalResult(false, null)

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
        if (defaultValue != null && candidate::class != defaultValue::class) {
            return EvalResult(true, defaultValue)
        }

        // Branch 7: happy path — typed override value.
        return EvalResult(true, candidate)
    }
}
