<!-- SPDX-License-Identifier: MIT -->

# Confeature Swift SDK

`Confeature` is the Confeature SDK for Swift — distributed through
Swift Package Manager. The public surface mirrors
[`ConfigCat-iOS`](https://github.com/configcat/swift-sdk) 1:1 so
existing ConfigCat Swift code keeps working unchanged after a two-line
swap (a project rule, checked by its conformance tests).

|                       |                                                 |
| --------------------- | ----------------------------------------------- |
| Module                | `Confeature`                                    |
| License               | See [LICENSE](LICENSE)                          |
| Minimum tools-version | Swift 5.9                                       |
| Apple platforms       | iOS 13+, macOS 10.15+, tvOS 13+, watchOS 6+     |
| Runtime dependencies  | Foundation, URLSession, CryptoKit (stdlib only) |

## Install

Add the package to your `Package.swift`, and depend on its `Confeature` library:

```swift
dependencies: [
    .package(url: "https://github.com/confeature/confeature-swift", from: "0.1.0"),
],
targets: [
    .target(
        name: "YourApp",
        dependencies: [.product(name: "Confeature", package: "confeature-swift")]
    ),
]
```

In Xcode, use File > Add Package Dependencies… with the same URL. The repository is a read-only
mirror of `apps/sdk-swift/` in [confeature/sdks](https://github.com/confeature/sdks), where changes
are made.

## Quickstart

```swift
import Confeature

let client = ConfeatureClient.get(
    sdkKey: "configcat-sdk-1/<22-char-segment>/<22-char-segment>")

let user = User(identifier: "alice@example.com")
let enabled = await client.getValue(
    forKey: "new-checkout-flow", defaultValue: false, user: user
)

client.close()
```

## Migrating from `ConfigCat-iOS`

```diff
-import ConfigCat
+import Confeature

-let client = ConfigCatClient.get(sdkKey: "YOUR_SDK_KEY")
+let client = ConfeatureClient.get(sdkKey: "YOUR_SDK_KEY")
```

Method names, parameter labels, polling modes, and override semantics
are byte-identical to the upstream Swift SDK. The wire contract
(URLs, headers, payload shapes) is also byte-identical — point the
client at the same SDK key, change the import, and you're done.

## SDK keys

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>` (alphabet `[A-Za-z0-9_-]`), so
the same key works in a stock ConfigCat SDK pointed at Confeature.
Keys minted earlier, `confeature-sdk-1-<32 chars>-<32 chars>`, are
still accepted until rotated.

`SdkKey.isValidConfeatureKeyFormat(_:)` accepts both shapes. An
unrecognised key never throws: the client logs `INVALID_SDK_KEY` (with
the key redacted) and continues. The key is never logged raw and never
used as a cache file name (a SHA-256-derived 32-char suffix is used
instead).

## Polling modes

| Mode                                       | Default    | Notes                                                   |
| ------------------------------------------ | ---------- | ------------------------------------------------------- |
| `.autoPoll(pollInterval:maxInitWaitTime:)` | 60 s / 5 s | Background `Task` fetches on a tick.                    |
| `.lazyLoad(cacheRefreshInterval:)`         | 60 s       | Refreshes on-demand when stale.                         |
| `.manualPoll`                              | —          | No automatic fetches; call `forceRefresh()` explicitly. |

```swift
let options = ConfeatureClientOptions(
    pollingMode: .autoPoll(pollInterval: 30, maxInitWaitTime: 5)
)
let client = ConfeatureClient(sdkKey: "YOUR_SDK_KEY", options: options)
```

## Flag overrides

```swift
let overrides = FlagOverrides.localOnly(
    MapOverrideDataSource(["feature.new-checkout": true])
)
let options = ConfeatureClientOptions(flagOverrides: overrides)
let client = ConfeatureClient(sdkKey: "YOUR_SDK_KEY", options: options)
```

Override resolution follows the canonical 7-branch decision tree —
identical to every other Confeature SDK (TS / Python / Go / .NET /
Rust / Ruby / PHP / Java).

## Logging

```swift
let options = ConfeatureClientOptions(logger: OSLogger(level: .debug))
```

`Logger` is a protocol; the default implementation `OSLogger` routes
through Apple's `os_log` (compatible with iOS 13+ / macOS 10.15+).
Customers can plug their own implementation. **SDK keys are never
logged** — every log site that needs to reference a key routes
through `SdkKey.redact(_:)`.

## Cache

By default, the SDK persists the last-known `config_v6.json` to
`FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first / Confeature`.
Override via the `cacheDirectory` option (pass
`CacheDirectorySentinel.memory` for an in-memory cache — useful in
tests) or by supplying a custom `ConfigCache` implementation.

## Development

Test, lint, and coverage gates:

```bash
swift build
swift test --enable-code-coverage
swift-format lint --strict --recursive Sources Tests
```

The root `npm run swift:ready` chains all three on macOS hosts and
becomes a no-op on Linux / Windows (CI runs the same trio on a
dedicated `macos-latest` job).

The parity gate at `Tests/ConfeatureTests/ParityCorpusTests.swift`
asserts byte-identical behaviour against the canonical 58-tuple
corpus generated by `packages/test-fixtures-sdk-parity`.
`Tests/ConfeatureTests/CacheKeyFixturesTests.swift` does the same for
the cross-language cache-key fixtures. Both are NON-NEGOTIABLE.
