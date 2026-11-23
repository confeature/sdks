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
const XCODE = SOURCE.match(/grep -Fx '([^']+)'/)[1];
const DEVICE = "54ADC2F6-A37C-48EA-B4C0-A0CFA960990E";
const REPLACEMENT = "F67E1E2B-5B8F-4B6C-82E8-E81248E35749";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-0";
const createAndBoot = (device) => ["create", `boot ${device}`, `bootstatus ${device}`];
const retire = (device) => [`shutdown ${device}`, `delete ${device}`];
const STARTUP = ["list", ...createAndBoot(DEVICE)];
const CLEANUP = retire(DEVICE);
const RECOVERY = [...STARTUP, ...CLEANUP, ...createAndBoot(REPLACEMENT)];
const FIXTURE = `import { appendFileSync } from "node:fs";
const { CONFEATURE_KOTLIN_SIMULATOR: device, SIM_MODE, CALL_LOG } = process.env;
const expected = SIM_MODE === "slow-boot" ? "${REPLACEMENT}" : "${DEVICE}";
if (process.argv[2] !== "apple" || device !== expected) process.exit(64);
appendFileSync(CALL_LOG, "fixture " + device + "\\n");
if (SIM_MODE.startsWith("fixture-failure")) process.exit(42);`;

const TOOLS = {
  uname: 'printf "%s\\n" arm64',
  xcodebuild: `case "$1" in
    -version) printf "%s\\n" "$FAKE_XCODE" ;;
    -downloadPlatform)
      printf "download\\n" >> "$CALL_LOG"
      [ "$#" = 6 ] && [ "$2" = iOS ] && [ "$3" = -buildVersion ] && [ "$4" = 26.0 ] &&
      [ "$5" = -architectureVariant ] && [ "$6" = arm64 ] || exit 64
      [ "$SIM_MODE" != failed-download ] || exit 29
      : > "$HOME/downloaded" ;;
    *) exit 64 ;;
  esac`,
  // Only the deadlines of the deliberately hung commands are shortened.
  node: `if [ "$1" = "--input-type=module" ]; then
    case "$SIM_MODE:$5" in
      slow-list:list|stalled-list:list|stalled-create:create|slow-boot:bootstatus|stalled-boot:bootstatus|failed-retirement:bootstatus|interrupted-retirement:bootstatus)
        exec "$REAL_NODE" "$1" "$2" "$3" 0.15 "\${@:5}" ;;
    esac
  fi
  exec "$REAL_NODE" "$@"`,
  xcrun: `[ "$1" = simctl ] || exit 64
  case "$2" in
    boot|bootstatus|shutdown|delete) printf "%s %s\\n" "$2" "$3" ;;
    *) printf "%s\\n" "$2" ;;
  esac >> "$CALL_LOG"
  case "$SIM_MODE:$2" in
    failed-list:list|failed-bootstatus:bootstatus) exit 21 ;;
    exit-124:list|exit-124-bootstatus:bootstatus) exit 124 ;;
    interrupted-list:list|interrupted-bootstatus:bootstatus|interrupted-retirement:shutdown)
      wrapper=$PPID
      ( /bin/sleep 0.2; kill -TERM "$wrapper"; exec /bin/sleep 5 ) &
      exit 0 ;;
    stalled-create:create)
      /bin/sleep 5 &
      printf "%s\\n" "$!" > "$HOME/descendant"
      wait "$!" ;;
    fixture-failure-cleanup:delete|failed-cleanup:delete|failed-retirement:delete) exit 32 ;;
    stalled-list:list|stalled-boot:bootstatus) exec /bin/sleep 5 ;;
    slow-boot:bootstatus|failed-retirement:bootstatus|interrupted-retirement:bootstatus)
      if [ "$3" = "$FAKE_DEVICE" ]; then exec /bin/sleep 5; fi ;;
    slow-list:list)
      if [ ! -e "$HOME/listed" ]; then
        : > "$HOME/listed"
        exec /bin/sleep 5
      fi ;;
  esac
  case "$2" in
    list)
      [ "$#" = 4 ] && [ "$3" = runtimes ] && [ "$4" = --json ] || exit 64
      identifier=$FAKE_RUNTIME
      availability=true
      case "$SIM_MODE" in
        invalid-runtime-json) printf 'not JSON\\n'; exit 0 ;;
        invalid-runtime-list) availability='"true"' ;;
        missing-after-download) identifier="$FAKE_RUNTIME-1" ;;
        missing-runtime|failed-download)
          if [ ! -e "$HOME/downloaded" ]; then identifier="$FAKE_RUNTIME-1"; fi ;;
        unavailable-runtime)
          if [ ! -e "$HOME/downloaded" ]; then availability=false; fi ;;
      esac
      printf '{"runtimes":[{"identifier":"%s","isAvailable":%s}]}\\n' "$identifier" "$availability" ;;
    create)
      [ "$4" = com.apple.CoreSimulator.SimDeviceType.iPhone-17 ] &&
      [ "$5" = "$FAKE_RUNTIME" ] || exit 64
      if [ -e "$HOME/created" ]; then
        printf "%s\\n" "$FAKE_REPLACEMENT"
      else
        : > "$HOME/created"
        printf "%s\\n" "$FAKE_DEVICE"
      fi ;;
    boot|bootstatus|shutdown|delete) [ "$3" = "$FAKE_DEVICE" ] || [ "$3" = "$FAKE_REPLACEMENT" ] ;;
  esac`,
};

