#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# check-on-main.sh — refuse a CLI tag whose commit is not on main.
#
# Who may push a `cli-v*` tag is the release-tag ruleset's decision, and who
# may reach the R2 token is the `cli-release` environment's; this adds that a
# tag on a commit that is not on main publishes nothing. cli-release.yml runs
# it as the first step after the checkout of build, release and upload
# (round 10: one guard in the read-only build job was held by no rule, and the
# two jobs holding a token did not re-check it). Each of those checkouts has
# fetch-depth 0, so refs/remotes/origin/main and its ancestry are present and
# no `git fetch` (and no credential) is needed.
#
#   bash apps/cli/scripts/check-on-main.sh
#
# Environment: GITHUB_SHA, GITHUB_REF_NAME (runner defaults).
set -euo pipefail

# No global or system git configuration reaches this check.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

sha="${GITHUB_SHA:?check-on-main.sh: GITHUB_SHA is not set}"
if ! git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
  echo "::error::check-on-main.sh: no refs/remotes/origin/main (the checkout needs fetch-depth: 0)" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$sha" refs/remotes/origin/main; then
  echo "::error::${GITHUB_REF_NAME:-the tag} points at a commit that is not on main — nothing is published" >&2
  exit 1
fi
echo "on main: $sha"
