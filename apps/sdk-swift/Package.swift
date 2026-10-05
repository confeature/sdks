// swift-tools-version: 5.9
// SPDX-License-Identifier: MIT
//
// SwiftPM manifest for the Confeature Swift SDK. Module name
// `Confeature` mirrors the upstream `ConfigCat` Swift SDK so a customer
// migrating from ConfigCat changes a single dependency line in their
// own `Package.swift` plus their `import ConfigCat` → `import Confeature`
// statements (constitution Principle II — NON-NEGOTIABLE).
//
// Deployment targets match `ConfigCat-iOS`'s public matrix; CryptoKit
// is available on every Apple platform listed. Linux/Windows support is
// best-effort and is not gated on CI for the v0.1 wave.

import PackageDescription

let package = Package(
    name: "Confeature",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15),
        .tvOS(.v13),
        .watchOS(.v6),
    ],
    products: [
        .library(
            name: "Confeature",
            targets: ["Confeature"]
        )
    ],
    dependencies: [
        // Test-target ONLY — pinned for the FULL-surface EQUALITY
        // conformance test (spec 073, FR-024). The production
        // `Confeature` target has no external dependency.
        .package(
            url: "https://github.com/configcat/swift-sdk.git",
            exact: "11.3.1"
        )
    ],
    targets: [
        .target(
            name: "Confeature",
            path: "Sources/Confeature"
        ),
        .testTarget(
            name: "ConfeatureTests",
            dependencies: [
                "Confeature",
                .product(name: "ConfigCat", package: "swift-sdk"),
            ],
            path: "Tests/ConfeatureTests",
            resources: []
        ),
    ]
)
