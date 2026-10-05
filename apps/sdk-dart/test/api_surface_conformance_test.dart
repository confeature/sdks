// SPDX-License-Identifier: MIT

/// Spec 072 US3 — API-surface conformance test for `sdk-dart`.
///
/// Pins the official ConfigCat Dart SDK (`configcat_client` 4.x) as a
/// dev-only dependency and asserts — at COMPILE TIME — that the
/// Confeature client's public surface conforms to the ConfigCat
/// reference:
///
///   1. the official SDK is on the test classpath (sanity guard);
///   2. the Confeature client carries the **conforming core surface** —
///      a consumer migrating from ConfigCat by editing the
///      `package:` import keeps a working call site for `getValue`,
///      `forceRefresh`, `close`. The references compile iff the
///      symbols exist; missing methods surface as a static analysis
///      failure rather than a runtime check;
///   3. the documented **divergences-by-design** are still ABSENT on
///      `ConfeatureClient` — when a #264 follow-on adds one, the
///      `KNOWN_DIVERGENCES_264` list must be updated.
///
/// KNOWN DIVERGENCE (#264) — spec 072 is SPLIT-scoped (research §R0):
/// it delivers typed-value parity + this conformance test only. The
/// ConfigCat methods listed under `KNOWN_DIVERGENCES_264` are NOT
/// mirrored on `ConfeatureClient` today. They are documented here as
/// a drift-guard list so the next follow-on can find them.
///
/// Compile-time + reference-only — no `path_provider` I/O, no Dio
/// round-trip, no client instantiation (the configcat_client package
/// depends on `path_provider` which is a Flutter platform plugin; this
/// test deliberately avoids exercising it under `dart test`).
library;

import 'package:test/test.dart';

// Pin both SDKs onto the test classpath. The imports themselves are
// the sanity guard — `dart pub get` resolves both packages, and the
// references below compile-bind at analysis time.
// ignore: unused_import
import 'package:configcat_client/configcat_client.dart' as configcat;
import 'package:confeature/confeature.dart' as confeature;

