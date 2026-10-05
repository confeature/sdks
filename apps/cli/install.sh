#!/bin/sh
# SPDX-License-Identifier: MIT
#
# confeature CLI installer (macOS + Linux) — distribution slice #657 / spec 183.
#
# Downloads the right standalone binary for this host, verifies its SHA-256
# against the release's SHA256SUMS manifest, and installs it on PATH. Designed
# for `curl -fsSL <url>/install.sh | sh`.
#
# It is FAIL-CLOSED (FR-006): any unsupported platform, download failure,
# checksum mismatch, or unwritable install dir aborts WITHOUT installing,
# with a clear message. Transport is HTTPS-only (FR-007); no secret is
# embedded and no remote content is executed beyond the verified binary.
# Dependency-free beyond POSIX `sh`, `uname`, `curl`, `mkdir`/`mv`/`chmod`,
# and one of `shasum`/`sha256sum`.
#
# Usage:
#   curl --proto '=https' --tlsv1.2 -fsSL https://cli.confeature.io/install.sh | sh
#   ...| sh -s -- --version 0.1.0     # pin a specific release (default: latest)
#
# Releases are served from https://cli.confeature.io (Cloudflare R2, #801) —
# a permanent contract: `v<version>/<asset>` is immutable, and `latest` holds
# the current version as exactly `X.Y.Z`.

set -eu

BASE_URL="https://cli.confeature.io"
BINARY="confeature"
VERSION="" # empty => latest

abort() {
  echo "install.sh: $1" >&2
  exit 1
}

# ---- arg parsing -----------------------------------------------------------
# Only `--version X.Y.Z` is accepted; anything else aborts loudly so a typo is
# never silently ignored.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || abort "--version requires a value, e.g. --version 0.1.0"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    -h | --help)
      echo "usage: install.sh [--version X.Y.Z]"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument '$1' (only --version X.Y.Z is supported)" >&2
      exit 2
      ;;
  esac
done

# ---- the ONE version check, for --version and for the fetched `latest` -----
# A version is interpolated into the release URL; `$(…)` would be injected and
# `../` would corrupt the path. The whole value must be exactly X.Y.Z of ASCII
# digits: `case` tests the whole string (unlike a line-based grep, which a
# multi-line value can pass), and the digits are listed, not a locale-dependent
# range (#801, FR-008).
is_version() {
  case "$1" in
    "" | *[!0123456789.]* | .* | *. | *..*) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | tr -cd '.')" = ".." ]
}

if [ -n "$VERSION" ]; then
  is_version "$VERSION" || abort "invalid --version '$VERSION' (expected X.Y.Z, e.g. 0.1.0)"
fi

# ---- platform detection ----------------------------------------------------
# Map (uname -s, uname -m) to one of the five published asset names. An
# unsupported pair aborts with a manual-download pointer (FR-006 / R5).
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64 | aarch64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) return 1 ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64 | amd64) echo "x86_64-unknown-linux-gnu" ;;
        arm64 | aarch64) echo "aarch64-unknown-linux-gnu" ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

TARGET="$(detect_target)" || abort "unsupported platform '$(uname -s)/$(uname -m)'.
Windows is installed via install.ps1. For other platforms, download a binary
manually from ${BASE_URL}/v<version>/ (the current version is at ${BASE_URL}/latest)
and place it on your PATH."

ASSET="confeature-${TARGET}"

# ---- checksum tool ---------------------------------------------------------
# Prefer `shasum -a 256` (ships on macOS); fall back to `sha256sum` (Linux).
if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
else
  abort "no SHA-256 tool found (need 'shasum' or 'sha256sum')."
fi

command -v curl >/dev/null 2>&1 || abort "curl is required but was not found on PATH."

# HTTPS only, including every redirect (FR-009).
fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }

# ---- resolve the version: pinned, or the published `latest` ----------------
# No fallback: an unreadable or malformed pointer aborts rather than guessing.
if [ -z "$VERSION" ]; then
  LATEST_RAW="$(fetch --max-filesize 32 "${BASE_URL}/latest")" ||
    abort "failed to read the latest version from ${BASE_URL}/latest — check your network."
  VERSION="$(printf '%s' "$LATEST_RAW" | tr -d '\r')"
  is_version "$VERSION" || abort "the published latest version is not X.Y.Z — refusing to guess."
fi
BASE="${BASE_URL}/v${VERSION}"

# ---- download into an isolated temp dir ------------------------------------
TMPDIR_DL="$(mktemp -d 2>/dev/null || mktemp -d -t confeature-install)"
# Clean up the temp dir on any exit (success or failure).
trap 'rm -rf "$TMPDIR_DL"' EXIT INT TERM

echo "==> downloading ${ASSET} (${VERSION}) ..."
fetch "${BASE}/${ASSET}" -o "${TMPDIR_DL}/${ASSET}" ||
  abort "failed to download ${BASE}/${ASSET} — check the version and your network."
fetch "${BASE}/SHA256SUMS" -o "${TMPDIR_DL}/SHA256SUMS" ||
  abort "failed to download the SHA256SUMS manifest from ${BASE}."

# ---- verify the checksum (fail closed) -------------------------------------
# Pull the expected digest for THIS asset out of the manifest; abort if absent.
EXPECTED="$(awk -v a="$ASSET" '$2 == a || $2 == "*"a {print $1}' "${TMPDIR_DL}/SHA256SUMS" | head -n1)"
[ -n "$EXPECTED" ] || abort "no checksum for ${ASSET} in SHA256SUMS — refusing to install."

ACTUAL="$(sha256 "${TMPDIR_DL}/${ASSET}")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  abort "checksum mismatch for ${ASSET}:
  expected ${EXPECTED}
  actual   ${ACTUAL}
Refusing to install a tampered or corrupt download."
fi
echo "==> checksum verified (${ACTUAL})"

# ---- pick a writable install dir -------------------------------------------
# Prefer a per-user dir ($HOME/.local/bin), fall back to /usr/local/bin. Abort
# with a clear pointer if neither is writable (no sudo magic).
choose_dir() {
  for d in "${HOME}/.local/bin" "/usr/local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then
      echo "$d"
      return 0
    fi
  done
  # $HOME/.local/bin is the conventional create-if-missing target.
  if mkdir -p "${HOME}/.local/bin" 2>/dev/null && [ -w "${HOME}/.local/bin" ]; then
    echo "${HOME}/.local/bin"
    return 0
  fi
  return 1
}

INSTALL_DIR="$(choose_dir)" || abort "no writable install directory.
Tried \$HOME/.local/bin and /usr/local/bin. Create a writable bin dir on your
PATH (e.g. mkdir -p \$HOME/.local/bin) and re-run, or move the binary manually."

DEST="${INSTALL_DIR}/${BINARY}"
mv -f "${TMPDIR_DL}/${ASSET}" "$DEST" || abort "failed to move the binary into ${INSTALL_DIR}."
chmod +x "$DEST" || abort "failed to mark ${DEST} executable."

echo "==> installed ${BINARY} to ${DEST}"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "note: ${INSTALL_DIR} is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
echo "==> run 'confeature --version' to confirm."
