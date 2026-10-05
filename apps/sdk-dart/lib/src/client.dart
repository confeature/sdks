// SPDX-License-Identifier: MIT

/// Top-level entry point — drop-in equivalent of `configcat_client`.
///
/// Lifecycle:
///   1. customer constructs `ConfeatureClient.get(sdkKey, ...)` or uses
///      the [ConfeatureClientBuilder] fluent API.
///   2. AutoPoll spawns its `Timer.periodic` immediately and performs
///      an eager initial fetch; LazyLoad records the fetch callback
///      but doesn't fetch; ManualPoll never fetches on its own.
///   3. `getValue` consults overrides FIRST, then the cached config.
///      The Dart SDK inherits the spec-036 correctness fix from day
///      one.
///   4. `close()` is sync, idempotent, cancels the AutoPoll Timer, and
///      closes the underlying HTTP client.
library;

import 'dart:async';

import 'config_cache.dart';
import 'evaluation_details.dart';
import 'flag_overrides.dart';
import 'hooks.dart';
import 'internal/config_fetcher.dart';
import 'internal/evaluator.dart' as evaluator;
import 'internal/filesystem_cache.dart';
import 'internal/override_eval.dart';
import 'internal/sdk_key.dart';
import 'logger.dart';
import 'polling_mode.dart';
import 'snapshot.dart';
import 'user.dart';
import 'version.dart';

/// Outcome of a [ConfeatureClient.forceRefresh] call.
class RefreshResult {
  /// Construct a refresh result.
  const RefreshResult({required this.success, this.error});

  /// Convenience: successful refresh.
  const RefreshResult.success() : this(success: true);

  /// Convenience: failed refresh with a short reason code.
  const RefreshResult.failure(String reason)
      : this(success: false, error: reason);

  /// Whether the refresh fetched / consumed cached state successfully.
  final bool success;

  /// Short error code on failure — `null` on the happy path.
  final String? error;

  /// Promote a [FetchResult] into a refresh result.
  factory RefreshResult.fromFetch(FetchResult fetch) {
    if (fetch.status == FetchStatus.fetched ||
        fetch.status == FetchStatus.notModified) {
      return const RefreshResult.success();
    }
    return RefreshResult.failure(fetch.error ?? 'FETCH_FAILED');
  }
}

/// Top-level Confeature client.
///
/// Mirrors `configcat_client`'s `ConfigCatClient` 1:1 (constitution
/// Principle II). Construct via [ConfeatureClient.get] or via
/// [ConfeatureClient.builder].
class ConfeatureClient {
  ConfeatureClient._({
    required String sdkKey,
    required PollingMode pollingMode,
    required Logger logger,
    required FlagOverrides? flagOverrides,
    required String? baseUrl,
    required Duration requestTimeout,
    required User? defaultUser,
    required ConfigCache? cache,
    required Hooks? hooks,
  })  : _sdkKey = sdkKey,
        _mode = pollingMode,
        _logger = logger,
        _flagOverrides = flagOverrides,
        _defaultUser = defaultUser,
        _hooks = hooks {
    if (!isValidConfeatureKeyFormat(sdkKey)) {
      _logger.warning(
        'INVALID_SDK_KEY format for sdkKey=${redactSdkKey(sdkKey)}. '
        'Continuing — the SDK is lenient about key format at runtime.',
      );
    }
    _cacheKey = deriveCacheKey(sdkKey);
    _cache = cache ??
        FileSystemCache(
          cacheKey: _cacheKey,
          sdkKey: sdkKey,
          logger: _logger,
        );
    // Restore from any existing cache entry so first getValue can
    // return cached values without waiting for the first fetch.
    final existing = _cache.read();
    if (existing != null) {
      _config = existing.body;
      _etag = existing.etag;
      // Stamp `_fetchTime` so the first `getValueDetails` envelope
      // surfaces a meaningful timestamp (spec 088 / #266).
      _fetchTime = DateTime.fromMillisecondsSinceEpoch(
        (existing.fetchedAt * 1000).toInt(),
        isUtc: true,
      );
    }

    _fetcher = ConfigFetcher(
      sdkKey: sdkKey,
      version: sdkVersion,
      logger: _logger,
      baseUrl: baseUrl,
      requestTimeout: requestTimeout,
    );

    // LocalOnly overrides bypass the network entirely — the client is
    // immediately ready (no fetch to wait for). Mirrors upstream's
    // onClientReady trigger for the local-only path.
    if (_isLocalOnlyMode()) {
      _markReady();
      return;
    }

    // If we restored a config from the on-disk cache, the client is
    // already serviceable before the first fetch — fire ready now.
    if (_config != null) {
      _markReady();
    }

    _startPolling();
  }

