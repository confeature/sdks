#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

set -euo pipefail

swift_cmd=("$@")
root="$(cd "$(dirname "$0")/.." && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
base="$temp/confeature-swift"
companion="$temp/companion"
mkdir -p "$base" "$companion"
cp -R "$root/apps/sdk-swift/"{Package.swift,Sources,Tests} "$base"
cp -R "$root/apps/sdk-swift-openfeature/"{Package.swift,Sources,Tests} "$companion"

# Exercise the published manifest's actual version requirement against the
# base sources under review, even before the first real 0.2.0 tag exists.
git -C "$base" init --quiet --template=
git -C "$base" add --force Package.swift Sources
git -C "$base" -c commit.gpgsign=false -c core.hooksPath=/dev/null \
  -c user.name=Confeature -c user.email=noreply@github.com commit --quiet -m 'Local Swift SDK fixture'
git -C "$base" -c tag.gpgSign=false tag 0.2.0
cd "$companion"
"${swift_cmd[@]}" package config set-mirror \
  --original https://github.com/confeature/confeature-swift.git --mirror "file://$base"
"${swift_cmd[@]}" test

# An ordinary host build does not exercise the older deployment targets,
# especially the 32-bit watchOS target.
for settings in macosx:arm64-apple-macosx12.0 iphoneos:arm64-apple-ios15.0 \
  appletvos:arm64-apple-tvos15.0 watchos:arm64_32-apple-watchos8.0; do
  sdk="${settings%%:*}"
  triple="${settings#*:}"
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  "${swift_cmd[@]}" build --build-system native --scratch-path "$temp/build-$sdk" \
    --sdk "$sdk_path" --triple "$triple" --target ConfeatureOpenFeature
done

# The hosted job builds its seeded harness after this suite. Preserve the
# exact package that was compiled so the live step can use --skip-build.
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'SWIFT_OPENFEATURE_PACKAGE_PATH=%s\n' "$companion" >> "$GITHUB_ENV"
  trap - EXIT
fi
