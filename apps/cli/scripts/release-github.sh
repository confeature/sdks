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
# SHA256SUMS digest by the step before. In order (round 10):
#   1. every binary in <dist> is the one SHA256SUMS names, and SHA256SUMS
#      names exactly the binaries <dist> holds;
#   2. the release is created from the tag (--verify-tag) when it does not
#      exist;
#   3. the release's assets are compared by name with the binaries and
#      SHA256SUMS: an asset it should not have fails the run; every asset it
#      already has is downloaded (to publish-tmp/) and must match SHA256SUMS
#      byte for byte; only the missing ones are uploaded. Never --clobber, so a
#      re-run completes a partial upload and never replaces the GitHub copy
#      with bytes other than those R2 serves.
#
# Exit codes: 0 done (or already complete), 1 a check failed, 2 bad usage.
# Environment: GH_TOKEN (the job's token, read by gh only).
set -euo pipefail
export LC_ALL=C

die() {
  echo "::error::release-github.sh: $2" >&2
  exit "$1"
}

tag="${1:-}"
dist="${2:-}"
[[ $tag =~ ^cli-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 2 "'$tag' is not a cli-vX.Y.Z tag"
[ -n "$dist" ] || die 2 "usage: release-github.sh <cli-vX.Y.Z> <dist-dir>"
[ -f "$dist/SHA256SUMS" ] || die 2 "no $dist/SHA256SUMS"

# 1. The build is exactly what SHA256SUMS names.
shopt -s nullglob
binaries=("$dist"/confeature-*)
[ "${#binaries[@]}" -gt 0 ] || die 1 "no binaries in $dist"
if grep -Evq '^[0-9a-f]{64}  confeature-[A-Za-z0-9._-]+$' "$dist/SHA256SUMS"; then
  die 1 "$dist/SHA256SUMS holds a line that is not '<sha256>  confeature-<name>'"
fi
(cd "$dist" && sha256sum --check --strict SHA256SUMS) || die 1 "a binary does not match SHA256SUMS"
mkdir -p publish-tmp
sed -E 's/^[0-9a-f]{64}  //' "$dist/SHA256SUMS" | sort > publish-tmp/gh-named
for f in "${binaries[@]}"; do echo "${f##*/}"; done | sort > publish-tmp/gh-built
cmp -s publish-tmp/gh-named publish-tmp/gh-built || die 1 "SHA256SUMS does not name exactly the binaries in $dist"
{ cat publish-tmp/gh-named; echo SHA256SUMS; } | sort > publish-tmp/gh-want

# 2. The release, from the tag.
if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --title "Confeature CLI ${tag#cli-v}" --generate-notes --verify-tag
fi

# 3. Its assets: none extra, every present one the build's, upload the rest.
gh release view "$tag" --json assets --jq '.assets[].name' | sort > publish-tmp/gh-have
extra="$(comm -23 publish-tmp/gh-have publish-tmp/gh-want)"
[ -z "$extra" ] || die 1 "the release carries assets this build does not: $(echo "$extra" | tr '\n' ' ')"
if [ -s publish-tmp/gh-have ]; then
  rm -rf publish-tmp/gh-assets
  mkdir -p publish-tmp/gh-assets
  gh release download "$tag" --dir publish-tmp/gh-assets
  while read -r name; do
    [ -f "publish-tmp/gh-assets/$name" ] || die 1 "the release lists $name but it did not download"
    if [ "$name" = SHA256SUMS ]; then
      cmp -s "publish-tmp/gh-assets/SHA256SUMS" "$dist/SHA256SUMS" || die 1 "the release's SHA256SUMS is not this build's"
    else
      grep -E "  ${name//./\\.}\$" "$dist/SHA256SUMS" | sed "s|  |  publish-tmp/gh-assets/|" |
        sha256sum --check --strict || die 1 "the release's $name is not this build's"
    fi
  done < publish-tmp/gh-have
fi
# The binaries first and SHA256SUMS last, so a listing that has the manifest
# has the binaries it names.
missing=()
sums_missing=no
while read -r name; do
  if [ "$name" = SHA256SUMS ]; then sums_missing=yes; else missing+=("$dist/$name"); fi
done < <(comm -13 publish-tmp/gh-have publish-tmp/gh-want)
[ "$sums_missing" = no ] || missing+=("$dist/SHA256SUMS")
if [ "${#missing[@]}" -eq 0 ]; then
  echo "the GitHub release already carries this build's $(wc -l < publish-tmp/gh-want | tr -d ' ') assets"
  exit 0
fi
gh release upload "$tag" "${missing[@]}"
