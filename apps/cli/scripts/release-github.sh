#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# release-github.sh — the GitHub release of a CLI tag, a mirror of what
# https://cli.confeature.io serves (never the documented install path).
# cli-release.yml's `release` job runs it, the one job that holds a
# `contents: write` token, as that job's exact recorded exception
# (tools/repo-gates/verify-workflows.mjs, PUBLISH_EXCEPTIONS): its logic is
# outside the strict grammar a credentialed run block is held to (round 9).
#
#   bash apps/cli/scripts/release-github.sh "$TAG" dist
#
# <dist> is the build job's artifact, already checked against the build job's
# SHA256SUMS digest by the step before. In order:
#   1. creates the release from the tag (--verify-tag) when it does not exist;
#   2. uploads every binary and SHA256SUMS only when the release has no asset
#      yet: never --clobber, so a re-run cannot replace the GitHub copy with
#      bytes other than those R2 serves.
#
# Environment: GH_TOKEN (the job's token, read by gh only).
set -euo pipefail

tag="${1:?usage: release-github.sh <cli-vX.Y.Z> <dist-dir>}"
dist="${2:?usage: release-github.sh <cli-vX.Y.Z> <dist-dir>}"
case "$tag" in
  cli-v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "::error::release-github.sh: $tag is not a cli-vX.Y.Z tag" >&2; exit 2 ;;
esac
[ -f "$dist/SHA256SUMS" ] || { echo "::error::release-github.sh: no $dist/SHA256SUMS" >&2; exit 2; }

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --title "Confeature CLI ${tag#cli-v}" --generate-notes --verify-tag
fi

present="$(gh release view "$tag" --json assets --jq '.assets | length')"
if [ "$present" -gt 0 ]; then
  echo "GitHub release already carries $present assets — not replacing them"
  exit 0
fi
shopt -s nullglob
assets=("$dist"/confeature-*)
[ "${#assets[@]}" -gt 0 ] || { echo "::error::release-github.sh: no binaries in $dist" >&2; exit 1; }
gh release upload "$tag" "${assets[@]}" "$dist/SHA256SUMS"
