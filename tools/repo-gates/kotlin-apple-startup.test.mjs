// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../apps/sdk-kotlin-mp/openfeature/integration/check-apple.sh", import.meta.url),
  "utf8",
);
const XCODE = "Xcode 26.2";
const DEVICE = "54ADC2F6-A37C-48EA-B4C0-A0CFA960990E";
const REPLACEMENT = "F67E1E2B-5B8F-4B6C-82E8-E81248E35749";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-2";
const createAndBoot = (device) => ["create", `boot ${device}`, `spawn ${device}`];
const retire = (device) => [`shutdown ${device}`, `delete ${device}`];
const STARTUP = ["list", ...createAndBoot(DEVICE)];
const CLEANUP = retire(DEVICE);
const RECOVERY = [...STARTUP, ...CLEANUP, ...createAndBoot(REPLACEMENT)];
const FIXTURE = `import { appendFileSync } from "node:fs";
const { CONFEATURE_KOTLIN_SIMULATOR: device, SIM_MODE, CALL_LOG } = process.env;
const expected = SIM_MODE === "slow-readiness" ? "${REPLACEMENT}" : "${DEVICE}";
if (process.argv[2] !== "apple" || device !== expected) process.exit(64);
appendFileSync(CALL_LOG, "fixture " + device + "\\n");
if (SIM_MODE.startsWith("fixture-failure")) process.exit(42);`;

const TOOLS = {
  uname: 'printf "%s\\n" arm64',
  xcodebuild: '[ "$1" = -version ] || exit 64\nprintf "%s\\n" "$FAKE_XCODE"',
  // Only the deadlines of the deliberately hung commands are shortened.
  node: `if [ "$1" = "--input-type=module" ]; then
    if [ "$5" = "spawn" ]; then printf "%s\\n" "$4" >> "$CALL_LOG.boot"; fi
    case "$SIM_MODE:$5" in
      slow-list:list|stalled-list:list|stalled-create:create|slow-readiness:spawn|stalled-readiness:spawn|failed-retirement:spawn|interrupted-retirement:spawn)
        exec "$REAL_NODE" "$1" "$2" "$3" 0.15 "\${@:5}" ;;
    esac
  fi
  exec "$REAL_NODE" "$@"`,
  xcrun: `[ "$1" = simctl ] || exit 64
  case "$2" in
    boot|spawn|shutdown|delete) printf "%s %s\\n" "$2" "$3" ;;
    list) if [ "$3" = devices ]; then printf "list devices %s\\n" "$4"; else printf "list\\n"; fi ;;
    *) printf "%s\\n" "$2" ;;
  esac >> "$CALL_LOG"
  case "$SIM_MODE:$2" in
    failed-list:list|failed-spawn:spawn) exit 21 ;;
    exit-124:list|exit-124-spawn:spawn) exit 124 ;;
    interrupted-list:list|interrupted-spawn:spawn|interrupted-retirement:shutdown)
      wrapper=$PPID
      ( /bin/sleep 0.2; kill -TERM "$wrapper"; exec /bin/sleep 5 ) &
      exit 0 ;;
    stalled-create:create)
      /bin/sleep 5 &
      printf "%s\\n" "$!" > "$SIM_TEST_DIR/descendant"
      wait "$!" ;;
    fixture-failure-cleanup:delete|failed-cleanup:delete|failed-retirement:delete) exit 32 ;;
    stalled-list:list|stalled-readiness:spawn) exec /bin/sleep 5 ;;
    slow-readiness:spawn|failed-retirement:spawn|interrupted-retirement:spawn)
      if [ "$3" = "$FAKE_DEVICE" ]; then exec /bin/sleep 5; fi ;;
    slow-list:list)
      if [ ! -e "$SIM_TEST_DIR/listed" ]; then
        : > "$SIM_TEST_DIR/listed"
        exec /bin/sleep 5
      fi ;;
  esac
  case "$2" in
    list)
      if [ "$3" = devices ]; then
        [ "$#" = 4 ] && [ "$4" = "$FAKE_REPLACEMENT" ] || exit 64
        printf "Simulator still reports Booted\\n"
        exit 0
      fi
      [ "$#" = 4 ] && [ "$3" = runtimes ] && [ "$4" = --json ] || exit 64
      identifier=$FAKE_RUNTIME
      availability=true
      case "$SIM_MODE" in
        invalid-runtime-json) printf 'not JSON\\n'; exit 0 ;;
        invalid-runtime-list) availability='"true"' ;;
        missing-runtime) identifier="$FAKE_RUNTIME-1" ;;
        unavailable-runtime) availability=false ;;
      esac
      printf '{"runtimes":[{"identifier":"%s","isAvailable":%s}]}\\n' "$identifier" "$availability" ;;
    create)
      [ "$4" = com.apple.CoreSimulator.SimDeviceType.iPhone-17 ] &&
      [ "$5" = "$FAKE_RUNTIME" ] || exit 64
      if [ -e "$SIM_TEST_DIR/created" ]; then
        printf "%s\\n" "$FAKE_REPLACEMENT"
      else
        : > "$SIM_TEST_DIR/created"
        printf "%s\\n" "$FAKE_DEVICE"
      fi ;;
    spawn)
      [ "$#" = 5 ] && [ "$4" = launchctl ] && [ "$5" = managerpid ] || exit 64
      [ "$3" = "$FAKE_DEVICE" ] || [ "$3" = "$FAKE_REPLACEMENT" ] || exit 64
      if [ "$SIM_MODE" = booting ] && [ ! -e "$SIM_TEST_DIR/probed" ]; then
        : > "$SIM_TEST_DIR/probed"
        exit 149
      fi
      case "$SIM_MODE" in
        invalid-pid) printf 'not a pid\\n' ;;
        zero-pid) printf '0\\n' ;;
        *) printf '1234\\n' ;;
      esac ;;
    boot|shutdown|delete) [ "$3" = "$FAKE_DEVICE" ] || [ "$3" = "$FAKE_REPLACEMENT" ] ;;
  esac`,
};