function run(mode, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "kotlin-simctl-"));
  try {
    const log = join(dir, "calls");
    const githubEnv = join(dir, "github-env");
    writeFileSync(log, "");
    writeFileSync(githubEnv, "");
    writeFileSync(join(dir, "check-apple.sh"), SOURCE);
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
        HOME: dir,
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
      calls: readFileSync(log, "utf8").trim().split("\n"),
      stderr: result.stderr,
      githubEnv: readFileSync(githubEnv, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Kotlin OpenFeature Apple simulator startup", () => {
  it("does not download an available pinned runtime even with installation enabled", () => {
    const result = run("ready", ["--install-runtime"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
  });

  it("requires the pinned runtime without installing it on an ordinary invocation", () => {
    const result = run("missing-runtime");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["list"]);
    expect(result.githubEnv).toBe("");
  });

  it.each(["missing-runtime", "unavailable-runtime"])(
    "downloads and validates the pinned runtime before creating a device for %s",
    (mode) => {
      const result = run(mode, ["--install-runtime"]);
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([
        "list",
        "download",
        ...STARTUP,
        `fixture ${DEVICE}`,
        ...CLEANUP,
      ]);
    },
  );

  it.each([
    ["failed-list", 21, ["list"]],
    ["invalid-runtime-json", 1, ["list"]],
    ["invalid-runtime-list", 1, ["list"]],
    ["failed-download", 29, ["list", "download"]],
    ["missing-after-download", 1, ["list", "download", "list"]],
  ])("fails closed on runtime provisioning for %s", (mode, status, calls) => {
    const result = run(mode, ["--install-runtime"]);
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.githubEnv).toBe("");
  });

  it("runs the fixture on the created simulator and exports the Xcode for the Maven link", () => {
    const result = run("ready");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
    expect(result.githubEnv).toMatch(
      /^DEVELOPER_DIR=\/Applications\/Xcode_.*\/Contents\/Developer\n$/,
    );
  });

  it("retries simulator discovery exactly once when the first call times out", () => {
    const result = run("slow-list");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["list", ...STARTUP, `fixture ${DEVICE}`, ...CLEANUP]);
    expect(result.stderr).toContain("Retrying simulator discovery after a timeout");
  });

  it("replaces an unready simulator once and runs the fixture on the ready replacement", () => {
    const result = run("slow-boot");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...RECOVERY, `fixture ${REPLACEMENT}`, ...retire(REPLACEMENT)]);
    expect(result.stderr).toContain("Retrying simulator boot with a fresh device after a timeout");
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
    ["stalled-boot", 124, [...RECOVERY, ...retire(REPLACEMENT)]],
    ["failed-bootstatus", 21, [...STARTUP, ...CLEANUP]],
    ["exit-124-bootstatus", 1, [...STARTUP, ...CLEANUP]],
    ["interrupted-bootstatus", 143, [...STARTUP, ...CLEANUP]],
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
