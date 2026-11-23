#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

integration=$(cd "$(dirname "$0")" && pwd)
export DEVELOPER_DIR=/Applications/Xcode_26.0.1.app/Contents/Developer
xcodebuild -version | grep -Fx 'Xcode 26.0.1'
[[ "$(uname -m)" == arm64 ]]

simctl() {
  local seconds=$1
  shift
  printf 'iOS simulator: %s (timeout %ss)\n' "$1" "$seconds" >&2
  # JavaScript receives the shell arguments through argv.
  # shellcheck disable=SC2016
  node --input-type=module -e '
    import { spawn } from "node:child_process";

    const [seconds, action, ...args] = process.argv.slice(1);
    const child = spawn("xcrun", ["simctl", action, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.pipe(process.stdout, { end: false });
    let timedOut = false;
    let interrupted;

    function stop() {
      if (child.pid === undefined) return;
      try {
        // Only the process group created for this particular simctl command.
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") console.error(error.message);
      }
      child.stdout.destroy();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`simctl ${action} did not finish within ${seconds}s`);
      stop();
    }, Number(seconds) * 1000);
    for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      process.once(signal, () => {
        interrupted = status;
        stop();
      });
    }

    child.on("error", (error) => console.error(`simctl ${action} failed: ${error.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (interrupted !== undefined) {
        process.exitCode = interrupted;
      } else if (timedOut) {
        process.exitCode = 124;
      } else if (signal || code === null || code < 0 || code === 124) {
        console.error(`simctl ${action} exited with ${signal ?? code}`);
        process.exitCode = 1;
      } else {
        process.exitCode = code;
      }
    });
  ' "$seconds" "$@"
}

# The first call can wait for CoreSimulator to mount the installed runtimes.
# Retry only that read-only call, and only on a timeout (runner-images#15247).
simctl 240 list devices >/dev/null || {
  status=$?
  if [[ "$status" != 124 ]]; then
    exit "$status"
  fi
  printf '%s\n' 'Retrying simulator discovery after a timeout.' >&2
  simctl 120 list devices >/dev/null
}

device=
start_device() {
  device=$(simctl 120 create 'Confeature Kotlin OpenFeature' \
    com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-0)
  simctl 120 boot "$device"
}

retire_device() {
  local retiring=$device shutdown_status=0
  device=
  # The device may already be stopped. Deletion still has to succeed.
  simctl 30 shutdown "$retiring" || shutdown_status=$?
  simctl 30 delete "$retiring" || return "$?"
  if [[ "$shutdown_status" == 130 || "$shutdown_status" == 143 ]]; then
    return "$shutdown_status"
  fi
}

cleanup() {
  local status=$?
  if [[ -n "$device" ]] && ! retire_device && [[ "$status" == 0 ]]; then
    status=1
  fi
  return "$status"
}
trap cleanup EXIT
start_device
simctl 300 bootstatus "$device" -b || {
  status=$?
  [[ "$status" == 124 ]] || exit "$status"
  printf '%s\n' 'Retrying simulator boot with a fresh device after a timeout.' >&2
  retire_device
  start_device
  simctl 300 bootstatus "$device" -b
}
export CONFEATURE_KOTLIN_SIMULATOR="$device"
node "$integration/run-fixture.mjs" apple
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
fi
