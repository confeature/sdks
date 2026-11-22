#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

# The pack job verifies dependencies and builds the zip as the proxy would.
grep -qxF "const Version = \"${UNIT_VERSION}\"" "$UNIT_PATH/version.go" ||
  { echo "::error::$UNIT_PATH/version.go does not declare ${UNIT_VERSION}" >&2; exit 1; }
go -C "$UNIT_PATH" mod verify >&2
mkdir -p "$RUNNER_TEMP/release"
archive="$RUNNER_TEMP/release/module.zip"
sum=$(go -C tools/sdk-pack/gozip run . -dir "$GITHUB_WORKSPACE/$UNIT_PATH" \
  -module "$UNIT_COORDINATES" -version "v${UNIT_VERSION}" -out "$archive")
[[ "$sum" =~ ^h1:[A-Za-z0-9+/]{43}=$ ]]
{
  echo "### Go module ${UNIT_COORDINATES}@v${UNIT_VERSION}"
  echo "- $(go version)"
  echo "- module zip sha256: $(sha256sum -- "$archive" | cut -d' ' -f1)"
  echo "- Go module checksum: $sum"
} >> "$GITHUB_STEP_SUMMARY"
printf '%s\n' "$sum"
