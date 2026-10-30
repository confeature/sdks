#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# swift-precheck.sh — the Swift SDK's gate, run natively on macOS: by the
# pre-push hook (`pnpm swift:check`) and by sdk-gates.yml's swift job.
#
# The Swift/Xcode toolchain is macOS-only, so apps/sdk-swift cannot run in the
# Dagger Linux pipeline and is not part of `prepush-all`.
#
# The Xcode the Swift SDK is judged with is pinned here and nowhere else
# (XCODE_PIN). Bumping it is a one-line edit of XCODE_PIN; the path is derived
# from it. No workflow selects Xcode.
#
# CI mode is CI non-empty, or GITHUB_ACTIONS=true. In CI mode the pin is the
# judge, and anything else is a red gate (exit 1): the pinned Xcode not
# installed, a preset DEVELOPER_DIR that is another Xcode, TOOLCHAINS set,
# swift resolving outside the pinned Xcode, `xcodebuild -version` naming
# another version, or GITHUB_ACTIONS=true without GITHUB_ENV. The selection is
# exported, and appended to GITHUB_ENV when there is one, so the job's later
# steps run on the same Xcode. The suite then runs `xcrun swift`, so the swift
# that builds and tests is the pinned Xcode's, whatever else is first on PATH.
#
# Locally the pin is used when it is installed. Otherwise a loud WARN names the
# pin and the Xcode in use, and the gate goes on: CI is the judge of the pin.
# An explicit DEVELOPER_DIR wins, with one note line. The suite runs the swift
# on PATH (a non-macOS box has no xcrun).
#
# Behaviour:
#   - swift absent: in CI mode, exit 1 (the gate is red); on a local non-macOS
#     dev box, loud WARN and exit 0 (skip). Linux/Windows Swift support is
#     best-effort and ungated (see Package.swift).
#   - swift present → the Xcode selection above, then build + test
#     (+ swift-format lint). Any failure exits non-zero, which `git push`
#     honours as "abort".
set -euo pipefail

XCODE_PIN=16.4
XCODE_DEV="/Applications/Xcode_${XCODE_PIN}.app/Contents/Developer"

say() { echo "[swift-precheck] $*" >&2; }
fail() {
  say "ERROR: $*"
  exit 1
}

if ! [[ "$XCODE_PIN" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  fail "XCODE_PIN '${XCODE_PIN}' is not a version (<major>[.<minor>…])."
fi

ci_mode=false
if [ -n "${CI:-}" ] || [ "${GITHUB_ACTIONS:-}" = true ]; then
  ci_mode=true
fi
# The swift the suite runs: the one on PATH, until CI mode has checked the pin.
swift_cmd=(swift)

# In CI mode a missing tool is a red gate, never a skip: a skip there would
# report Swift green having run nothing. Only a local non-macOS machine may
# skip, loudly.
if ! command -v swift >/dev/null 2>&1; then
  if [ "$ci_mode" = true ]; then
    fail "swift is not on PATH under CI — the Swift gate cannot run."
  fi
  say "WARN: swift not on PATH — skipping the Swift SDK gate."
  say "WARN: apps/sdk-swift is verified ONLY on macOS; this push proceeds untested for Swift."
  exit 0
fi

# Selects the pinned Xcode for this process and, through GITHUB_ENV, for the
# job's later steps. The line is built from XCODE_DEV, never from the
# environment.
select_pin() {
  export DEVELOPER_DIR="$XCODE_DEV"
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'DEVELOPER_DIR=%s\n' "$XCODE_DEV" >>"$GITHUB_ENV"
  fi
}

if [ "$ci_mode" = true ]; then
  [ -d "$XCODE_DEV" ] || fail "Xcode ${XCODE_PIN} is not installed at ${XCODE_DEV}."
  if [ -n "${DEVELOPER_DIR:-}" ] && [ "$DEVELOPER_DIR" != "$XCODE_DEV" ]; then
    fail "DEVELOPER_DIR is preset to ${DEVELOPER_DIR}, not the pinned Xcode ${XCODE_PIN} (${XCODE_DEV})."
  fi
  if [ -n "${TOOLCHAINS+set}" ]; then
    fail "TOOLCHAINS is set (${TOOLCHAINS}); Swift is judged with the pinned Xcode ${XCODE_PIN}'s own toolchain."
  fi
  export DEVELOPER_DIR="$XCODE_DEV"
  found="$(xcrun --find swift)" || fail "xcrun cannot find swift in the pinned Xcode ${XCODE_PIN}."
  case "$found" in
    "$XCODE_DEV"/*) ;;
    *) fail "swift resolves to ${found}, outside the pinned Xcode ${XCODE_PIN} (${XCODE_DEV})." ;;
  esac
  version="$(xcodebuild -version)" || fail "xcodebuild -version failed for the pinned Xcode ${XCODE_PIN}."
  version="${version%%$'\n'*}"
  if [ "$version" != "Xcode ${XCODE_PIN}" ]; then
    fail "${XCODE_DEV} is ${version}, not the pinned Xcode ${XCODE_PIN}."
  fi
  if [ "${GITHUB_ACTIONS:-}" = true ] && [ -z "${GITHUB_ENV:-}" ]; then
    fail "GITHUB_ENV is unset: the job's later steps would not run on the pinned Xcode ${XCODE_PIN}."
  fi
  select_pin
  swift_cmd=(xcrun swift)
elif [ -n "${DEVELOPER_DIR:-}" ]; then
  say "note: DEVELOPER_DIR is set (${DEVELOPER_DIR}); using it, not the pinned Xcode ${XCODE_PIN}."
elif [ -d "$XCODE_DEV" ]; then
  select_pin
else
  in_use="$(xcodebuild -version 2>/dev/null)" || in_use="an unknown Xcode"
  in_use="${in_use%%$'\n'*}"
  say "WARN: the pinned Xcode ${XCODE_PIN} is not installed at ${XCODE_DEV}."
  say "WARN: judging Swift with ${in_use} instead; CI judges it with Xcode ${XCODE_PIN}."
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/sdk-swift"

echo "[swift-precheck] swift build…"
"${swift_cmd[@]}" build
echo "[swift-precheck] swift test…"
"${swift_cmd[@]}" test
# swift-format: the standalone binary, or the `swift format` subcommand the
# Swift 6 toolchain (Xcode 16) ships.
if command -v swift-format >/dev/null 2>&1; then
  echo "[swift-precheck] swift-format lint…"
  swift-format lint --strict --recursive Sources Tests
elif "${swift_cmd[@]}" format --version >/dev/null 2>&1; then
  echo "[swift-precheck] swift format lint…"
  "${swift_cmd[@]}" format lint --strict --recursive Sources Tests
elif [ "$ci_mode" = true ]; then
  fail "no swift-format under CI — the format lint cannot run."
else
  say "WARN: swift-format not on PATH — skipping format lint (brew install swift-format)."
fi
echo "[swift-precheck] OK"