function run(mode, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "kotlin-simctl-"));
  try {
    const log = join(dir, "calls");
    const bootLog = `${log}.boot`;
    const githubEnv = join(dir, "github-env");
    writeFileSync(log, "");
    writeFileSync(githubEnv, "");
    const shortened = [
      "slow-readiness",
      "stalled-readiness",
      "failed-retirement",
      "interrupted-retirement",
    ].includes(mode);
    const script = shortened
      ? SOURCE.replace(
          /^readonly readiness_deadline_seconds=\d+$/m,
          "readonly readiness_deadline_seconds=1",
        )
      : SOURCE;
    writeFileSync(join(dir, "check-apple.sh"), script);
    writeFileSync(join(dir, "run-fixture.mjs"), FIXTURE);

    for (const [tool, body] of Object.entries(TOOLS)) {
      writeFileSync(join(dir, tool), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }

    const started = performance.now();
    const result = spawnSync("/bin/bash", [join(dir, "check-apple.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        SIM_TEST_DIR: dir,
        REAL_NODE: process.execPath,
        SIM_MODE: mode,
        FAKE_XCODE: XCODE,
        FAKE_DEVICE: DEVICE,
        FAKE_REPLACEMENT: REPLACEMENT,
        FAKE_RUNTIME: RUNTIME,
        CALL_LOG: log,
        GITHUB_ENV: githubEnv,
      },
    });
    if (result.error) throw result.error;
    const descendant = join(dir, "descendant");
    const descendantState = existsSync(descendant)
      ? spawnSync("/bin/ps", ["-o", "stat=", "-p", readFileSync(descendant, "utf8").trim()], {
          encoding: "utf8",
        }).stdout.trim()
      : undefined;
    return {
      descendantState,
      elapsed: performance.now() - started,
      status: result.status,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      bootDeadlines: existsSync(bootLog) ? readFileSync(bootLog, "utf8").trim().split("\n") : [],
      stderr: result.stderr,
      githubEnv: readFileSync(githubEnv, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Kotlin OpenFeature Apple simulator startup", () => {
  it.each([
    ["missing-runtime", 1],
    ["unavailable-runtime", 1],
    ["invalid-runtime-json", 1],
    ["invalid-runtime-list", 1],
  ])("requires a valid preinstalled runtime for %s", (mode, status) => {
    const result = run(mode);
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(["list"]);
    expect(result.githubEnv).toBe("");
  });

  it("rejects the former runtime installation flag before touching the simulator", () => {
    const result = run("ready", ["--install-runtime"]);
    expect(result.status).toBe(64);
    expect(result.calls).toEqual([]);
  });

  it("runs the fixture on the created simulator and exports the Xcode for the Maven link", () => {
    const result = run("ready");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
    expect(result.githubEnv).toBe(
      "DEVELOPER_DIR=/Applications/Xcode_26.2.app/Contents/Developer\n",
    );
  });

  it("retries simulator discovery exactly once when the first call times out", () => {
    const result = run("slow-list");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["list", ...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
    expect(result.stderr).toContain("Retrying simulator discovery after a timeout");
  });

  it("waits on the same device when launchd is still starting", () => {
    const result = run("booting");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...STARTUP, `spawn ${DEVICE}`, `fixture ${DEVICE}`, ...CLEANUP]);
  });

  it("replaces an unready simulator once and runs the fixture on the ready replacement", () => {
    const result = run("slow-readiness");
    expect(result.status).toBe(0);
    expect(result.bootDeadlines).toEqual(["1", "1"]);
    expect(result.calls).toEqual([...RECOVERY, `fixture ${REPLACEMENT}`, ...retire(REPLACEMENT)]);
    expect(result.stderr).toContain(
      "Retrying simulator readiness with a fresh device after a timeout",
    );
    expect(result.githubEnv).toMatch(/^DEVELOPER_DIR=.+\n$/);
  });

  it("times out creation even when a child holds its stdout open", () => {
    const result = run("stalled-create");
    expect(result.status).toBe(124);
    expect(result.calls).toEqual(["list", "create"]);
    expect(result.githubEnv).toBe("");
    expect(result.elapsed).toBeLessThan(4_000);
    expect(["", "Z"]).toContain(result.descendantState?.charAt(0));
  });

  it("reports the replacement's state within a bounded diagnostic after final timeout", () => {
    const result = run("stalled-readiness");
    expect(result.status).toBe(124);
    expect(result.calls).toEqual([
      ...RECOVERY,
      `list devices ${REPLACEMENT}`,
      ...retire(REPLACEMENT),
    ]);
    expect(result.stderr).toContain("list (timeout 10s)");
    expect(result.stderr).toContain("Simulator still reports Booted");
    expect(result.githubEnv).toBe("");
  }, 12_000);

  it("fails if the fixture passed but deleting its simulator fails", () => {
    const result = run("failed-cleanup");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
  });

  it.each([
    ["failed-list", 21, ["list"]],
    ["exit-124", 1, ["list"]],
    ["interrupted-list", 143, ["list"]],
    ["stalled-list", 124, ["list", "list"]],
    ["invalid-pid", 1, [...STARTUP, ...CLEANUP]],
    ["zero-pid", 1, [...STARTUP, ...CLEANUP]],
    ["failed-spawn", 21, [...STARTUP, ...CLEANUP]],
    ["exit-124-spawn", 1, [...STARTUP, ...CLEANUP]],
    ["interrupted-spawn", 143, [...STARTUP, ...CLEANUP]],
    ["failed-retirement", 32, [...STARTUP, ...CLEANUP]],
    ["interrupted-retirement", 143, [...STARTUP, ...CLEANUP]],
    ["fixture-failure", 42, [...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]],
    ["fixture-failure-cleanup", 42, [...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]],
  ])("fails closed for %s", (mode, status, calls) => {
    const result = run(mode);
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.githubEnv).toBe("");
  });
});