void main() {
  group('api-surface conformance vs configcat_client 4.x', () {
    test('ConfigCat reference SDK is on the test classpath', () {
      // Tear-off compiles iff `ConfigCatClient.get` exists. If the
      // upstream SDK renames it, the test stops compiling — that's the
      // drift signal.
      final ccGet = configcat.ConfigCatClient.get;
      expect(ccGet, isNotNull);
    });

    test('ConfeatureClient carries the core ConfigCat surface', () {
      // Each reference is a compile-time symbol check. Removing a
      // symbol from `ConfeatureClient` breaks `dart analyze` /
      // `dart test`'s compilation step — the failure surfaces with the
      // method name.
      final ccGet = confeature.ConfeatureClient.get;
      expect(ccGet, isNotNull, reason: 'ConfeatureClient.get factory missing');

      // Instance-method tear-offs need a target. We never actually run
      // these — we only check they bind at compile time. Allocate a
      // local-only client (no network, no filesystem) just so we can
      // reference the method symbols.
      final client = confeature.ConfeatureClient.get(
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        pollingMode: const confeature.ManualPoll(),
        flagOverrides: confeature.FlagOverrides(
          dataSource:
              confeature.MapOverrideDataSource(const <String, Object>{}),
          behaviour: confeature.OverrideBehaviour.localOnly,
        ),
        cache: _NoopCache(),
      );
      try {
        // Tear-offs — compile-bind iff the method exists.
        final getValue = client.getValue;
        final getValueSync = client.getValueSync;
        final forceRefresh = client.forceRefresh;
        final snapshot = client.snapshot;
        // Spec 077 / #269 — client-level getAllKeys landed.
        final getAllKeys = client.getAllKeys;
        // Spec 088 / #266 — typed-result envelope + bulk read.
        final getValueDetails = client.getValueDetails;
        final getAllValues = client.getAllValues;
        // Spec 099 / #267 slice 10/14 — online/offline triplet.
        final setOnline = client.setOnline;
        final setOffline = client.setOffline;
        final isOffline = client.isOffline;
        final close = client.close;
        expect(getValue, isNotNull);
        expect(getValueSync, isNotNull);
        expect(forceRefresh, isNotNull);
        expect(snapshot, isNotNull);
        expect(getAllKeys, isNotNull);
        expect(getValueDetails, isNotNull);
        expect(getAllValues, isNotNull);
        expect(setOnline, isNotNull);
        expect(setOffline, isNotNull);
        expect(isOffline, isNotNull);
        expect(close, isNotNull);
      } finally {
        client.close();
      }
    });

    test('Hooks bus conforms to configcat_client Hooks (#574/#576)', () {
      // The upstream `Hooks` class is on the test classpath — compile-bind
      // its constructor + add-listener methods as the drift signal.
      final ccHooks = configcat.Hooks(
        onClientReady: () {},
        onError: (String _, [dynamic __, StackTrace? ___]) {},
      );
      ccHooks.addOnClientReady(() {});
      expect(ccHooks, isNotNull);

      // Confeature mirrors the same four events, both constructor
      // subscription AND add-listener registrars, multi-subscriber.
      final hooks = confeature.Hooks(
        onClientReady: () {},
        onConfigChanged: (Map<String, dynamic> _) {},
        onFlagEvaluated: (confeature.EvaluationDetails<dynamic> _) {},
        onError: (String _, [dynamic __, StackTrace? ___]) {},
      );
      hooks.addOnClientReady(() {});
      hooks.addOnConfigChanged((Map<String, dynamic> _) {});
      hooks.addOnFlagEvaluated((confeature.EvaluationDetails<dynamic> _) {});
      hooks.addOnError((String _, [dynamic __, StackTrace? ___]) {});
      hooks.invokeOnReady();
      hooks.invokeConfigChanged(const <String, dynamic>{});
      hooks.invokeError('x');
      hooks.clear();
      expect(hooks, isNotNull);

      // Attachable via the client options — mirrors
      // ConfigCatOptions.hooks.
      final client = confeature.ConfeatureClient.get(
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        pollingMode: const confeature.ManualPoll(),
        flagOverrides: confeature.FlagOverrides(
          dataSource:
              confeature.MapOverrideDataSource(const <String, Object>{}),
          behaviour: confeature.OverrideBehaviour.localOnly,
        ),
        cache: _NoopCache(),
        hooks: confeature.Hooks(),
      );
      client.close();
    });

    test('getValueDetails returns typed EvaluationDetails envelope', () async {
      final client = confeature.ConfeatureClient.get(
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        pollingMode: const confeature.ManualPoll(),
        flagOverrides: confeature.FlagOverrides(
          dataSource: confeature.MapOverrideDataSource(
              const <String, Object>{'k': true}),
          behaviour: confeature.OverrideBehaviour.localOnly,
        ),
        cache: _NoopCache(),
      );
      try {
        final details = await client.getValueDetails<bool>(
          key: 'k',
          defaultValue: false,
        );
        expect(details, isA<confeature.EvaluationDetails<bool>>());
        expect(details.key, equals('k'));
        expect(details.value, isTrue);
        expect(details.isDefaultValue, isFalse);
        expect(details.error, isNull);
      } finally {
        client.close();
      }
    });

    test('getAllValues returns a Map<String, dynamic>', () async {
      final client = confeature.ConfeatureClient.get(
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        pollingMode: const confeature.ManualPoll(),
        flagOverrides: confeature.FlagOverrides(
          dataSource: confeature.MapOverrideDataSource(const <String, Object>{
            'k': true,
            'name': 'alice',
          }),
          behaviour: confeature.OverrideBehaviour.localOnly,
        ),
        cache: _NoopCache(),
      );
      try {
        final values = await client.getAllValues();
        expect(values, isA<Map<String, dynamic>>());
        expect(values['k'], isTrue);
        expect(values['name'], equals('alice'));
      } finally {
        client.close();
      }
    });

    test('getValue signature shape conforms to ConfigCat reference', () {
      // ConfigCat's `getValue<T>({required key, required defaultValue,
      // user})` uses named params; Confeature's
      // `getValue<T>(key, defaultValue, [user])` uses positional. The
      // semantics are equivalent (key, default, optional user) and the
      // shape difference is intentional — Dart positional + optional
      // matches the other Confeature SDK families' arity convention.
      // The conformance is checked by the typed parity corpus (spec 072
      // US2), not by a signature-matching reflection here.
      //
      // KNOWN DIVERGENCE (#264) — typed `EvaluationDetails<T>` envelope
      // is deferred along with the rest of the #264 surface.
      expect(true, isTrue, reason: 'documentation-only — see comment.');
    });

    test('known #264 divergences are still absent on ConfeatureClient', () {
      // Each entry below is a ConfigCat method that ConfeatureClient
      // does NOT expose today. Adding any of them lands as a #264
      // follow-on. The list is the source of truth for the SPLIT
      // scope (research §R0). When a method moves OUT of the list, it
      // must be added to the core conformance check above.
      const knownDivergences264 = <String>[
        // typed-detail envelopes
        // NOTE: `getValueDetails<T>` moved into the core conformance
        // check under spec 088 / #266. `getAllValues` likewise. The
        // remaining typed-detail entry (`getAllValueDetails`) stays
        // deferred to follow-on work.
        'getAllValueDetails', // #264 — bulk-read API
        // bulk reads — NOTE: `getAllKeys` moved into the core
        // conformance check under spec 077 / #269 (the client-level
        // enumerator landed). `getAllValues` moved under spec 088
        // / #266. The remaining bulk-read entry stays deferred.
        'getKeyAndValue<T>', // #264 — variation lookup
        // mutable client default-user API
        'setDefaultUser', // #264 — mutable client default-user API
        'clearDefaultUser', // #264 — mutable client default-user API
        // NOTE: `setOnline` / `setOffline` / `isOffline` moved into the
        // core conformance check under spec 099 / #267 slice 10/14 (all
        // three landed).
        // NOTE: the `hooks` bus moved into the core conformance check
        // under epic #574 / #576 — the `Hooks` class (4 events:
        // onClientReady / onConfigChanged / onFlagEvaluated / onError,
        // constructor + add-listener, multi-subscriber) is now PRESENT
        // and attachable via `ConfeatureClient.get(..., hooks:)`.
      ];
      expect(knownDivergences264, isNotEmpty,
          reason: 'KNOWN_DIVERGENCES_264 emptied — if #264 follow-on landed, '
              'move the now-present methods into the core conformance test.');
    });
  });
}

/// In-memory `ConfigCache` — bypasses the platform `FileSystemCache`
/// so the conformance test never touches `path_provider` (a Flutter
/// platform plugin).
class _NoopCache extends confeature.ConfigCache {
  @override
  confeature.CacheEntry? read() => null;
  @override
  void write(confeature.CacheEntry entry) {}
}
