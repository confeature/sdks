#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

log=$(mktemp)
trap 'rm -f "$log"' EXIT

if sh ./gradlew --no-daemon "$@" >"$log" 2>&1; then
    cat "$log"
    exit 0
else
    status=$?
fi

cat "$log"
if ! grep -Eq 'https://repo\.maven\.apache\.org/.*Received status code 429 from server' "$log"; then
    exit "$status"
fi

# Gradle has already exhausted its own HTTP attempts. Wait once, then reuse
# the same cache and run the full gate again. The second result is final.
printf '%s\n' 'Maven Central rate-limited dependency resolution. Retrying in 60 seconds.' >&2
sleep 60
sh ./gradlew --no-daemon "$@"
