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
#   - swift absent (non-macOS dev box) → loud WARN, exit 0 (skip). Linux/
#     Windows Swift support is best-effort and ungated (see Package.swift).
#   - swift present → build + test (+ swift-format lint when available).
#     Any failure exits non-zero, which `git push` honours as "abort".
#
# Contract: spec 053's pre-push-hook contract.
set -euo pipefail

if ! command -v swift >/dev/null 2>&1; then
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
if command -v swift-format >/dev/null 2>&1; then
  echo "[swift-precheck] swift-format lint…"
  swift-format lint --strict --recursive Sources Tests
else
  echo "[swift-precheck] WARN: swift-format not on PATH — skipping format lint (brew install swift-format)." >&2
fi
echo "[swift-precheck] OK"
