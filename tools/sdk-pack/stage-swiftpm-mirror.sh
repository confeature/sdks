#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

# Verify the split and stage its root package for the consumer build.
set -euo pipefail

[ "$UNIT_COORDINATES" = "https://github.com/$MIRROR_REPOSITORY" ] ||
  { echo "::error::the unit's coordinates ${UNIT_COORDINATES} are not its mirror ${MIRROR_REPOSITORY}" >&2; exit 1; }
file="$RUNNER_TEMP/release/mirror.bundle"
split="$(tail -n 1 "$RUNNER_TEMP/split.out")"
head="$(git bundle list-heads "$file" refs/heads/main | cut -d' ' -f1)"
[ -n "$split" ] && [ "$split" = "$head" ] ||
  { echo "::error::the bundle's main is ${head}, the split printed ${split}" >&2; exit 1; }
git clone --quiet --branch main "$file" "$RUNNER_TEMP/consume/${MIRROR_REPOSITORY#*/}"
[ -f "$RUNNER_TEMP/consume/${MIRROR_REPOSITORY#*/}/Package.swift" ] ||
  { echo "::error::the mirror has no Package.swift at its root" >&2; exit 1; }
shasum -a 256 -- "$file" | cut -d' ' -f1
