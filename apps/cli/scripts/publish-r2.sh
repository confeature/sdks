#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# publish-r2.sh — the ONLY writer of CLI releases on https://cli.confeature.io
# (Cloudflare R2, #801). Used by .github/workflows/cli-release.yml and by the
# one-off backfill in apps/cli/RELEASES-R2.md. Nothing else puts objects in the
# bucket: a hand-run `wrangler r2 object put latest` is the drift this exists
# to prevent.
#
#   publish-r2.sh upload   <X.Y.Z> <dist-dir>  binaries + SHA256SUMS → v<X.Y.Z>/
#   publish-r2.sh promote  <X.Y.Z>             root scripts, then `latest` — forward only
#   publish-r2.sh rollback <X.Y.Z>             the same, to an OLDER version, on purpose
#
# The layout is a permanent contract — every root script ever served installs
# pinned versions from it:
#   v<ver>/<asset>, v<ver>/SHA256SUMS   immutable (and bucket-locked on `v`)
#   install.sh, install.ps1             from THIS checkout, never from a release
#   latest                              exactly `X.Y.Z`, written LAST
#
# `promote` never moves `latest` backwards: two releases racing, or a re-run of
# an old tag, would otherwise send every user an older CLI. Going back is
# `rollback`, an explicit act.
#
# Environment:
#   CLI_R2_BUCKET   bucket name             (default confeature-cli-releases)
#   CLI_BASE_URL    public host, for checks (default: install.sh's BASE_URL — the one home)
#   WRANGLER        wrangler command        (default: the workspace's, from the lockfile;
#                   the live-contract harness carries it, a package that ships
#                   with the CLI, #858)
set -euo pipefail

# The repository root, from this file's location — no git needed (the Dagger
# cliTest image has none).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BUCKET="${CLI_R2_BUCKET:-confeature-cli-releases}"
# The host is decided once, in install.sh; this reads it rather than spelling it.
BASE_URL="${CLI_BASE_URL:-$(sed -n 's/^BASE_URL="\(.*\)"$/\1/p' "$ROOT/apps/cli/install.sh")}"
[ -n "$BASE_URL" ] || { echo "publish-r2: no BASE_URL in apps/cli/install.sh" >&2; exit 1; }
# Word-split on purpose: a command plus its arguments. Never `npx …@latest`.
read -r -a WRANGLER_CMD <<<"${WRANGLER:-pnpm --dir $ROOT/tools/test-harness-live-contract exec wrangler}"

IMMUTABLE="public, max-age=31536000, immutable"
MUTABLE="no-cache"

die() {
  echo "publish-r2: $1" >&2
  exit "${2:-1}"
}

usage() {
  echo "usage: publish-r2.sh upload <X.Y.Z> <dist-dir> | promote <X.Y.Z> | rollback <X.Y.Z>" >&2
  exit 2
}

# The same whole-string X.Y.Z check as install.sh — what `latest` may hold.
is_version() {
  case "$1" in
    "" | *[!0123456789.]* | .* | *. | *..*) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | tr -cd '.')" = ".." ]
}

fetch() { curl --proto '=https' --tlsv1.2 -fsS "$@"; }

# HTTP status of a URL on the host: 200, 404, or anything else. Only a 404
# means "absent"; a 5xx or a network error is never read as "not published".
status_of() {
  curl --proto '=https' --tlsv1.2 -sS -o /dev/null -w '%{http_code}' -I "$1" || echo "000"
}

