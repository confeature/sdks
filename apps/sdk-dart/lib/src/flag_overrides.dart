// SPDX-License-Identifier: MIT

/// Flag-override data sources, behaviour enum, and the production map
/// source.
///
/// Mirrors `configcat_client` 1:1 (constitution Principle II):
/// `localOnly` is fully wired; `localOverRemote` and `remoteOverLocal`
/// are accepted at the type level but the snapshot-eval helper falls
/// through to the cached config (matches the canonical TS spec 031 §R8
/// deferral — non-LocalOnly behaviours pass on the override path).
library;

import 'package:meta/meta.dart';

/// How flag overrides interact with the remote config.
enum OverrideBehaviour {
  /// Only overrides are consulted; remote config is ignored entirely.
  /// The only behaviour wired in v1.
  localOnly,

  /// Overrides shadow the remote config, falling back when a key is
  /// absent in the override map. Deferred — the eval path treats this
  /// as a non-LocalOnly branch and falls through to the cache.
  localOverRemote,

  /// Remote config wins; overrides are consulted only when the remote
  /// config lacks the key. Deferred — same fall-through behaviour as
  /// [localOverRemote].
  remoteOverLocal,
}

/// One slot of a `config_v6.json` setting-value record. Exactly one of
/// [b], [s], [i], [d] is non-null for a valid setting. The
/// override-eval helper picks the first non-null field.
@immutable
class ISettingValue {
  /// Construct an `ISettingValue` with at most one non-null slot.
  const ISettingValue({this.b, this.s, this.i, this.d});

  /// Boolean slot.
  final bool? b;

  /// String slot.
  final String? s;

  /// Integer slot.
  final int? i;

  /// Floating-point slot.
  final double? d;
}

/// Override-data-source interface.
///
/// [getOverridesSync] is the load-bearing method for snapshot-eval; a
/// customer implementation that only supplies the async flavour will
/// see `null` from `getOverridesSync` and the override-eval helper will
/// fall through to the cache.
abstract class IOverrideDataSource {
  /// Default constructor for subclasses.
  const IOverrideDataSource();

  /// Return the override map synchronously, or `null` to defer to the
  /// async path / fall through.
  Map<String, ISettingValue>? getOverridesSync();

  /// Async read. Awaited by the async getValue path. Default impl
  /// returns whatever `getOverridesSync` returns.
  Future<Map<String, ISettingValue>?> getOverrides() async =>
      getOverridesSync();
}

/// In-memory dict-backed override source — the production-default.
///
/// Converts each primitive value to an [ISettingValue] slot once at
/// construction time and returns the same map on every call (stable
/// identity, which lets the override-eval helper short-circuit cheap).
class MapOverrideDataSource extends IOverrideDataSource {
  /// Build from a `Map<String, Object>` of primitive values (bool /
  /// String / int / double). Other types are rejected at construction
  /// time with [ArgumentError].
  MapOverrideDataSource(Map<String, Object> overrides)
      : _map = Map<String, ISettingValue>.unmodifiable({
          for (final entry in overrides.entries)
            entry.key: _toSettingValue(entry.value),
        });

  final Map<String, ISettingValue> _map;

  @override
  Map<String, ISettingValue> getOverridesSync() => _map;

  static ISettingValue _toSettingValue(Object value) {
    // `bool` must be checked before `int` / `num` because Dart's `is
    // int` against `true` is false (Dart booleans are not subclasses of
    // int, unlike Python), but we keep the explicit check anyway for
    // parity with the Python/Go ports.
    if (value is bool) return ISettingValue(b: value);
    if (value is int) return ISettingValue(i: value);
    if (value is double) return ISettingValue(d: value);
    if (value is String) return ISettingValue(s: value);
    throw ArgumentError.value(
      value,
      'overrides',
      'Unsupported override value type ${value.runtimeType}. '
          'Supported types are bool, String, int, double.',
    );
  }
}

