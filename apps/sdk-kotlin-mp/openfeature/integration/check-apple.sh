#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

integration=$(cd "$(dirname "$0")" && pwd)
export DEVELOPER_DIR=/Applications/Xcode_26.0.1.app/Contents/Developer
xcodebuild -version | grep -Fx 'Xcode 26.0.1'
[[ "$(uname -m)" == arm64 ]]

device=$(xcrun simctl create 'Confeature Kotlin OpenFeature' \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-0)
cleanup() {
  xcrun simctl shutdown "$device" 2>/dev/null || true
  xcrun simctl delete "$device"
}
trap cleanup EXIT
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
export CONFEATURE_KOTLIN_SIMULATOR="$device"
node "$integration/run-fixture.mjs" apple
bash "$integration/check-maven-consumer.sh" apple