# 0 when $1 is a strictly newer X.Y.Z than $2.
newer() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  local i
  for i in 0 1 2; do
    ((10#${a[i]} > 10#${b[i]})) && return 0
    ((10#${a[i]} < 10#${b[i]})) && return 1
  done
  return 1
}

put() { # <key> <file> <content-type> <cache-control>
  # Absolute, always: the default wrangler runs through `pnpm --dir …`, which
  # changes directory, so a relative --file would name nothing (cli-v0.3.0's
  # first upload failed on exactly that, before any put).
  local file
  file="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")" || die "cannot resolve $2"
  "${WRANGLER_CMD[@]}" r2 object put "$BUCKET/$1" --file "$file" \
    --content-type "$3" --cache-control "$4" --remote
}

# Asset names listed in a SHA256SUMS file (second column, `*` binary marker stripped).
assets_of() { awk '{ sub(/^\*/, "", $2); print $2 }' "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

upload() {
  local version="$1" dist="$2"
  is_version "$version" || die "invalid version '$version' (expected X.Y.Z)" 2
  [ -f "$dist/SHA256SUMS" ] || die "no SHA256SUMS in $dist"
  local asset expected
  # Every listed asset must be present locally and match its sum BEFORE any put.
  while IFS= read -r asset; do
    [ -f "$dist/$asset" ] || die "SHA256SUMS lists $asset, missing from $dist"
    expected="$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n) } n == a { print $1 }' "$dist/SHA256SUMS")"
    [ "$(sha256_of "$dist/$asset")" = "$expected" ] || die "$asset does not match SHA256SUMS"
  done < <(assets_of "$dist/SHA256SUMS")

  # Resume or refuse: a published version is immutable. Byte-identical sums
  # mean a re-run of the same build — nothing to do; different sums are a
  # different build under a released number — refused (the bucket lock would
  # refuse the overwrite too; this names it first).
  local code
  code="$(status_of "$BASE_URL/v$version/SHA256SUMS")"
  case "$code" in
    200)
      if [ "$(fetch "$BASE_URL/v$version/SHA256SUMS")" = "$(cat "$dist/SHA256SUMS")" ]; then
        echo "publish-r2: v$version already published with identical SHA256SUMS — nothing to upload"
        return 0
      fi
      die "v$version is already published with DIFFERENT SHA256SUMS — a released version never changes" 3
      ;;
    404) ;;
    *) die "cannot tell whether v$version is published (HTTP $code) — refusing to guess" ;;
  esac

  # Resume a partial upload. The bucket lock refuses to re-put a locked
  # object, so an asset already there is kept — but only when its bytes are
  # this build's; anything else means the number is taken by another build.
  local present
  present="$(mktemp -d)"
  trap 'rm -rf "$present"' RETURN
  while IFS= read -r asset; do
    code="$(status_of "$BASE_URL/v$version/$asset")"
    case "$code" in
      404)
        put "v$version/$asset" "$dist/$asset" "application/octet-stream" "$IMMUTABLE"
        ;;
      200)
        fetch "$BASE_URL/v$version/$asset" -o "$present/$asset"
        [ "$(sha256_of "$present/$asset")" = "$(sha256_of "$dist/$asset")" ] ||
          die "v$version/$asset is already stored with DIFFERENT bytes — this version number is taken" 3
        echo "publish-r2: v$version/$asset already stored, identical — kept"
        ;;
      *) die "cannot tell whether v$version/$asset is stored (HTTP $code) — refusing to guess" ;;
    esac
  done < <(assets_of "$dist/SHA256SUMS")
  # The manifest last: its presence is what marks the version as published.
  put "v$version/SHA256SUMS" "$dist/SHA256SUMS" "text/plain; charset=utf-8" "$IMMUTABLE"
  echo "publish-r2: uploaded v$version"
}

promote() {
  local version="$1" mode="$2"
  is_version "$version" || die "invalid version '$version' (expected X.Y.Z)" 2
  local current
  current="$(fetch "$BASE_URL/latest" 2>/dev/null || true)"
  if is_version "$current"; then
    if [ "$mode" = forward ] && ! newer "$version" "$current" && [ "$version" != "$current" ]; then
      die "latest is $current; promoting $version would move it BACKWARDS — use 'rollback $version' if that is the intent" 4
    fi
    if [ "$mode" = back ] && ! newer "$current" "$version"; then
      die "rollback goes to an OLDER version; latest is $current" 4
    fi
  elif [ "$mode" = back ]; then
    die "no readable latest to roll back from" 4
  fi
  local sums
  sums="$(mktemp)"
  trap 'rm -f "$sums"' RETURN
  fetch "$BASE_URL/v$version/SHA256SUMS" -o "$sums" ||
    die "v$version is not published (no $BASE_URL/v$version/SHA256SUMS) — upload it first"
  # Every listed asset must be served by the host before anyone is sent to it.
  local asset
  while IFS= read -r asset; do
    fetch -I "$BASE_URL/v$version/$asset" -o /dev/null ||
      die "v$version/$asset is not served — refusing to promote"
  done < <(assets_of "$sums")

  put "install.sh" "$ROOT/apps/cli/install.sh" "text/plain; charset=utf-8" "$MUTABLE"
  put "install.ps1" "$ROOT/apps/cli/install.ps1" "text/plain; charset=utf-8" "$MUTABLE"
  local pointer
  pointer="$(mktemp)"
  printf '%s' "$version" >"$pointer"
  # `latest` LAST: until this put, every user still gets the previous version.
  put "latest" "$pointer" "text/plain; charset=utf-8" "$MUTABLE"
  rm -f "$pointer"
  echo "publish-r2: latest is now $version"
}

[ $# -ge 1 ] || usage
case "$1" in
  upload)
    [ $# -eq 3 ] || usage
    upload "$2" "$3"
    ;;
  promote)
    [ $# -eq 2 ] || usage
    promote "$2" forward
    ;;
  rollback)
    [ $# -eq 2 ] || usage
    promote "$2" back
    ;;
  *) usage ;;
esac