/// Full-config override source — holds a complete parsed `config_v6`
/// blob (`{p, f, s}`) and routes through the real evaluator offline.
///
/// Spec 135 / #434 (epic #382, US3): the rule-bearing sibling of
/// [MapOverrideDataSource]. Where the map source emits value-only
/// settings, this source retains the WHOLE `{p, f, s}` config — salt
/// (`p.s`) + segments (`s`) + rule-bearing settings (`f`) — so the Dart
/// evaluator can resolve targeting rules / segments / prerequisites /
/// percentage options purely from the supplied config, no network fetch.
///
/// Additive extension (Principle II): ConfigCat's official Dart SDK
/// (`configcat_client`) only exposes a *file-based* full-config override
/// (`OverrideDataSource.localFile(...)`) alongside the value-only
/// `OverrideDataSource.map(...)`. This in-memory full-config form is the
/// runtime-agnostic equivalent of the file path (the corpus / test-harness
/// use case), mirroring the JS federation's `ConfigOverrideDataSource` /
/// `createFlagOverridesFromConfig` and sdk-python / sdk-dotnet's
/// `ConfigOverrideDataSource`. No ConfigCat-named member is renamed or
/// retyped.
///
/// The whole config map is retained (never just `f`) — the spec-129
/// dropped-salt regression guard (INV-4): percentage bucketing reads
/// `p.s` and segment conditions read `s`.
///
/// This source intentionally does NOT route rule-bearing data through the
/// value-only [getOverridesSync] contract: [getOverridesSync] returns the
/// flat *base* value envelopes (so key enumeration / `getAllKeys` /
/// `getAllValues` work), but resolution itself never goes through that
/// flat map — the override router (`evaluateOverride` in
/// `internal/override_eval.dart`) dispatches on the source TYPE so a
/// [ConfigOverrideDataSource] always routes through the evaluator with the
/// full [config].
class ConfigOverrideDataSource extends IOverrideDataSource {
  /// Build from a complete parsed `config_v6` blob (`{p, f, s}`).
  ///
  /// The full map is retained verbatim (INV-4: salt `p.s` + segments `s`
  /// are NOT dropped). The flat base-value map exposed by
  /// [getOverridesSync] is derived once at construction so key
  /// enumeration is cheap and stable.
  ConfigOverrideDataSource(Map<String, dynamic> config)
      : _config = config,
        _baseValues =
            Map<String, ISettingValue>.unmodifiable(_baseValuesOf(config));

  final Map<String, dynamic> _config;
  final Map<String, ISettingValue> _baseValues;

  /// The full parsed `config_v6` blob (`{p, f, s}`). Consumed by the
  /// full-config override router; never the flat-map path.
  Map<String, dynamic> get config => _config;

  /// Returns the flat *base* value envelopes of the settings (the served
  /// `setting['v']`), so `getAllKeys` / `getAllValues` can enumerate the
  /// override's flag keys. Rule resolution never goes through this map —
  /// the router evaluates the full config through the real evaluator.
  @override
  Map<String, ISettingValue> getOverridesSync() => _baseValues;

  static Map<String, ISettingValue> _baseValuesOf(Map<String, dynamic> config) {
    final out = <String, ISettingValue>{};
    final settings = config['f'];
    if (settings is Map) {
      for (final entry in settings.entries) {
        final key = entry.key;
        final setting = entry.value;
        if (key is! String || setting is! Map) continue;
        final valueSlot = setting['v'];
        if (valueSlot is! Map) continue;
        out[key] = ISettingValue(
          b: valueSlot['b'] is bool ? valueSlot['b'] as bool : null,
          s: valueSlot['s'] is String ? valueSlot['s'] as String : null,
          i: valueSlot['i'] is int ? valueSlot['i'] as int : null,
          d: valueSlot['d'] is double ? valueSlot['d'] as double : null,
        );
      }
    }
    return out;
  }
}

/// (data-source, behaviour) pair passed via the client constructor.
@immutable
class FlagOverrides {
  /// Construct from a data source + a behaviour.
  const FlagOverrides({
    required this.dataSource,
    required this.behaviour,
  });

  /// The override data source.
  final IOverrideDataSource dataSource;

  /// How the overrides interact with the remote config.
  final OverrideBehaviour behaviour;
}

/// Build a [FlagOverrides] from a complete, rule-bearing `config_v6`
/// blob (`{p, f, s}`) evaluated offline through the real Dart evaluator.
///
/// The in-memory, rule-bearing offline-override factory (spec 135 /
/// #434, epic #382, US3). With [OverrideBehaviour.localOnly],
/// `getValue(key, default, user)` resolves targeting rules / segments /
/// prerequisites / percentage options purely from [config] through the
/// real evaluator — no network fetch.
///
/// Additive (Principle II): mirrors the JS federation's
/// `createFlagOverridesFromConfig` and sdk-python's
/// `create_flag_overrides_from_config`. ConfigCat's official Dart SDK
/// exposes the value-only `OverrideDataSource.map(...)` + the file-based
/// `OverrideDataSource.localFile(...)`; this is the runtime-agnostic
/// in-memory full-config equivalent, so a customer can drive the full
/// rule engine from a config blob already resident in memory (the corpus
/// / test-harness use case) on any runtime — including Flutter Web, where
/// a file source cannot reach.
FlagOverrides createFlagOverridesFromConfig(
  Map<String, dynamic> config,
  OverrideBehaviour behaviour,
) {
  return FlagOverrides(
    dataSource: ConfigOverrideDataSource(config),
    behaviour: behaviour,
  );
}
