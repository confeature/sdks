// SPDX-License-Identifier: MIT

/// Synchronous override evaluation — Dart port of the 7-branch decision
/// tree from:
///   - `packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync`
///     (canonical TS reference)
///   - `apps/sdk-python/.../override_eval.py:evaluate_override_sync`
///   - `apps/sdk-go/internal/overrideeval/eval.go:EvaluateSync`
///
/// The 7-branch tree is byte-identical across every runtime. The parity
/// corpus is the canonical gate: drifting between languages breaks
/// constitution Principle II (NON-NEGOTIABLE).
///
/// [evaluateOverrideSync] returns a `(Object?, bool)` record:
///   - `(_, false)` → caller falls through to the cache (Branches 1-3).
///   - `(value, true)` → value is the resolved override result, possibly
///     the supplied default (Branches 4-6: LocalOnly contract — don't
///     fall through). Branch 7 returns the typed override value.
library;

import '../flag_overrides.dart';
import '../user.dart';
import 'evaluator.dart' as evaluator;

/// Resolve [key] synchronously against [flagOverrides].
///
/// Algorithm — byte-identical to TS / Python / Go ports:
///
///   1. flagOverrides == null               → (null, false)  // fall-through
///   2. behaviour != localOnly              → (null, false)  // deferred
///   3. dataSource.getOverridesSync() == null → (null, false)
///   4. key absent                          → (defaultValue, true)
///   5. all four slots null                 → (defaultValue, true)
///   6. type(candidate) != type(default),
///      default != null                     → (defaultValue, true)
///   7. happy path                          → (candidate, true)
///
/// The TYPE_MISMATCH branch (6) preserves the LocalOnly contract: a
/// `null` default bypasses the type check (matches configcat-js's
/// `defaultValue !== null` ternary).
(Object?, bool) evaluateOverrideSync(
  FlagOverrides? flagOverrides,
  String key,
  Object? defaultValue,
) {
  // Branch 1: no overrides configured → caller falls through.
  if (flagOverrides == null) return (null, false);

  // Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
  if (flagOverrides.behaviour != OverrideBehaviour.localOnly) {
    return (null, false);
  }

  // Branch 3: no synchronous data source or null map → fall through.
  final overridesMap = flagOverrides.dataSource.getOverridesSync();
  if (overridesMap == null) return (null, false);

  // From here we are committed to the LocalOnly contract: NEVER fall
  // through to the cache — return either the typed override or the
  // supplied default.

  // Branch 4: key absent → return default.
  final raw = overridesMap[key];
  if (raw == null) return (defaultValue, true);

  // Branch 5: override slot empty → return default.
  final candidate = _pickCandidate(raw);
  if (candidate == null) return (defaultValue, true);

  // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
  // `null` defaultValue intentionally bypasses the check (matches the
  // configcat-js `defaultValue !== null` semantics).
  if (defaultValue != null &&
      candidate.runtimeType != defaultValue.runtimeType) {
    return (defaultValue, true);
  }

  // Branch 7: happy path — typed override value.
  return (candidate, true);
}

/// Pick the first non-null slot of an [ISettingValue].
/// Order: b, s, i, d — mirrors the TS `raw.b ?? raw.s ?? raw.i ?? raw.d`
/// and the Python / Go explicit-if chain.
Object? _pickCandidate(ISettingValue raw) {
  if (raw.b != null) return raw.b;
  if (raw.s != null) return raw.s;
  if (raw.i != null) return raw.i;
  if (raw.d != null) return raw.d;
  return null;
}

/// Full-config override resolution — Dart port of the canonical TS
/// `evaluateFullConfigOverrideSync` (spec 135 / #434, epic #382, US3),
/// mirroring sdk-python's `evaluate_full_config_override_sync` and
/// sdk-dotnet's `EvaluateFullConfigSync`.
///
/// When the override source is a [ConfigOverrideDataSource], resolves
/// [key] through the real Dart evaluator so targeting rules / segments /
/// prerequisites / percentage options apply offline — the rule-bearing
/// sibling of [evaluateOverrideSync]'s flat lookup.
///
/// Returns a `(Object?, bool)` record:
///   - `(null, false)` → overrides absent, behaviour non-LocalOnly, or
///     the source is NOT a full-config source (caller falls through to
///     the flat-map helper / normal eval).
///   - `(value, true)` → the rule-resolved value (LocalOnly contract:
///     never fall through to the cache — the evaluator already returns
///     [defaultValue] for any non-clean resolution, preserving the
///     contract).
///
/// INV-4: the evaluator receives the FULL config map (`{p, f, s}`) —
/// salt (`p.s`) + segments (`s`), never just `f` (the spec-129
/// dropped-salt regression class).
(Object?, bool) evaluateFullConfigOverrideSync<T>(
  FlagOverrides? flagOverrides,
  String key,
  T defaultValue,
  User? user,
) {
  if (flagOverrides == null) return (null, false);
  if (flagOverrides.behaviour != OverrideBehaviour.localOnly) {
    return (null, false);
  }
  final dataSource = flagOverrides.dataSource;
  if (dataSource is! ConfigOverrideDataSource) return (null, false);

  // Pass the FULL config map (salt + segments + f), never just `f`
  // (INV-4). The evaluator never throws — any failure resolves to the
  // caller's default.
  final result =
      evaluator.evaluate<T>(dataSource.config, key, defaultValue, user);
  return (result.value, true);
}

/// Shared override router — Dart port of the canonical TS
/// `evaluateOverride` (spec 135 / #434), mirroring sdk-python's
/// `evaluate_override` and sdk-dotnet's `Evaluate`.
///
/// Dispatches between the flat-map path and the full-config path so the
/// `getValue` call sites change minimally: a [ConfigOverrideDataSource]
/// routes through the real evaluator (with [user] threaded); every other
/// source (map / custom) keeps the existing byte-identical flat-map
/// resolution.
///
/// Returns a `(Object?, bool)` record with the same semantics as
/// [evaluateOverrideSync] / [evaluateFullConfigOverrideSync]:
///   - `(_, false)` → no override applies; caller falls through to the
///     normal cache-driven eval.
///   - `(value, true)` → the resolved override value (LocalOnly contract:
///     don't fall through). Preserved on both paths.
///
/// Dispatch is on the source TYPE, not the resolved value, so a
/// full-config source whose evaluator returns the default still stays on
/// the rule path (never mis-read as value-only).
(Object?, bool) evaluateOverride<T>(
  FlagOverrides? flagOverrides,
  String key,
  T defaultValue,
  User? user,
) {
  if (flagOverrides != null &&
      flagOverrides.behaviour == OverrideBehaviour.localOnly &&
      flagOverrides.dataSource is ConfigOverrideDataSource) {
    return evaluateFullConfigOverrideSync<T>(
      flagOverrides,
      key,
      defaultValue,
      user,
    );
  }
  // Every other source (map / custom) keeps the byte-identical flat-map
  // path.
  return evaluateOverrideSync(flagOverrides, key, defaultValue);
}
