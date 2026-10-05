// SPDX-License-Identifier: MIT

/// Immutable snapshot of the cached config + overrides reference.
///
/// `snapshot().getValue` consults [flagOverrides] SYNCHRONOUSLY via
/// [evaluateOverrideSync] before consulting the cached config. The Dart
/// SDK inherits the spec-036 correctness fix from day one.
library;

import 'package:meta/meta.dart';

import 'evaluation_details.dart';
import 'flag_overrides.dart';
import 'internal/evaluator.dart' as evaluator;
import 'internal/override_eval.dart';
import 'user.dart';

/// Immutable view of the last-fetched config + a reference to overrides.
///
/// All methods are synchronous. Construction is cheap — the snapshot
/// holds references, not copies.
@immutable
class ConfeatureSnapshot {
  /// Construct a snapshot. Internal — created by `client.snapshot()`.
  const ConfeatureSnapshot({
    required Map<String, dynamic>? config,
    required FlagOverrides? flagOverrides,
    required User? defaultUser,
    DateTime? fetchTime,
  })  : _config = config,
        _flagOverrides = flagOverrides,
        _defaultUser = defaultUser,
        _fetchTime = fetchTime;

  final Map<String, dynamic>? _config;
  final FlagOverrides? _flagOverrides;
  final User? _defaultUser;
  final DateTime? _fetchTime;

  /// Resolve [key] against the snapshot. Returns [defaultValue] on any
  /// error / miss path. Never throws.
  T getValue<T>(String key, T defaultValue, [User? user]) {
    // Override path FIRST — spec-036 correctness. Route through the
    // full-config-aware router (spec 135 / #434) so a rule-bearing
    // override source resolves targeting rules through the real evaluator
    // (user threaded); the flat-map source is unchanged.
    final effectiveUser = user ?? _defaultUser;
    final (value, handled) =
        evaluateOverride<T>(_flagOverrides, key, defaultValue, effectiveUser);
    if (handled) {
      // The tree may return defaultValue at branches 4/5/6 (or the
      // evaluator's default on the full-config path); that's still
      // "handled" — we MUST NOT fall through to the cache.
      return value as T;
    }
    // Fall through to the cached config + evaluator.
    final result =
        evaluator.evaluate<T>(_config, key, defaultValue, effectiveUser);
    return result.value;
  }

  /// Spec 088 / #266 — typed-envelope mirror of [getValue].
  ///
  /// For LocalOnly consumers, the override map is the only source of
  /// truth: a key present in the map yields the typed value with
  /// `error: null`; a missing key yields the default with
  /// `error: 'KEY_NOT_FOUND'`. The override-eval helper returns the
  /// default on both KEY_NOT_FOUND and TYPE_MISMATCH branches —
  /// the snapshot re-queries the map to disambiguate.
  ///
  /// Non-LocalOnly consumers route through the evaluator; the
  /// `EvaluationResult.error` string propagates verbatim into the
  /// envelope's [EvaluationDetails.error] field.
  EvaluationDetails<T> getValueDetails<T>({
    required String key,
    required T defaultValue,
    User? user,
  }) {
    final effectiveUser = user ?? _defaultUser;

    // Full-config LocalOnly override (spec 135 / #434): a
    // [ConfigOverrideDataSource] carries the whole `{p, f, s}` config and
    // MUST resolve through the real evaluator so targeting rules /
    // percentage options decide the value AND the variationId
    // propagates into the envelope (spec 152 / #475 US2 — the #395
    // variationId-through-override gap class). Routing such a source to
    // the flat-map [_localOnlyDetails] would drop the variationId, since
    // the flat `getOverridesSync()` map carries only base values.
    final fo = _flagOverrides;
    if (fo != null &&
        fo.behaviour == OverrideBehaviour.localOnly &&
        fo.dataSource is ConfigOverrideDataSource) {
      final source = fo.dataSource as ConfigOverrideDataSource;
      return _evaluatorDetails<T>(
        source.config,
        key,
        defaultValue,
        effectiveUser,
      );
    }

    if (_isLocalOnly()) {
      return _localOnlyDetails<T>(key, defaultValue, effectiveUser);
    }
    return _evaluatorDetails<T>(_config, key, defaultValue, effectiveUser);
  }

