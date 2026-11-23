#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

# Build a scratch package importing the same product a user installs.
set -euo pipefail

mirror="${MIRROR_REPOSITORY#*/}"
mkdir -p "$RUNNER_TEMP/consume/consumer/Sources/Consumer"
cd "$RUNNER_TEMP/consume/consumer"
cat > Package.swift <<SWIFT
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Consumer",
    platforms: [.macOS(.v10_15)],
    dependencies: [.package(path: "../${mirror}")],
    targets: [
        .executableTarget(
            name: "Consumer",
            dependencies: [.product(name: "Confeature", package: "${mirror}")]
        )
    ]
)
SWIFT
printf 'import Confeature\n\nprint(String(describing: ConfeatureClient.self))\n' > Sources/Consumer/main.swift
{ echo "### Mirror dry run"; swift --version 2>&1; } >> "$GITHUB_STEP_SUMMARY"
swift package resolve
swift build
