<!-- SPDX-License-Identifier: MIT -->

# confeature (Dart / Flutter)

Dart / Flutter SDK for [Confeature](https://confeature.io) — a drop-in
replacement for ConfigCat's official `configcat_client` package.
Migrate by renaming the pub.dev dependency and updating
`import 'package:configcat_client/...'` to
`import 'package:confeature/...'`; no code changes are needed for the
common evaluation paths.

## Install

```yaml
# pubspec.yaml
dependencies:
  confeature: ^0.1.0
```

> pub.dev publish is deferred; for now, point at the monorepo via a
> `git` dependency or build locally from `apps/sdk-dart/`.

Requires Dart SDK ≥ 3.0 (records). Pure-Dart — works under the Dart VM,
Flutter (iOS / Android / web / desktop), and AOT snapshots. No Flutter
dependency in the package itself; Flutter consumers integrate
`path_provider` themselves via a custom [`ConfigCache`](#config-cache)
implementation if they want filesystem persistence on mobile.

## Quickstart

```dart
import 'package:confeature/confeature.dart';

Future<void> main() async {
  final client = ConfeatureClient.get(
    'configcat-sdk-1/<22 chars>/<22 chars>',
  );
  final user = User(identifier: 'alice@example.com');
  final enabled =
      await client.getValue('feature.dark-mode', false, user);
  print('dark mode: $enabled');
  client.close();
}
```

SDK keys are minted in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>`. Keys minted before that change,
`confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted. A key in
neither shape logs a redacted `INVALID_SDK_KEY` warning; the client does
not throw. The config is fetched from ConfigCat's path,
`<baseUrl>/configuration-files/<sdkKey>/config_v6.json`: a well-shaped key
travels raw (a ConfigCat-shaped key is three path segments), and any other
key is escaped into one segment exactly as Go's `url.PathEscape` does. The
empty key, `.` and `..` are never requested, and a base URL that is not an
absolute `http(s)` URL, or that holds a `?` or `#` (which would move the key
out of the path, into the query string or the fragment), fails with the
fixed code `INVALID_REQUEST` and sends no request. No log
line or error ever quotes the request URL.

The default polling mode (`AutoPoll`) spawns a `Timer.periodic` that
fetches the latest config every 60 seconds in the background. Each
`getValue` call returns the in-memory cached value (sub-millisecond)
and falls back to the supplied default on any failure path. The SDK
never throws from a public method.

## Polling modes

Mirrors `configcat_client`'s three options 1:1:

```dart
import 'package:confeature/confeature.dart';

// AutoPoll — Timer.periodic, 60s cadence by default.
ConfeatureClient.get('sdk-key',
    pollingMode: const AutoPoll(
      pollInterval: Duration(seconds: 30),
      maxInitWaitTime: Duration(seconds: 5),
    ));

// LazyLoad — fetch on first stale read.
ConfeatureClient.get('sdk-key',
    pollingMode: const LazyLoad(cacheRefreshInterval: Duration(seconds: 60)));

// ManualPoll — only when you call client.forceRefresh().
ConfeatureClient.get('sdk-key', pollingMode: const ManualPoll());
```

## Fluent builder

```dart
final client = ConfeatureClient.builder('configcat-sdk-1/...')
    .withPollingMode(const ManualPoll())
    .withFlagOverrides(FlagOverrides(
      dataSource: MapOverrideDataSource({'feature.x': true}),
      behaviour: OverrideBehaviour.localOnly,
    ))
    .withLogger(StderrLogger(level: LogLevel.warning))
    .build();
```

## Flag overrides

`FlagOverrides(dataSource, behaviour)` lets you serve flag values from
a local source instead of (or alongside) the remote config. Pass via
the client constructor:

```dart
final client = ConfeatureClient.get(
  'sdk-key',
  flagOverrides: FlagOverrides(
    dataSource: MapOverrideDataSource({'feature.x': true}),
    behaviour: OverrideBehaviour.localOnly,
  ),
);
assert(client.getValueSync('feature.x', false) == true);
```

Behaviours:

- `OverrideBehaviour.localOnly` — overrides only; the remote config is
  never consulted. Use for tests + local dev. Available in v0.1.
- `OverrideBehaviour.localOverRemote` / `OverrideBehaviour.remoteOverLocal`
  — accepted at the type level; treated as fall-through (defer to the
  cached config) in v0.1 (matches spec 031 §R8 deferral).

The Dart SDK inherits the spec-036 snapshot-correctness fix from day
one: `snapshot().getValue()` resolves overrides synchronously before
any background poll has happened.

## User targeting

```dart
final user = User(
  identifier: 'user-id-123',
  email: 'alice@example.com',
  country: 'EU',
  custom: {'plan': 'pro', 'region': 'EU'},
);
final enabled = await client.getValue('feature.dark-mode', false, user);
```

The `User` class mirrors `ConfigCatUser` 1:1. Targeting **rule
evaluation** itself lands progressively — v0.1 returns the rule-less
default value for boolean flags.

## Logging

```dart
import 'package:confeature/confeature.dart';

final client = ConfeatureClient.get(
  'sdk-key',
  logger: StderrLogger(level: LogLevel.warning),
);
```

`LogLevel.warning` is the recommended floor for production — it
surfaces the operationally-actionable signals (fetch failures,
`INVALID_SDK_KEY`, cache fallback events) without flooding logs. The
SDK key **never** appears in any log line — every site that references
a key passes it through `redactSdkKey()` first (Constitution security
clause).

### Custom logger

Implement the `Logger` abstract class:

```dart
class MyLogger extends Logger {
  @override void debug(String message) {/* … */}
  @override void info(String message) {/* … */}
  @override void warning(String message) {/* … */}
  @override void error(String message) {/* … */}
}

final client = ConfeatureClient.get('sdk-key', logger: MyLogger());
```

## Hooks (events)

`Hooks` mirrors `configcat_client`'s `Hooks` 1:1 — four events, each
backed by a multi-subscriber listener list. Attach it via the `hooks:`
option (the analogue of upstream's `ConfigCatOptions.hooks`):

```dart
import 'package:confeature/confeature.dart';

final hooks = Hooks(
  onClientReady: () => print('client ready'),
  onConfigChanged: (entries) => print('config changed: ${entries.keys}'),
  onFlagEvaluated: (details) => print('${details.key} = ${details.value}'),
  onError: (message, [error, stackTrace]) => print('SDK error: $message'),
);

// Register more listeners at any time:
hooks.addOnFlagEvaluated((details) => audit(details));

final client = ConfeatureClient.get('sdk-key', hooks: hooks);
// …or via the builder: ConfeatureClient.builder('sdk-key').withHooks(hooks)
```

| Event             | Fires when                                                                                            | Payload                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `onClientReady`   | the client first becomes serviceable (cache hydrate, LocalOnly, or first successful fetch) — **once** | —                                                 |
| `onConfigChanged` | a new config is fetched (the FETCHED path; not a 304)                                                 | `Map<String, dynamic>` settings map               |
| `onFlagEvaluated` | each evaluation that produces an `EvaluationDetails` (the `getValueDetails` path)                     | `EvaluationDetails<dynamic>`                      |
| `onError`         | an SDK error occurs (failed fetch / error path)                                                       | `String message`, optional `error` + `StackTrace` |

Every event fires **all** registered listeners; a throwing listener is
isolated and never breaks a sibling listener or the client. `close()`
clears all listeners (mirrors upstream's `hooks.clear()`).

## Config cache

The default cache is `FileSystemCache`, which persists the latest
`config_v6.json` body + ETag at `$XDG_CACHE_HOME/confeature/` (Linux /
macOS) or `$HOME/.cache/confeature/`. On Flutter Web (no filesystem) or
in tests, inject `InMemoryCache` or your own implementation:

```dart
import 'package:confeature/confeature.dart';

class MyFlutterCache extends ConfigCache {
  // Wrap path_provider's getApplicationDocumentsDirectory() here.
  @override
  CacheEntry? read() => /* … */;
  @override
  void write(CacheEntry entry) => /* … */;
}

final client = ConfeatureClient.get(
  'sdk-key',
  cache: MyFlutterCache(),
);
```

## ConfigCat parity

The public surface is built to drop in as `configcat_client`. The
parity test suite at
[`apps/sdk-dart/test/parity_corpus_test.dart`](./test/parity_corpus_test.dart)
runs the same 58-tuple corpus as every other Confeature SDK; all SDKs
MUST produce byte-identical outputs for every entry (Constitution
Principle II NON-NEGOTIABLE).

For the full matrix of what's at parity vs in flight, see the
[migrate-from-configcat](https://confeature.io/migrate-from-configcat/)
documentation.

## Development

```sh
cd apps/sdk-dart
dart pub get
dart analyze --fatal-infos     # spec 049 FR-017
dart test                      # 130/130 PASS
dart test --coverage=coverage  # ≥ 80% lcov floor
dart pub publish --dry-run     # exit 0
```

The root `pnpm ready` script chains `dart:ready` at the tail of the
SDK-fleet sweep.

## Source

- Source: [`apps/sdk-dart/`](https://github.com/confeature/sdks/tree/main/apps/sdk-dart)
- Issue tracker: <https://github.com/confeature/sdks/issues>

## License

MIT. See [LICENSE](./LICENSE).
