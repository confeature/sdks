<!-- SPDX-License-Identifier: MIT -->

# Confeature OpenFeature provider for Swift

Evaluate Confeature feature flags through the official OpenFeature Swift SDK.
The provider uses an existing Confeature client and its cached configuration.

## Install

Use Xcode 16.4 or later with Swift 6.1 or later. The provider supports iOS 15+,
macOS 12+, tvOS 15+, and watchOS 8+. Version 0.1.0 uses the Confeature Swift
SDK 0.2.x and OpenFeature Swift 0.7.0.

For a command-line example on macOS, save this as `Package.swift` in a new
directory. In an existing app, add the same package dependencies and products to
the target that imports them.

```swift
// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "FlagDemo",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/confeature/confeature-swift-openfeature.git", exact: "0.1.0"),
        .package(url: "https://github.com/confeature/confeature-swift.git", .upToNextMinor(from: "0.2.0")),
        .package(url: "https://github.com/open-feature/swift-sdk.git", exact: "0.7.0"),
    ],
    targets: [
        .executableTarget(
            name: "FlagDemo",
            dependencies: [
                .product(name: "ConfeatureOpenFeature", package: "confeature-swift-openfeature"),
                .product(name: "Confeature", package: "confeature-swift"),
                .product(name: "OpenFeature", package: "swift-sdk"),
            ]),
    ]
)
```

## Evaluate a flag

Save the example as `Sources/FlagDemo/main.swift`. Set `CONFEATURE_SDK_KEY` to
your config's SDK key, create a boolean flag named `new-checkout-flow` in that
config, and run `swift run FlagDemo`.

```swift
import Confeature
import ConfeatureOpenFeature
import Foundation
import OpenFeature

guard let sdkKey = ProcessInfo.processInfo.environment["CONFEATURE_SDK_KEY"],
    !sdkKey.isEmpty
else {
    fatalError("Set CONFEATURE_SDK_KEY to your Confeature SDK key.")
}

let nativeClient = ConfeatureClient(
    sdkKey: sdkKey,
    options: ConfeatureClientOptions(pollingMode: .manualPoll)
)
_ = await nativeClient.forceRefresh()

let api = OpenFeatureAPI()
await api.setProviderAndWait(
    provider: ConfeatureProvider(client: nativeClient),
    initialContext: ImmutableContext(targetingKey: "example-user")
)

let flag = api.getClient().getBooleanDetails(key: "new-checkout-flow", defaultValue: false)
print(flag.value)

await api.clearProviderAndWait()
nativeClient.close()
```

`flag.value` falls back to `false` if evaluation fails. Read `flag.errorCode`
for the OpenFeature error code or `flag.variant` for the evaluated variant when
available.

## Cache and lifecycle

Create one native client at app startup and reuse it. The provider borrows that
client. Unregister the provider with `clearProviderAndWait()` at shutdown and
close the native client when the app is done with it.

OpenFeature evaluations are synchronous and read the current cache. With
`.autoPoll`, the native client refreshes it in the background. Before your
first evaluation, call `await nativeClient.waitForReady()` to wait for
initialization. With `.manualPoll`, use `forceRefresh()` as in the example.
With `.lazyLoad`, refresh through an asynchronous native `getValue(forKey:defaultValue:)`
call or through `forceRefresh()`. If a flag requires configuration and the
cache has none, the OpenFeature client returns the supplied default and sets
the error code to `.providerNotReady`.
