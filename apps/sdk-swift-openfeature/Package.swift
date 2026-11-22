// swift-tools-version: 6.1
// SPDX-License-Identifier: MIT

import PackageDescription

let package = Package(
    name: "ConfeatureOpenFeature",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8)],
    products: [.library(name: "ConfeatureOpenFeature", targets: ["ConfeatureOpenFeature"])],
    dependencies: [
        .package(path: "../sdk-swift"),
        .package(url: "https://github.com/open-feature/swift-sdk.git", exact: "0.7.0"),
    ],
    targets: [
        .target(
            name: "ConfeatureOpenFeature",
            dependencies: [
                .product(name: "Confeature", package: "sdk-swift"),
                .product(name: "OpenFeature", package: "swift-sdk"),
            ]),
        .testTarget(
            name: "ConfeatureOpenFeatureTests",
            dependencies: ["ConfeatureOpenFeature"]),
    ],
    swiftLanguageModes: [.v5]
)