  /// Static factory matching `ConfigCatClient.get` 1:1.
  ///
  /// Returns a fully-constructed client. The polling mode defaults to
  /// `AutoPoll()`. For more options use [ConfeatureClient.builder].
  factory ConfeatureClient.get(
    String sdkKey, {
    PollingMode? pollingMode,
    Logger? logger,
    FlagOverrides? flagOverrides,
    String? baseUrl,
    Duration requestTimeout = const Duration(seconds: 30),
    User? defaultUser,
    ConfigCache? cache,
    Hooks? hooks,
  }) {
    if (sdkKey.isEmpty) {
      throw ArgumentError.value(sdkKey, 'sdkKey', 'must be a non-empty string');
    }
    if (requestTimeout.inMicroseconds <= 0) {
      throw ArgumentError.value(
        requestTimeout,
        'requestTimeout',
        'must be > 0',
      );
    }
    return ConfeatureClient._(
      sdkKey: sdkKey,
      pollingMode: pollingMode ?? const AutoPoll(),
      logger: logger ?? defaultLogger(),
      flagOverrides: flagOverrides,
      baseUrl: baseUrl,
      requestTimeout: requestTimeout,
      defaultUser: defaultUser,
      cache: cache,
      hooks: hooks,
    );
  }

  /// Fluent builder — mirrors `configcat_client`'s
  /// `ConfigCatClient.builder()`.
  static ConfeatureClientBuilder builder(String sdkKey) =>
      ConfeatureClientBuilder(sdkKey);

  final String _sdkKey;
  final PollingMode _mode;
  final Logger _logger;
  final FlagOverrides? _flagOverrides;
  final User? _defaultUser;
  final Hooks? _hooks;

  late final String _cacheKey;
  late final ConfigCache _cache;
  late final ConfigFetcher _fetcher;

  Map<String, dynamic>? _config;
  String? _etag;
  Timer? _autoPollTimer;
  DateTime? _lastFetchedAt;
  // UTC wall-clock at which `_config` was last refreshed from the CDN
  // or restored from the on-disk cache. Surfaced via
  // `EvaluationDetails.fetchTime` (spec 088 / #266). `null` until any
  // config has loaded.
  DateTime? _fetchTime;
  bool _closed = false;
  // Spec 099 / #267 slice 10/14 — mirrors configcat_client's offline flag.
  // Dart is single-threaded per isolate (cooperative async) so a plain
  // `bool` matches the `_closed` discipline.
  bool _offline = false;

  bool _isLocalOnlyMode() {
    final fo = _flagOverrides;
    if (fo == null) return false;
    return fo.behaviour == OverrideBehaviour.localOnly;
  }

  /// Fire `onClientReady` exactly once. [Hooks.invokeOnReady] is itself
  /// one-shot, so repeated calls (cache hydrate, then first fetch) are
  /// idempotent.
  void _markReady() {
    _hooks?.invokeOnReady();
  }

  void _startPolling() {
    final mode = _mode;
    if (mode is AutoPoll) {
      // Kick off the initial fetch immediately — first getValue can
      // wait on it up to `maxInitWaitTime`. Fire-and-forget; the
      // fetcher already fail-closes on errors.
      unawaited(_fetchAndApply());
      _autoPollTimer = Timer.periodic(mode.pollInterval, (_) {
        if (_closed) return;
        unawaited(_fetchAndApply());
      });
    }
    // LazyLoad + ManualPoll fetch on demand only; nothing to start.
  }

