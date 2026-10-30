#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# A Hex package is the unit the resolver accepted, or it is refused (#909).
#
#   bash tools/sdk-pack/check-hex-tarball.sh <file.tar> <name> <version>
#
# sdk-publish.yml's pack-hex runs it on what `mix hex.build` wrote, before the
# digest is taken. A Hex package (hex_core's tarball format 3) is an outer,
# uncompressed tar of exactly VERSION, CHECKSUM, metadata.config and
# contents.tar.gz. Refused unless:
#   - the file is named <name>-<version>.tar;
#   - the outer tar holds those four entries and nothing else;
#   - VERSION is `3`;
#   - metadata.config declares the name, the app and the version, each exactly
#     once, as hex_tarball writes them: `{<<"name">>,<<"<name>">>}.`.
# Exit codes: 0 accepted, 1 refused, 2 usage error or unreadable input.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: check-hex-tarball.sh <file.tar> <name> <version>" >&2
  exit 2
fi
file="$1"
name="$2"
version="$3"

refuse() {
  echo "::error::the Hex package ${file##*/} $1" >&2
  exit 1
}

[ -f "$file" ] || { echo "check-hex-tarball: cannot read ${file}" >&2; exit 2; }
[ "${file##*/}" = "${name}-${version}.tar" ] || refuse "is not named ${name}-${version}.tar"

entries="$(tar -tf "$file" | LC_ALL=C sort | tr '\n' ' ')" || refuse "is not a tar archive"
[ "$entries" = "CHECKSUM VERSION contents.tar.gz metadata.config " ] ||
  refuse "holds ${entries}, not exactly VERSION, CHECKSUM, metadata.config and contents.tar.gz"

[ "$(tar -xOf "$file" VERSION)" = "3" ] || refuse "is not tarball format 3"

metadata="$(tar -xOf "$file" metadata.config)"
for key in name app version; do
  want="$name"
  [ "$key" = "version" ] && want="$version"
  line="{<<\"${key}\">>,<<\"${want}\">>}."
  count="$(printf '%s\n' "$metadata" | grep -cFx -- "$line" || true)"
  [ "$count" = "1" ] || refuse "does not declare ${key} ${want} exactly once"
  # A top-level entry starts its line; a requirement's own name is indented.
  any="$(printf '%s\n' "$metadata" | grep -c -- "^{<<\"${key}\">>," || true)"
  [ "$any" = "1" ] || refuse "declares ${key} more than once"
done

echo "the Hex package is ${name} ${version}"
