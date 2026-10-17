#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# swift-precheck.sh — native macOS Swift gate for the pre-push hook.
#
# The Swift SDK (apps/sdk-swift) cannot run inside the Dagger Linux
# pipeline (the Swift/Xcode toolchain is macOS-only), so it is NOT part
# of `prepush-all`. Phase 6 (#205) moved it OFF the macOS CI runner —
# which GitHub bills at 10x and which alone dominated per-PR billed
# minutes (10 of ~14) — onto this local gate. This is the consistent
# application of Constitution Principle VII: heavy per-SDK suites run on
# the operator's idle local machine, CI keeps only what needs the remote.
#
# Behaviour:
#   - swift absent: under CI, exit 1 (the gate is red); on a local non-macOS
#     dev box, loud WARN and exit 0 (skip). Linux/
#     Windows Swift support is best-effort and ungated (see Package.swift).
#   - swift present → build + test (+ swift-format lint when available).
#     Any failure exits non-zero, which `git push` honours as "abort".
#
# Contract: spec 053's pre-push-hook contract.
set -euo pipefail

# Under CI (sdk-gates.yml's swift job, where CI=true) a missing tool is a red
# gate, never a skip: a skip there would report Swift green having run
# nothing (#793 FR-009). Only a local non-macOS machine may skip, loudly.
if ! command -v swift >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    echo "[swift-precheck] ERROR: swift is not on PATH under CI — the Swift gate cannot run." >&2
    exit 1
  fi
  echo "[swift-precheck] WARN: swift not on PATH — skipping the Swift SDK gate." >&2
  echo "[swift-precheck] WARN: apps/sdk-swift is verified ONLY on macOS; this push proceeds untested for Swift." >&2
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/sdk-swift"

echo "[swift-precheck] swift build…"
swift build
echo "[swift-precheck] swift test…"
swift test
# swift-format: the standalone binary, or the `swift format` subcommand the
# Swift 6 toolchain (Xcode 16) ships.
if command -v swift-format >/dev/null 2>&1; then
  echo "[swift-precheck] swift-format lint…"
  swift-format lint --strict --recursive Sources Tests
elif swift format --version >/dev/null 2>&1; then
  echo "[swift-precheck] swift format lint…"
  swift format lint --strict --recursive Sources Tests
elif [ -n "${CI:-}" ]; then
  echo "[swift-precheck] ERROR: no swift-format under CI — the format lint cannot run." >&2
  exit 1
else
  echo "[swift-precheck] WARN: swift-format not on PATH — skipping format lint (brew install swift-format)." >&2
fi
echo "[swift-precheck] OK"
