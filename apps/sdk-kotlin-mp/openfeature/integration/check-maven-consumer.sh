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
    ;;
  apple)
    variant=IosArm64
    target_args=(-PenableAndroid=false)
    ;;
  *) echo "Unknown consumer target: $target" >&2; exit 1 ;;
esac

# Use standalone Gradle builds: the consumer can only resolve the published artifacts.
sh ./gradlew "${gradle[@]}" "${target_args[@]}" \
  publishKotlinMultiplatformPublicationToReleaseRepository \
  "publish${variant}PublicationToReleaseRepository"
consumer=("${gradle[@]}" --project-dir integration/consumer
  "-PconsumerTarget=$target" "-PreleaseRepo=$PWD/build/release-repo")

if [[ "$target" == android ]]; then
  dex_log=$(mktemp)
  trap 'rm -f "$dex_log"' EXIT
  sh integration/consumer/gradlew "${consumer[@]}" --console=plain \
    :android:assembleRelease :android:assembleMinified 2>&1 | tee "$dex_log"
  if grep -Ei 'warning: (d8|r8):|unexpected error during rewriting of Kotlin metadata' "$dex_log"; then
    echo "Kotlin Android consumer reported a dex or shrinker warning." >&2
    exit 1
  fi
  test -s integration/consumer/android/build/outputs/mapping/minified/mapping.txt
  artifact=confeature-openfeature-kotlin-android
  aar="build/release-repo/io/confeature/$artifact/0.1.0/$artifact-0.1.0.aar"
  unzip -p "$aar" AndroidManifest.xml | grep -E 'android:minSdkVersion="21"([[:space:]]|/|>)'
  for variant in release minified; do
    apk="integration/consumer/android/build/outputs/apk/$variant/android-$variant-unsigned.apk"
    badging=$("${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/35.0.0/aapt2" dump badging "$apk")
    grep -Fx "sdkVersion:'21'" <<< "$badging"
  done
else
  sh ./gradlew "${consumer[@]}" :apple:linkDebugExecutableIosArm64
  executable=integration/consumer/apple/build/bin/iosArm64/debugExecutable/apple.kexe
  xcrun lipo -verify_arch arm64 "$executable"
fi
printf 'Verified Kotlin Maven consumer: %s\n' "$target"
