#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# dagger-precheck.sh — shared precondition gate for the `pnpm dagger:*`
# script family (root package.json). Verifies the host-side prerequisites
# the Dagger Engine cannot introspect on its own:
#
#   1. No `_EXPERIMENTAL_DAGGER_RUNNER_HOST`: it points the CLI at an engine
#      whose version this check cannot see.
#   2. `dagger` CLI on PATH (the binary that talks to the Engine).
#   3. That CLI is exactly `engineVersion` from dagger/dagger.json, the one
#      home of the version (#865). The CLI starts an engine of its own
#      version, so a drifted CLI runs every gate on an engine the repository
#      never pinned.
#   4. A reachable Docker daemon (the Engine runs as a Docker container).
#
# Every failure exits non-zero with an actionable hint, which `git push`
# honours as "abort". Extracted in spec 053 Phase 4 (#203) from six
# duplicated inline `sh -eu -c` pipelines — DRY Phase-3 LOW refactor.
# Tested against a stub `dagger` in tools/dagger-call/dagger-precheck.test.mjs.
#
# Contract: callers (the `dagger:*` scripts) invoke this as
#   `bash scripts/dagger-precheck.sh && bash tools/dagger-call/dagger-call.sh <fn>`
# i.e. the helper is silent on success and noisy on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "[dagger-precheck] FAIL: $*" >&2
  exit 1
}

[ -z "${_EXPERIMENTAL_DAGGER_RUNNER_HOST:-}" ] ||
  fail "_EXPERIMENTAL_DAGGER_RUNNER_HOST is set; its engine version cannot be checked against dagger/dagger.json — unset it"

# The version lives in dagger/dagger.json only; read it, never restate it.
# node's own reason (a parse error, a missing file) goes to stderr as is.
want="$(node -e '
  let v;
  try {
    v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).engineVersion;
  } catch (e) {
    console.error("[dagger-precheck] " + e.message);
    process.exit(1);
  }
  if (typeof v !== "string" || !/^v\d+\.\d+\.\d+$/.test(v)) {
    console.error("[dagger-precheck] engineVersion is " + JSON.stringify(v));
    process.exit(1);
  }
  process.stdout.write(v);
' "$ROOT/dagger/dagger.json")" ||
  fail "dagger/dagger.json has no engineVersion of the form vMAJOR.MINOR.PATCH"

# Matches the contributing guide and dagger/README.md; $HOME stays literal to paste.
# shellcheck disable=SC2016
hint='install it: curl -fsSL https://dl.dagger.io/dagger/install.sh | DAGGER_VERSION='"$want"' BIN_DIR="$HOME/.local/bin" sh, then put $HOME/.local/bin first on PATH'

command -v dagger >/dev/null 2>&1 || fail "dagger CLI not on PATH — $hint"

out="$(dagger version 2>/dev/null)" || fail "\`dagger version\` failed — $hint"
# Field 2 of `dagger vX.Y.Z (image…) os/arch`. -s: cut passes a line with no
# space through whole, so without it a bare `vX.Y.Z` line would count as field 2.
got="$(printf '%s\n' "$out" | head -n 1 | cut -s -d ' ' -f 2)"
[ "$got" = "$want" ] ||
  fail "dagger CLI is '${got}', dagger/dagger.json pins $want — $hint"

docker info >/dev/null 2>&1 || {
  echo "[dagger-precheck] FAIL: docker daemon not responding — start Docker Desktop and retry, or 'git push --no-verify' to bypass" >&2
  exit 1
}
