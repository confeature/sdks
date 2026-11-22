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
const STARTUP = ["list", "create", "boot", "bootstatus"];
const CLEANUP = ["shutdown", "delete"];

function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), "kotlin-simctl-"));
  try {
    const log = join(dir, "calls");
    const githubEnv = join(dir, "github-env");
    writeFileSync(log, "");
    writeFileSync(githubEnv, "");
    writeFileSync(join(dir, "check-apple.sh"), SOURCE);
    writeFileSync(
      join(dir, "run-fixture.mjs"),
      `import { appendFileSync } from "node:fs";
      if (process.argv[2] !== "apple" || process.env.CONFEATURE_KOTLIN_SIMULATOR !== "${DEVICE}")
        process.exit(64);
      appendFileSync(process.env.CALL_LOG, "fixture\\n");
      if (process.env.SIM_MODE.startsWith("fixture-failure")) process.exit(42);`,
    );

    const tools = {
      uname: 'printf "%s\\n" arm64',
      xcodebuild: 'printf "%s\\n" "$FAKE_XCODE"',
      // Only the deadlines of the deliberately hung commands are shortened.
      node: `if [ "$1" = "--input-type=module" ]; then
        case "$SIM_MODE:$5" in
          slow-list:list|stalled-list:list|stalled-boot:bootstatus|stalled-create:create)
            exec "$REAL_NODE" "$1" "$2" "$3" 0.15 "\${@:5}" ;;
        esac
      fi
      exec "$REAL_NODE" "$@"`,
      xcrun: `[ "$1" = simctl ] || exit 64
      printf "%s\\n" "$2" >> "$CALL_LOG"
      case "$SIM_MODE:$2" in
        failed-list:list) exit 21 ;;
        exit-124:list) exit 124 ;;
        interrupted-list:list)
          wrapper=$PPID
          ( /bin/sleep 0.2; kill -TERM "$wrapper"; exec /bin/sleep 5 ) &
          exit 0 ;;
        stalled-create:create)
          /bin/sleep 5 &
          printf "%s\\n" "$!" > "$HOME/descendant"
          wait "$!" ;;
        fixture-failure-cleanup:delete|failed-cleanup:delete) exit 32 ;;
        stalled-list:list|stalled-boot:bootstatus) exec /bin/sleep 5 ;;
        slow-list:list)
          if [ ! -e "$HOME/listed" ]; then
            : > "$HOME/listed"
            exec /bin/sleep 5
          fi ;;
      esac
      case "$2" in
        create) printf "%s\\n" "$FAKE_DEVICE" ;;
        boot|bootstatus|shutdown|delete) [ "$3" = "$FAKE_DEVICE" ] ;;
      esac`,
    };
    for (const [tool, body] of Object.entries(tools)) {
      writeFileSync(join(dir, tool), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }

    const started = performance.now();
    const result = spawnSync("/bin/bash", [join(dir, "check-apple.sh")], {
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
  it("runs the fixture on the created simulator and exports the Xcode for the Maven link", () => {
    const result = run("ready");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([...STARTUP, "fixture", ...CLEANUP]);
    expect(result.githubEnv).toMatch(
      /^DEVELOPER_DIR=\/Applications\/Xcode_.*\/Contents\/Developer\n$/,
    );
  });

  it("retries simulator discovery exactly once when the first call times out", () => {
    const result = run("slow-list");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["list", ...STARTUP, "fixture", ...CLEANUP]);
    expect(result.stderr).toContain("Retrying simulator discovery after a timeout");
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
    expect(result.calls).toEqual([...STARTUP, "fixture", ...CLEANUP]);
  });

  it.each([
    ["failed-list", 21, ["list"]],
    ["exit-124", 1, ["list"]],
    ["interrupted-list", 143, ["list"]],
    ["stalled-list", 124, ["list", "list"]],
    ["stalled-boot", 124, [...STARTUP, ...CLEANUP]],
    ["fixture-failure", 42, [...STARTUP, "fixture", ...CLEANUP]],
    ["fixture-failure-cleanup", 42, [...STARTUP, "fixture", ...CLEANUP]],
  ])("fails closed for %s", (mode, status, calls) => {
    const result = run(mode);
    expect(result.status).toBe(status);
    expect(result.calls).toEqual(calls);
    expect(result.githubEnv).toBe("");
  });
});