  Future<FetchResult> _fetchAndApply() async {
    if (_offline) {
      // Spec 099 / #267 — no HTTP while offline. Covers AutoPoll timer,
      // LazyLoad on-demand, and forceRefresh.
      return const FetchResult.failed('OFFLINE_MODE');
    }
    final result = await _fetcher.fetch(_etag);
    if (result.status == FetchStatus.fetched && result.body != null) {
      _config = result.body;
      _etag = result.etag;
      _lastFetchedAt = DateTime.now();
      // Stamp `_fetchTime` for `EvaluationDetails.fetchTime`
      // (spec 088 / #266).
      _fetchTime = DateTime.now().toUtc();
      try {
        _cache.write(
          CacheEntry(
            body: result.body!,
            etag: result.etag,
            fetchedAt: DateTime.now().millisecondsSinceEpoch / 1000.0,
          ),
        );
      } on Exception catch (exc) {
        _logger.warning(
          '_fetchAndApply: cache write failed '
          '(sdkKey=${redactSdkKey(_sdkKey)}): $exc',
        );
      }
      // Hooks (#576): a new config was fetched (FETCHED path) — emit
      // onConfigChanged with the settings map, then mark ready so the
      // first successful fetch fires onClientReady.
      final settings = result.body!['f'];
      _hooks?.invokeConfigChanged(
        settings is Map<String, dynamic>
            ? settings
            : (settings is Map
                ? settings.cast<String, dynamic>()
                : <String, dynamic>{}),
      );
      _markReady();
    } else if (result.status == FetchStatus.notModified) {
      if (result.etag != null) _etag = result.etag;
      _lastFetchedAt = DateTime.now();
      // `notModified` still confirms freshness — refresh stamp.
      _fetchTime = DateTime.now().toUtc();
      // A 304 still confirms the client is serviceable.
      _markReady();
    } else if (result.status == FetchStatus.failed) {
      // Hooks (#576): surface the SDK error on the failed-fetch path.
      _hooks?.invokeError(
        'Config fetch failed: ${result.error ?? 'FETCH_FAILED'}',
      );
    }
    return result;
  }

  /// Resolve [key] against the latest cached config + overrides.
  ///
  /// The four `SettingType` discriminators all resolve through this
  /// method (spec 072 / issue #259): `t=0` returns a Dart `bool`, `t=1`
  /// a `String`, `t=2` an `int` (strict — `double` defaults refuse), and
  /// `t=3` a `double` (strict — `int` defaults refuse; integer-valued
  /// JSON numbers widen to `double` per Dart's `jsonDecode` semantics).
  /// The generic `T` round-trip is preserved.
  ///
  /// Always returns [defaultValue] on any error / miss path. Never
  /// throws.
  Future<T> getValue<T>(String key, T defaultValue, [User? user]) async {
    if (_closed) return defaultValue;

    // Override path FIRST — spec-036 correctness. Route through the
    // full-config-aware router (spec 135 / #434): a rule-bearing
    // ConfigOverrideDataSource resolves targeting rules through the real
    // evaluator (user threaded); the flat-map source keeps the
    // byte-identical value-only path.
    final effectiveUser = user ?? _defaultUser;
    final (value, handled) =
        evaluateOverride<T>(_flagOverrides, key, defaultValue, effectiveUser);
    if (handled) return value as T;

    // LazyLoad: fetch on stale read.
    final mode = _mode;
    if (mode is LazyLoad) {
      final last = _lastFetchedAt;
      final stale = last == null ||
          DateTime.now().difference(last) >= mode.cacheRefreshInterval;
      if (stale) {
        try {
          await _fetchAndApply();
        } on Exception catch (exc) {
          _logger.warning(
            'getValue: lazy fetch raised '
            '(sdkKey=${redactSdkKey(_sdkKey)}): $exc',
          );
        }
      }
    }

    final result =
        evaluator.evaluate<T>(_config, key, defaultValue, effectiveUser);
    return result.value;
  }

