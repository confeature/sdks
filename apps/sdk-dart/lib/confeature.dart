// SPDX-License-Identifier: MIT

/// Confeature SDK for Dart / Flutter.
///
/// Drop-in compatible with ConfigCat's `configcat_client` Dart package
/// (constitution Principle II). Public surface:
///
///   - [ConfeatureClient.get] / [ConfeatureClient.builder] — entry point.
///   - [ConfeatureSnapshot] — sync snapshot view returned by
///     `client.snapshot()`.
///   - [User] — targeting context.
///   - [PollingMode] hierarchy: [AutoPoll], [LazyLoad], [ManualPoll].
///   - [FlagOverrides] + [OverrideBehaviour] +
///     [MapOverrideDataSource] — local override support.
///   - [ConfigOverrideDataSource] + [createFlagOverridesFromConfig] —
///     in-memory full-config offline override: drive the real rule engine
///     (targeting rules / segments / prerequisites / % options) from a
///     parsed `config_v6` blob, no network fetch (spec 135 / #434).
///   - [Hooks] — events bus (`onClientReady` / `onConfigChanged` /
///     `onFlagEvaluated` / `onError`), mirroring `configcat_client`'s
///     `Hooks`. Attach via `ConfeatureClient.get(..., hooks: Hooks(...))`.
///   - [Logger] + [StderrLogger] + [LogLevel] — pluggable logging.
///   - [ConfigCache] + [CacheEntry] — pluggable cache for Flutter +
///     custom backends.
///   - [RefreshResult] — return type of `client.forceRefresh()`.
///
/// Consume via:
///
/// ```dart
/// import 'package:confeature/confeature.dart';
///
/// final client = ConfeatureClient.get('configcat-sdk-1/...');
/// final enabled = await client.getValue('feature.dark-mode', false);
/// ```
library;

export 'src/client.dart'
    show ConfeatureClient, ConfeatureClientBuilder, RefreshResult;
export 'src/config_cache.dart';
export 'src/evaluation_details.dart';
export 'src/flag_overrides.dart';
export 'src/hooks.dart' show Hooks;
export 'src/log_level.dart';
export 'src/logger.dart';
export 'src/polling_mode.dart';
export 'src/snapshot.dart';
export 'src/user.dart';
export 'src/version.dart' show sdkVersion;