  /// Build an [EvaluationDetails] envelope by resolving [key] through the
  /// real evaluator against [config], threading the variationId / matched
  /// rule / matched option from the [evaluator.EvaluationResult]. Shared by
  /// the cached-config path and the full-config LocalOnly override path.
  EvaluationDetails<T> _evaluatorDetails<T>(
    Map<String, dynamic>? config,
    String key,
    T defaultValue,
    User? effectiveUser,
  ) {
    final result =
        evaluator.evaluate<T>(config, key, defaultValue, effectiveUser);
    return EvaluationDetails<T>(
      key: key,
      value: result.value,
      variationId: result.variationId,
      user: effectiveUser,
      isDefaultValue: result.error != null,
      error: result.error,
      fetchTime: _fetchTime,
      // FR-011: populate the public placeholders when a targeting rule /
      // percentage option decided the value (spec 123).
      matchedTargetingRule:
          result.matchedTargetingRule != null ? const TargetingRule() : null,
      matchedPercentageOption: result.matchedPercentageOption != null
          ? const PercentageOption()
          : null,
    );
  }

  /// Union of override-map keys and cached-config keys, deduplicated
  /// and sorted alphabetically.
  List<String> getAllKeys() {
    final keys = <String>{};
    // Local copies sidestep the field-promotion limitation (Dart 3.2+
    // field promotion would let us use _config / _flagOverrides
    // directly; we keep the local-copy pattern so the SDK floor can
    // remain at ^3.0.0).
    final config = _config;
    if (config != null) {
      final settings = config['f'];
      if (settings is Map) {
        for (final key in settings.keys) {
          if (key is String) keys.add(key);
        }
      }
    }
    final fo = _flagOverrides;
    if (fo != null) {
      final overrideMap = fo.dataSource.getOverridesSync();
      if (overrideMap != null) {
        keys.addAll(overrideMap.keys);
      }
    }
    final sorted = keys.toList()..sort();
    return sorted;
  }

  bool _isLocalOnly() {
    final fo = _flagOverrides;
    if (fo == null) return false;
    return fo.behaviour == OverrideBehaviour.localOnly;
  }

  EvaluationDetails<T> _localOnlyDetails<T>(
    String key,
    T defaultValue,
    User? effectiveUser,
  ) {
    final fo = _flagOverrides;
    Map<String, ISettingValue>? overrideMap;
    try {
      overrideMap = fo?.dataSource.getOverridesSync();
      // ignore: avoid_catches_without_on_clauses — defensive guard.
    } catch (_) {
      overrideMap = null;
    }
    final present = overrideMap != null && overrideMap.containsKey(key);
    final (value, handled) = evaluateOverrideSync(fo, key, defaultValue);
    if (handled && present) {
      // Re-run the override-eval to detect TYPE_MISMATCH: if the
      // override is present but resolved to the default, that's a
      // type-mismatch path — surface KEY_NOT_FOUND semantics with
      // is_default_value=true for consistency with siblings.
      // Distinguish the two by checking whether the candidate value
      // resolves cleanly.
      final candidate = _pickCandidate(overrideMap[key]);
      final mismatched = candidate != null &&
          defaultValue != null &&
          candidate.runtimeType != defaultValue.runtimeType;
      if (mismatched) {
        return EvaluationDetails<T>(
          key: key,
          value: defaultValue,
          user: effectiveUser,
          isDefaultValue: true,
          error: 'TYPE_MISMATCH',
          fetchTime: _fetchTime,
        );
      }
      return EvaluationDetails<T>(
        key: key,
        value: value as T,
        user: effectiveUser,
        fetchTime: _fetchTime,
      );
    }
    return EvaluationDetails<T>(
      key: key,
      value: defaultValue,
      user: effectiveUser,
      isDefaultValue: true,
      error: 'KEY_NOT_FOUND',
      fetchTime: _fetchTime,
    );
  }
}

Object? _pickCandidate(ISettingValue? raw) {
  if (raw == null) return null;
  if (raw.b != null) return raw.b;
  if (raw.s != null) return raw.s;
  if (raw.i != null) return raw.i;
  if (raw.d != null) return raw.d;
  return null;
}
