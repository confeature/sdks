#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# One unit's history, split out for its public mirror, or refused.
#
#   bash tools/sdk-pack/split-mirror.sh apps/sdk-php "$RUNNER_TEMP/release/mirror.bundle"
#
# Two registries take a whole git repository, not an archive: Packagist reads
# composer.json and SwiftPM reads Package.swift at the ROOT of a repository, and
# both SDKs live under apps/ here. So each is published as a mirror repository
# (confeature/confeature-php-sdk, confeature/confeature-swift) whose `main` is
# this script's split of the unit's directory, and whose tags are its releases.
# `sdk-publish.yml`'s pack jobs run it; their publish jobs push what it bundled.
#
# A mirror republishes every commit that touched the unit, with its author,
# committer and message, and a pushed history cannot be taken back. So the
# split is REFUSED (plan FR-010: no personal data reaches a public mirror)
# unless, for every commit in it:
#   - the author and committer addresses are GitHub noreply addresses:
#     `<id>+<login>@users.noreply.github.com`, or `noreply@github.com`;
#   - every address in the message (a Co-Authored-By trailer, a "reported by")
#     is a noreply one: `…@users.noreply.github.com`, `noreply@github.com`,
#     `noreply@anthropic.com`.
# A refusal names the split commit and the field, never the address: the log of
# a public run is public too. Its bound: an address is `local@domain.tld`, so a
# TLD-less one (`me@laptop`) in a message is not seen; authors and committers
# are matched whole, so there it cannot hide.
#
# The split is `git subtree split`: every commit keeps its author, committer,
# dates and message, so the same history always splits to the same commit, and
# a mirror only ever fast-forwards from one release to the next. A shallow
# clone would split to another commit, so it is refused.
#
# Output: the bundle at <out.bundle>, carrying the split as `refs/heads/main`,
# and the split commit's sha as the last line on stdout.
# Exit codes: 0 split and bundled, 1 refused (personal data, or nothing to
# split), 2 usage error or a repository it cannot split.
#
# Zero dependencies beyond git and bash.

set -euo pipefail

usage() {
  echo "usage: split-mirror.sh <unit-path> <out.bundle>" >&2
  exit 2
}
refuse() {
  echo "refused: $*" >&2
  exit 1
}
broken() {
  echo "split-mirror: $*" >&2
  exit 2
}

[ "$#" -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || usage
prefix="${1%/}"
case "/$prefix/" in
  //* | */../* | */./* | /-*) usage ;;
esac
out="$2"
case "$out" in
  /*) ;;
  *) out="$PWD/$out" ;;
esac

top="$(git rev-parse --show-toplevel 2>/dev/null)" || broken "not inside a git work tree"
cd "$top"
[ "$(git rev-parse --is-shallow-repository)" = false ] ||
  broken "a shallow clone splits to another commit: check out the whole history (fetch-depth: 0)"
# A directory at HEAD has history; anything else (absent, deleted, a file) has none to split.
[ "$(git cat-file -t "HEAD:$prefix" 2>/dev/null)" = tree ] ||
  refuse "$prefix is not a directory at HEAD: no history to split"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

split="$(git subtree split --quiet --prefix="$prefix" HEAD 2>"$tmp/subtree.err")" ||
  broken "git subtree split failed: $(cat "$tmp/subtree.err")"
[[ $split =~ ^[0-9a-f]{40}$ ]] || refuse "the split of $prefix is empty"

# Authors and committers, matched whole.
IDENTITY='^([0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com|noreply@github\.com)$'
# Anything address-shaped in a message, and the addresses allowed there.
ADDRESS='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
TRAILER='^([A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com|noreply@anthropic\.com)$'

problems=0
git log --format='%H%x09%ae%x09%ce' "$split" >"$tmp/identities"
while IFS=$'\t' read -r commit author committer; do
  if ! [[ $author =~ $IDENTITY ]]; then
    echo "  commit $commit: the author address is not a GitHub noreply address" >&2
    problems=$((problems + 1))
  fi
  if ! [[ $committer =~ $IDENTITY ]]; then
    echo "  commit $commit: the committer address is not a GitHub noreply address" >&2
    problems=$((problems + 1))
  fi
done <"$tmp/identities"

git log -z --format='%H%n%B' "$split" >"$tmp/messages"
while IFS= read -r -d '' entry; do
  commit="${entry%%$'\n'*}"
  rest="${entry#*$'\n'}"
  while [[ $rest =~ $ADDRESS ]]; do
    found="${BASH_REMATCH[0]}"
    if ! [[ $found =~ $TRAILER ]]; then
      echo "  commit $commit: its message carries an address that is not a noreply one" >&2
      problems=$((problems + 1))
    fi
    rest="${rest#*"$found"}"
  done
done <"$tmp/messages"

[ "$problems" -eq 0 ] ||
  refuse "$problems personal address(es) in the split of $prefix (above, by split commit): rewrite them, or the mirror publishes them"

# The bundle carries the split, and only the split, as `main`. It is built in a
# scratch repository so this one gains no ref; no hook of this one runs.
git init --quiet --bare --initial-branch=main "$tmp/mirror.git"
git -c core.hooksPath=/dev/null push --quiet --no-verify "$tmp/mirror.git" "$split:refs/heads/main"
mkdir -p "$(dirname "$out")"
git -C "$tmp/mirror.git" bundle create --quiet "$tmp/split.bundle" refs/heads/main
# `verify` reports "is okay" even when quiet; its words are shown only on failure.
git -C "$tmp/mirror.git" bundle verify --quiet "$tmp/split.bundle" >"$tmp/verify.out" 2>&1 ||
  broken "the bundle of $split does not verify: $(cat "$tmp/verify.out")"
mv "$tmp/split.bundle" "$out"
echo "$split"