  /// Synchronous variant — convenient for `snapshot().getValue` callers
  /// who want a non-async API. Skips the LazyLoad fetch (use
  /// [snapshot] + `getValue` for that).
  ///
  /// Resolves the four `SettingType` discriminators identically to
  /// [getValue] (spec 072 / issue #259).
  T getValueSync<T>(String key, T defaultValue, [User? user]) {
    if (_closed) return defaultValue;
    // Override path FIRST — spec-036 correctness. Router threads the user
    // so a full-config override source resolves targeting rules through
    // the real evaluator (spec 135 / #434); the flat-map source keeps the
    // byte-identical value-only path.
    final effectiveUser = user ?? _defaultUser;
    final (value, handled) =
        evaluateOverride<T>(_flagOverrides, key, defaultValue, effectiveUser);
    if (handled) return value as T;
    final result =
        evaluator.evaluate<T>(_config, key, defaultValue, effectiveUser);
    return result.value;
  }

  /// Take a synchronous snapshot of the current cached config +
  /// overrides reference.
  ConfeatureSnapshot snapshot() => ConfeatureSnapshot(
        config: _config,
        flagOverrides: _flagOverrides,
        defaultUser: _defaultUser,
        fetchTime: _fetchTime,
      );

  /// Returns the union of cached-config + override keys, sorted
  /// alphabetically. Mirrors ConfigCat's `ConfigCatClient.getAllKeys`
  /// (spec 077 / #269).
  ///
  /// Closed clients return an empty list (matches the closed-client
  /// semantics of [getValue]). Delegates to
  /// [ConfeatureSnapshot.getAllKeys] so the underlying read path is
  /// identical to the snapshot accessor.
  List<String> getAllKeys() {
    if (_closed) return const <String>[];
    return snapshot().getAllKeys();
  }

  /// Spec 088 / #266 — typed-envelope mirror of [getValue].
  ///
  /// Drop-in equivalent of upstream
  /// `ConfigCatClient.getValueDetails<T>`: identical
  /// `({required key, required defaultValue, user})` named-param shape
  /// and identical [EvaluationDetails] return shape.
  ///
  /// Closed clients return an envelope built via
  /// `EvaluationDetails.makeError(key, defaultValue, 'CLIENT_CLOSED', user)`
  /// to match the closed-client read semantics of [getValue].
  ///
  /// LazyLoad consumers trigger an on-demand fetch when the cached
  /// config is stale before evaluating, mirroring [getValue]'s
  /// behaviour.
  Future<EvaluationDetails<T>> getValueDetails<T>({
    required String key,
    required T defaultValue,
    User? user,
  }) async {
    if (_closed) {
      return EvaluationDetails.makeError<T>(
        key,
        defaultValue,
        'CLIENT_CLOSED',
        user,
      );
    }

    // LazyLoad: fetch on stale read.
    final mode = _mode;
    if (mode is LazyLoad) {
      final last = _lastFetchedAt;
      final stale = last == null ||
          DateTime.now().difference(last) >= mode.cacheRefreshInterval;
      if (stale) {
        try {
          await _fetchAndApply();
        } on Exception catch (exc) {
          _logger.warning(
            'getValueDetails: lazy fetch raised '
            '(sdkKey=${redactSdkKey(_sdkKey)}): $exc',
          );
        }
      }
    }

    final details = snapshot().getValueDetails<T>(
      key: key,
      defaultValue: defaultValue,
      user: user,
    );
    // Hooks (#576): each evaluation producing EvaluationDetails fires
    // onFlagEvaluated.
    _hooks?.invokeFlagEvaluated(details);
    return details;
  }

