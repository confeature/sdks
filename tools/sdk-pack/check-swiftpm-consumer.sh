#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

# Build a scratch package importing the same product a user installs.
set -euo pipefail

mirror="${MIRROR_REPOSITORY#*/}"
case "${1:-}" in
  "")
    platform=v10_15
    product=Confeature
    symbol=ConfeatureClient
    swift_cmd=(swift)
    ;;
  openfeature)
    platform=v12
    product=ConfeatureOpenFeature
    symbol=ConfeatureProvider
    swift_cmd=(xcrun swift)
    ;;
  *) echo "usage: $0 [openfeature]" >&2; exit 2 ;;
esac
mkdir -p "$RUNNER_TEMP/consume/consumer/Sources/Consumer"
cd "$RUNNER_TEMP/consume/consumer"
cat > Package.swift <<SWIFT
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Consumer",
    platforms: [.macOS(.${platform})],
    dependencies: [.package(path: "../${mirror}")],
    targets: [
        .executableTarget(
            name: "Consumer",
            dependencies: [.product(name: "${product}", package: "${mirror}")]
        )
    ]
)
SWIFT
printf 'import %s\n\nprint(String(describing: %s.self))\n' "$product" "$symbol" > Sources/Consumer/main.swift
{ echo "### Mirror dry run"; "${swift_cmd[@]}" --version 2>&1; } >> "$GITHUB_STEP_SUMMARY"
"${swift_cmd[@]}" package resolve
if [ "$product" = Confeature ]; then
  "${swift_cmd[@]}" build
fi
