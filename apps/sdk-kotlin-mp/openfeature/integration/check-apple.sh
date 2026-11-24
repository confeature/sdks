#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

integration=$(cd "$(dirname "$0")" && pwd)
export DEVELOPER_DIR=/Applications/Xcode_26.0.1.app/Contents/Developer
readonly ios_version=26.2
readonly ios_runtime="com.apple.CoreSimulator.SimRuntime.iOS-${ios_version//./-}"
readonly readiness_deadline_seconds=180
readonly probe_timeout_seconds=15

if [[ "$#" != 0 ]]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 64
fi

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

runtime_available() {
  local listing status
  # CoreSimulator can take time to mount its runtimes (runner-images#15247).
  listing=$(simctl 240 list runtimes --json) || {
    status=$?
    [[ "$status" == 124 ]] || return "$status"
    printf '%s\n' 'Retrying simulator discovery after a timeout.' >&2
    listing=$(simctl 120 list runtimes --json) || return "$?"
  }
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { runtimes } = JSON.parse(readFileSync(0, "utf8"));
    if (!Array.isArray(runtimes) || runtimes.some((runtime) =>
      typeof runtime?.identifier !== "string" || typeof runtime.isAvailable !== "boolean"))
      throw new Error("Invalid simulator runtime listing");
    console.log(runtimes.some((runtime) =>
      runtime.identifier === process.argv[1] && runtime.isAvailable));
  ' "$ios_runtime" <<< "$listing"
}

available=$(runtime_available)
if [[ "$available" != true ]]; then
  printf 'Required simulator runtime %s is unavailable.\n' "$ios_runtime" >&2
  exit 1
fi

device=
start_device() {
  device=$(simctl 120 create 'Confeature Kotlin OpenFeature' \
    com.apple.CoreSimulator.SimDeviceType.iPhone-17 "$ios_runtime")
  simctl 120 boot "$device"
}

wait_for_launchd() {
  local deadline=$((SECONDS + readiness_deadline_seconds))
  local remaining manager status
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    if (( remaining <= 0 )); then
      break
    fi
    if (( remaining > probe_timeout_seconds )); then
      remaining=$probe_timeout_seconds
    fi
    # Kotlin/Native runs its test binary through simctl spawn on this device.
    if manager=$(simctl "$remaining" spawn "$device" launchctl managerpid); then
      if [[ "$manager" =~ ^[1-9][0-9]*$ ]]; then
        printf 'iOS simulator %s is accepting processes.\n' "$device" >&2
        return 0
      fi
      printf '%s\n' 'The simulator returned an invalid launchd PID.' >&2
      return 1
    else
      status=$?
      # 149 is CoreSimulator reporting that the device is still booting.
      case "$status" in
        124|149) sleep 1 ;;
        *) return "$status" ;;
      esac
    fi
  done
  printf 'The iOS simulator did not accept processes within %ss.\n' "$readiness_deadline_seconds" >&2
  return 124
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
wait_for_launchd || {
  status=$?
  [[ "$status" == 124 ]] || exit "$status"
  printf '%s\n' 'Retrying simulator readiness with a fresh device after a timeout.' >&2
  retire_device
  start_device
  wait_for_launchd || {
    status=$?
    if [[ "$status" == 124 ]]; then
      # Capture CoreSimulator's reported state without extending the retry.
      simctl 10 list devices "$device" >&2 || true
    fi
    exit "$status"
  }
}
export CONFEATURE_KOTLIN_SIMULATOR="$device"
node "$integration/run-fixture.mjs" apple
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
fi
