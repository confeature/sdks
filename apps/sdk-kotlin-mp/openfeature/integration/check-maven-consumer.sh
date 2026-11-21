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
scratch=$(mktemp -d "${TMPDIR:-/tmp}/cf-kotlin-consumer.XXXXXX")
trap 'rm -r -- "$scratch"' EXIT
release_repo="$scratch/maven"
mkdir "$release_repo"
sh ./gradlew "${gradle[@]}" "${target_args[@]}" "-PfixtureReleaseDirectory=$release_repo" \
  publishKotlinMultiplatformPublicationToReleaseRepository \
  "publish${variant}PublicationToReleaseRepository"

shopt -s nullglob
versions=("$release_repo"/io/confeature/confeature-openfeature-kotlin/*/)
if [[ ${#versions[@]} != 1 ]]; then
  echo "Expected one companion version in the fresh Maven repository." >&2
  exit 1
fi
version=$(basename "${versions[0]}")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
consumer=("${gradle[@]}" --project-dir integration/consumer
  "-PconsumerTarget=$target" "-PreleaseRepo=$release_repo" "-PreleaseVersion=$version")

if [[ "$target" == android ]]; then
  dex_log="$scratch/dex.log"
  sh integration/consumer/gradlew "${consumer[@]}" --console=plain \
    :android:assembleRelease :android:assembleMinified 2>&1 | tee "$dex_log"
  if grep -Ei 'warning: (d8|r8):|unexpected error during rewriting of Kotlin metadata' "$dex_log"; then
    echo "Kotlin Android consumer reported a dex or shrinker warning." >&2
    exit 1
  fi
  test -s integration/consumer/android/build/outputs/mapping/minified/mapping.txt
  artifact=confeature-openfeature-kotlin-android
  aar="$release_repo/io/confeature/$artifact/$version/$artifact-$version.aar"
  unzip -p "$aar" AndroidManifest.xml | grep -E 'android:minSdkVersion="21"([[:space:]]|/|>)'
  for variant in release minified; do
    apk="integration/consumer/android/build/outputs/apk/$variant/android-$variant-unsigned.apk"
    minimum=$("${ANDROID_HOME:?Set ANDROID_HOME}/cmdline-tools/latest/bin/apkanalyzer" manifest min-sdk "$apk")
    if [[ "$minimum" != 21 ]]; then
      printf 'Expected API 21 in %s, found %s\n' "$apk" "$minimum" >&2
      exit 1
    fi
    printf '%s APK minimum API %s\n' "$variant" "$minimum"
  done
else
  sh ./gradlew "${consumer[@]}" :apple:linkDebugExecutableIosArm64
  executable=integration/consumer/apple/build/bin/iosArm64/debugExecutable/apple.kexe
  # Xcode's lipo reads the remaining arguments to -verify_arch as architecture names.
  xcrun lipo "$executable" -verify_arch arm64
fi
printf 'Verified Kotlin Maven consumer: %s at %s\n' "$target" "$version"
