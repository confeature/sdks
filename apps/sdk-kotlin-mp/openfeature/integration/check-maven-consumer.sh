#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

cd "$(dirname "$0")/.."
target="${1:?Supply an Android or Apple consumer target}"
gradle=(--no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process)
case "$target" in
  android)
    variant=AndroidRelease
    target_args=(-PenableAndroid=true)
    consumer_task=:android:assembleRelease
    ;;
  apple)
    variant=IosArm64
    target_args=(-PenableAndroid=false)
    consumer_task=:apple:linkDebugExecutableIosArm64
    ;;
  *) echo "Unknown consumer target: $target" >&2; exit 1 ;;
esac

# Use standalone Gradle builds: the consumer can only resolve the published artifacts.
sh ./gradlew "${gradle[@]}" "${target_args[@]}" \
  publishKotlinMultiplatformPublicationToReleaseRepository \
  "publish${variant}PublicationToReleaseRepository"
sh ./gradlew "${gradle[@]}" --project-dir integration/consumer \
  "-PconsumerTarget=$target" "-PreleaseRepo=$PWD/build/release-repo" "$consumer_task"

if [[ "$target" == android ]]; then
  artifact=confeature-openfeature-kotlin-android
  aar="build/release-repo/io/confeature/$artifact/0.1.0/$artifact-0.1.0.aar"
  unzip -p "$aar" AndroidManifest.xml | grep -E 'android:minSdkVersion="21"([[:space:]]|/|>)'
  apk=integration/consumer/android/build/outputs/apk/release/android-release-unsigned.apk
  badging=$("${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/34.0.0/aapt2" dump badging "$apk")
  grep -Fx "sdkVersion:'21'" <<< "$badging"
else
  executable=integration/consumer/apple/build/bin/iosArm64/debugExecutable/apple.kexe
  xcrun lipo -verify_arch arm64 "$executable"
fi
printf 'Verified Kotlin Maven consumer: %s\n' "$target"
