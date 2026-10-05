// SPDX-License-Identifier: MIT

/// Events fired by [ConfeatureClient].
///
/// Drop-in mirror of `configcat_client` 4.x's `Hooks` class (constitution
/// Principle II / epic #574, issue #576). The class name, the four event
/// names, the callback signatures, the constructor-subscription shape, the
/// `addOn*` listener registrars, and the `invoke*` dispatch helpers all
/// match upstream 1:1 so a consumer migrating from ConfigCat renames only
/// the `package:` import.
///
/// Upstream shape mirrored (`configcat_options.dart::Hooks`):
///
/// ```dart
/// class Hooks {
///   Hooks({onError, onConfigChanged, onFlagEvaluated, onClientReady});
///   void addOnError(...);
///   void addOnConfigChanged(...);
///   void addOnFlagEvaluated(...);
///   void addOnClientReady(...);
///   void invokeError(...);
///   void invokeConfigChanged(...);
///   void invokeFlagEvaluated(...);
///   void invokeOnReady();
///   void clear();
/// }
/// ```
///
/// Each event is backed by a LIST of listeners (multi-subscriber), so
/// invoking an event fires every registered listener in registration
/// order. Confeature hardens the invoke helpers with a per-listener
/// guard — a throwing listener can never break a sibling listener or the
/// client (an additive safety divergence; the signatures + dispatch
/// semantics are otherwise byte-for-byte upstream).
///
/// Type adaptations to Confeature's own model (additive, not renaming):
///   - [onConfigChanged] carries the settings map as the
///     `Map<String, dynamic>` slice that Confeature uses for its config
///     model (`config['f']`); upstream types it as `Map<String, Setting>`.
///   - [onFlagEvaluated] carries Confeature's [EvaluationDetails]
///     (defined in `evaluation_details.dart`); upstream carries its own
///     `EvaluationDetails`.
library;

import 'evaluation_details.dart';

/// Events fired by `ConfeatureClient` — drop-in mirror of
/// `configcat_client`'s `Hooks`.
class Hooks {
  /// Construct a hooks bus, optionally subscribing one listener per
  /// event up-front. Additional listeners can be registered later with
  /// the `addOn*` methods. Mirrors upstream's constructor 1:1.
  Hooks({
    void Function(String message, [dynamic error, StackTrace? stackTrace])?
        onError,
    void Function(Map<String, dynamic> entries)? onConfigChanged,
    void Function(EvaluationDetails<dynamic> details)? onFlagEvaluated,
    void Function()? onClientReady,
  }) {
    if (onError != null) _onError.add(onError);
    if (onConfigChanged != null) _onConfigChanged.add(onConfigChanged);
    if (onFlagEvaluated != null) _onFlagEvaluated.add(onFlagEvaluated);
    if (onClientReady != null) _onClientReady.add(onClientReady);
  }

  final List<
      void Function(String message,
          [dynamic error, StackTrace? stackTrace])> _onError = [];
  final List<void Function(Map<String, dynamic> entries)> _onConfigChanged = [];
  final List<void Function(EvaluationDetails<dynamic> details)>
      _onFlagEvaluated = [];
  final List<void Function()> _onClientReady = [];

  /// Has the client-ready event already fired? Tracked so a late
  /// subscriber registered after the client became ready still receives
  /// the event immediately (mirrors upstream's one-shot ready semantics).
  bool _ready = false;

  /// Register a listener for SDK errors (failed fetch / error path).
  void addOnError(
    void Function(String message, [dynamic error, StackTrace? stackTrace])
        onError,
  ) {
    _onError.add(onError);
  }

  /// Register a listener for new config fetched (the FETCHED path).
  void addOnConfigChanged(
    void Function(Map<String, dynamic> entries) onConfigChanged,
  ) {
    _onConfigChanged.add(onConfigChanged);
  }

  /// Register a listener fired on each evaluation producing
  /// [EvaluationDetails].
  void addOnFlagEvaluated(
    void Function(EvaluationDetails<dynamic> details) onFlagEvaluated,
  ) {
    _onFlagEvaluated.add(onFlagEvaluated);
  }

  /// Register a listener fired once when the client first becomes ready.
  /// If the client is already ready, the listener fires immediately.
  void addOnClientReady(void Function() onClientReady) {
    _onClientReady.add(onClientReady);
    if (_ready) {
      _safe(onClientReady);
    }
  }

  /// Fire every error listener. A throwing listener never breaks a
  /// sibling or the client.
  void invokeError(String message, [dynamic error, StackTrace? stackTrace]) {
    for (final hook in List.of(_onError)) {
      _safe(() => hook(message, error, stackTrace));
    }
  }

  /// Fire every config-changed listener with the new settings map.
  void invokeConfigChanged(Map<String, dynamic> entries) {
    for (final hook in List.of(_onConfigChanged)) {
      _safe(() => hook(entries));
    }
  }

  /// Fire every flag-evaluated listener with the evaluation details.
  void invokeFlagEvaluated(EvaluationDetails<dynamic> details) {
    for (final hook in List.of(_onFlagEvaluated)) {
      _safe(() => hook(details));
    }
  }

  /// Fire the client-ready event once. Subsequent calls are no-ops; a
  /// listener registered after the first call still fires immediately
  /// via [addOnClientReady].
  void invokeOnReady() {
    if (_ready) return;
    _ready = true;
    for (final hook in List.of(_onClientReady)) {
      _safe(hook);
    }
  }

  /// Remove every registered listener. Mirrors upstream's `clear()`.
  void clear() {
    _onError.clear();
    _onConfigChanged.clear();
    _onFlagEvaluated.clear();
    _onClientReady.clear();
  }

  /// Run a listener under a guard so a throwing listener can never break
  /// a sibling listener or the client. Additive hardening over upstream,
  /// which calls listeners directly.
  void _safe(void Function() fn) {
    try {
      fn();
      // ignore: avoid_catches_without_on_clauses — a customer callback
      // may throw anything; the guard must catch everything to protect
      // siblings + the client.
    } catch (_) {
      // Swallowed by design — a misbehaving listener is isolated.
    }
  }
}