  /// Spec 088 / #266 — evaluates every known flag for [user] and
  /// returns a `Map<String, dynamic>`.
  ///
  /// Drop-in equivalent of upstream `ConfigCatClient.getAllValues`:
  /// identical optional-named-`user` signature and identical return
  /// shape.
  ///
  /// Iterates the union of cached-config flag keys + override keys
  /// (the same set [getAllKeys] returns). Per-key value is the
  /// setting's native value — overrides first, then the cached
  /// config. The native-value read bypasses the type-check that
  /// [getValue] would apply against a `null` default; upstream
  /// `ConfigCatClient.getAllValues` likewise reads each setting's raw
  /// value without applying a type check.
  ///
  /// Closed clients return an empty map.
  Future<Map<String, dynamic>> getAllValues({User? user}) async {
    if (_closed) return <String, dynamic>{};

    // LazyLoad: fetch on stale read so consumers see fresh values.
    final mode = _mode;
    if (mode is LazyLoad) {
      final last = _lastFetchedAt;
      final stale = last == null ||
          DateTime.now().difference(last) >= mode.cacheRefreshInterval;
      if (stale) {
        try {
          await _fetchAndApply();
        } on Exception catch (exc) {
          _logger.warning(
            'getAllValues: lazy fetch raised '
            '(sdkKey=${redactSdkKey(_sdkKey)}): $exc',
          );
        }
      }
    }

    final out = <String, dynamic>{};
    final snap = snapshot();
    for (final key in snap.getAllKeys()) {
      final value = _readNativeValue(key);
      if (value != null) {
        out[key] = value;
      }
    }
    final _ = user; // accepted-but-ignored signal; v1 evaluator ignores user
    return out;
  }

  /// Reads the per-setting native value from overrides first, then the
  /// cached config — without the type-check that [getValue] applies
  /// against a default. Used by [getAllValues] to mirror upstream's
  /// `ConfigCatClient.getAllValues` semantics (no default → no type
  /// check; setting's native type wins).
  Object? _readNativeValue(String key) {
    final fo = _flagOverrides;
    if (fo != null) {
      Map<String, ISettingValue>? overrideMap;
      try {
        overrideMap = fo.dataSource.getOverridesSync();
        // ignore: avoid_catches_without_on_clauses — defensive guard.
      } catch (_) {
        overrideMap = null;
      }
      if (overrideMap != null && overrideMap.containsKey(key)) {
        final raw = overrideMap[key];
        if (raw != null) {
          if (raw.b != null) return raw.b;
          if (raw.s != null) return raw.s;
          if (raw.i != null) return raw.i;
          if (raw.d != null) return raw.d;
        }
      }
    }
    final config = _config;
    if (config != null) {
      final settings = config['f'];
      if (settings is Map) {
        final setting = settings[key];
        if (setting is Map) {
          final valueSlot = setting['v'];
          if (valueSlot is Map) {
            if (valueSlot.containsKey('b')) return valueSlot['b'];
            if (valueSlot.containsKey('s')) return valueSlot['s'];
            if (valueSlot.containsKey('i')) return valueSlot['i'];
            if (valueSlot.containsKey('d')) return valueSlot['d'];
          }
        }
      }
    }
    return null;
  }

  /// Trigger an off-cadence fetch. LocalOnly mode returns success
  /// without touching the network. Closed clients return failure.
  Future<RefreshResult> forceRefresh() async {
    if (_closed) {
      return const RefreshResult.failure('CLIENT_CLOSED');
    }
    if (_isLocalOnlyMode()) {
      return const RefreshResult.success();
    }
    if (_offline) {
      // Spec 099 / #267 — no HTTP while offline.
      return const RefreshResult.failure('OFFLINE_MODE');
    }
    final result = await _fetchAndApply();
    return RefreshResult.fromFetch(result);
  }

  /// Re-enables HTTP polling. Idempotent.
  ///
  /// Mirrors `configcat_client`'s `ConfigCatClient.setOnline()` (spec 099 /
  /// #267 slice 10/14). Closed clients log warning + no-op. LocalOnly
  /// clients log warning + no-op (LocalOnly never polls — flag has no
  /// effect).
  void setOnline() {
    if (_closed) {
      _logger.warning(
        'setOnline called after close (sdkKey=${redactSdkKey(_sdkKey)})',
      );
      return;
    }
    if (_isLocalOnlyMode()) {
      _logger.warning(
        'Client is configured to use the LOCAL_ONLY override behaviour, '
        'thus setOnline has no effect (sdkKey=${redactSdkKey(_sdkKey)})',
      );
      return;
    }
    _offline = false;
  }

  /// Suspends HTTP polling; serves the cached config. Idempotent.
  ///
  /// Mirrors `configcat_client`'s `ConfigCatClient.setOffline()` (spec 099
  /// / #267 slice 10/14). Closed clients log warning + no-op. LocalOnly
  /// clients are a silent no-op.
  void setOffline() {
    if (_closed) {
      _logger.warning(
        'setOffline called after close (sdkKey=${redactSdkKey(_sdkKey)})',
      );
      return;
    }
    if (_isLocalOnlyMode()) {
      return;
    }
    _offline = true;
  }

  /// Returns `true` when HTTP polling is suspended.
  ///
  /// Mirrors `configcat_client`'s `ConfigCatClient.isOffline()` (spec 099
  /// / #267 slice 10/14). Closed clients return `true`. LocalOnly clients
  /// return `true` (LocalOnly never polls).
  bool isOffline() {
    if (_closed) return true;
    if (_isLocalOnlyMode()) return true;
    return _offline;
  }

  /// Stop the AutoPoll Timer + close the HTTP client. Idempotent.
  void close() {
    if (_closed) return;
    _closed = true;
    final timer = _autoPollTimer;
    if (timer != null) {
      timer.cancel();
      _autoPollTimer = null;
    }
    // Release hook listeners (mirrors upstream's hooks.clear() on close).
    _hooks?.clear();
    _fetcher.close();
  }
}

/// Fluent builder — mirrors `configcat_client`'s
/// `ConfigCatClient.builder()`.
class ConfeatureClientBuilder {
  /// Construct a builder bound to a particular SDK key.
  ConfeatureClientBuilder(this._sdkKey);

  final String _sdkKey;
  PollingMode? _pollingMode;
  Logger? _logger;
  FlagOverrides? _flagOverrides;
  String? _baseUrl;
  Duration _requestTimeout = const Duration(seconds: 30);
  User? _defaultUser;
  ConfigCache? _cache;
  Hooks? _hooks;

  /// Set the polling mode.
  ConfeatureClientBuilder withPollingMode(PollingMode mode) {
    _pollingMode = mode;
    return this;
  }

  /// Set the logger.
  ConfeatureClientBuilder withLogger(Logger logger) {
    _logger = logger;
    return this;
  }

  /// Set the flag overrides.
  ConfeatureClientBuilder withFlagOverrides(FlagOverrides overrides) {
    _flagOverrides = overrides;
    return this;
  }

  /// Set the CDN base URL.
  ConfeatureClientBuilder withBaseUrl(String baseUrl) {
    _baseUrl = baseUrl;
    return this;
  }

  /// Set the per-request HTTP timeout.
  ConfeatureClientBuilder withRequestTimeout(Duration timeout) {
    _requestTimeout = timeout;
    return this;
  }

  /// Set the default user.
  ConfeatureClientBuilder withDefaultUser(User user) {
    _defaultUser = user;
    return this;
  }

  /// Set a custom [ConfigCache] — typically used by Flutter consumers
  /// who wrap `path_provider`.
  ConfeatureClientBuilder withCache(ConfigCache cache) {
    _cache = cache;
    return this;
  }

  /// Attach a [Hooks] events bus — mirrors `configcat_client`'s
  /// `ConfigCatOptions.hooks`.
  ConfeatureClientBuilder withHooks(Hooks hooks) {
    _hooks = hooks;
    return this;
  }

  /// Materialize the configured client.
  ConfeatureClient build() => ConfeatureClient.get(
        _sdkKey,
        pollingMode: _pollingMode,
        logger: _logger,
        flagOverrides: _flagOverrides,
        baseUrl: _baseUrl,
        requestTimeout: _requestTimeout,
        defaultUser: _defaultUser,
        cache: _cache,
        hooks: _hooks,
      );
}
