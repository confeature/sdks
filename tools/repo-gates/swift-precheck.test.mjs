// SPDX-License-Identifier: MIT

/**
 * scripts/swift-precheck.sh is the one home of the Xcode the Swift SDK is
 * judged with: the pin, the path derived from it, what counts as CI, and what
 * happens when the pin is missing (CI: red; locally: a loud WARN, then on).
 *
 * Each guard is run here against a sandbox copy of the script, with
 * `/Applications/` moved into the sandbox and fake `swift`, `swift-format`,
 * `xcrun` and `xcodebuild` first on PATH (a row may leave one out, or leave
 * the system directories off PATH). The environment is built from
 * nothing, so the CI variables of whatever runs this test never leak in, and
 * HOME is the sandbox. The pin and the path shape are read from the script,
 * never restated, so bumping Xcode stays a one-line edit there.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = readFileSync(join(ROOT, "scripts/swift-precheck.sh"), "utf8");
const PIN = /^XCODE_PIN=([^\n]*)$/m.exec(SOURCE)?.[1];
const DEV_SHAPE = /^XCODE_DEV="\/Applications\/([^"\n]+)"$/m.exec(SOURCE)?.[1];

/**
 * The fakes log the DEVELOPER_DIR each tool ran under, so a row can see which
 * Xcode judged, and `xcrun swift …` logs as itself, so a row can see whether
 * the suite ran the pinned Xcode's swift or the one first on PATH. With
 * FAKE_NO_FORMAT set, neither swift has a `format` subcommand.
 */
const NO_FORMAT = `if [ "$1" = format ] && [ -n "\${FAKE_NO_FORMAT:-}" ]; then exit 1; fi`;
const FAKES = {
  swift: [`printf '%s|swift %s\\n' "\${DEVELOPER_DIR:-}" "$*" >> "$FAKE_LOG"`, NO_FORMAT].join(
    "\n",
  ),
  "swift-format": `printf '%s|swift-format %s\\n' "\${DEVELOPER_DIR:-}" "$*" >> "$FAKE_LOG"`,
  xcrun: [
    `if [ "$*" = "--find swift" ]; then`,
    `  printf '%s\\n' "\${FAKE_SWIFT_AT:-\${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift}"`,
    `  exit 0`,
    `fi`,
    `[ "$1" = swift ] || exit 64`,
    `shift`,
    `printf '%s|xcrun swift %s\\n' "\${DEVELOPER_DIR:-}" "$*" >> "$FAKE_LOG"`,
    NO_FORMAT,
  ].join("\n"),
  xcodebuild: [
    `[ "$*" = "-version" ] || exit 64`,
    `printf '%s\\nBuild version 0\\n' "$FAKE_XCODE"`,
  ].join("\n"),
};

const boxes = [];
afterAll(() => {
  for (const b of boxes) rmSync(b, { recursive: true, force: true });
});

/**
 * Runs a sandbox copy of the script. `installed` creates the pinned Xcode's
 * directory; `githubEnv` creates an empty GITHUB_ENV file and passes it in;
 * `env` is a map, or a function of the sandbox's pinned path; `without` names
 * fakes left out; `bare` leaves the system directories off PATH, so a tool
 * left out is not found there either (macOS has a /usr/bin/swift).
 */
function run({
  env = {},
  installed = true,
  githubEnv = false,
  source = SOURCE,
  without = [],
  bare = false,
} = {}) {
  const box = mkdtempSync(join(tmpdir(), "swift-precheck-"));
  boxes.push(box);
  const bin = join(box, "bin");
  for (const d of [bin, join(box, "scripts"), join(box, "apps", "sdk-swift")])
    mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    if (without.includes(name)) continue;
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const script = join(box, "scripts", "swift-precheck.sh");
  writeFileSync(script, source.replaceAll("/Applications/", `${box}/Applications/`));
  const dev = `${box}/Applications/${DEV_SHAPE.replaceAll("${XCODE_PIN}", PIN)}`;
  if (installed) mkdirSync(dev, { recursive: true });
  const log = join(box, "tools.log");
  const ghEnv = join(box, "github-env");
  if (githubEnv) writeFileSync(ghEnv, "");
  const extra = typeof env === "function" ? env(dev) : env;
  const r = spawnSync("/bin/bash", [script], {
    cwd: box,
    encoding: "utf8",
    env: {
      PATH: bare ? bin : `${bin}:/usr/bin:/bin`,
      HOME: box,
      FAKE_LOG: log,
      FAKE_XCODE: `Xcode ${PIN}`,
      ...(githubEnv ? { GITHUB_ENV: ghEnv } : {}),
      ...extra,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    dev,
    githubEnv: existsSync(ghEnv) ? readFileSync(ghEnv, "utf8") : undefined,
    tools: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

const CI = { CI: "true" };
const ACTIONS = { CI: "true", GITHUB_ACTIONS: "true" };
/** CI mode through GITHUB_ACTIONS alone, as a GitHub runner that sets no CI. */
const ACTIONS_ONLY = { CI: "", GITHUB_ACTIONS: "true" };
/** The suite ran, every tool under `devDir`. */
const judgedWith = (r, devDir) => {
  expect(
    r.tools.some((t) => /\|(?:xcrun )?swift build$/.test(t)),
    r.stderr,
  ).toBe(true);
  for (const t of r.tools) expect(t.split("|")[0]).toBe(devDir);
};
/** Exit 1 before any tool ran, naming the pin and saying which check fired (`why`). */
const refused = (r, why) => {
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
  expect(r.stderr).toContain(`Xcode ${PIN}`);
  expect(r.stderr).toMatch(why);
  expect(r.tools).toEqual([]);
};

describe("scripts/swift-precheck.sh holds the Xcode pin", () => {
  it("the pin is one value of the shape <major>[.<minor>…], and the path is derived from it", () => {
    expect(PIN).toMatch(/^[0-9]+(\.[0-9]+)*$/);
    expect(DEV_SHAPE).toContain("${XCODE_PIN}");
    expect(SOURCE.match(/^XCODE_PIN=/gm)).toHaveLength(1);
  });

  it("a pin of another shape is refused before anything runs", () => {
    const r = run({ env: CI, source: SOURCE.replace(/^XCODE_PIN=.*$/m, `XCODE_PIN="${PIN} x"`) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/XCODE_PIN/);
    expect(r.tools).toEqual([]);
  });

  describe("CI mode: the pin or red", () => {
    it("control: on the pinned Xcode, the suite runs on it and the later steps inherit it", () => {
      const r = run({ env: ACTIONS, githubEnv: true });
      expect(r.status, r.stderr).toBe(0);
      judgedWith(r, r.dev);
      // M11: exactly one line, the derived path, for the job's live step.
      expect(r.githubEnv).toBe(`DEVELOPER_DIR=${r.dev}\n`);
    });

    it("control: a preset DEVELOPER_DIR equal to the pinned path is accepted", () => {
      const r = run({ env: (dev) => ({ ...CI, DEVELOPER_DIR: dev }) });
      expect(r.status, r.stderr).toBe(0);
      judgedWith(r, r.dev);
    });

    // L1: the pin is checked on xcrun's swift, so the suite must run that
    // swift. MUTATION: run bare `swift build` in CI mode and the swift first
    // on PATH builds; this goes red.
    it("the suite runs the pinned Xcode's swift (xcrun), never the swift first on PATH", () => {
      const r = run({ env: ACTIONS, githubEnv: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.tools).toContain(`${r.dev}|xcrun swift build`);
      expect(r.tools).toContain(`${r.dev}|xcrun swift test`);
      expect(r.tools.filter((t) => /\|swift (?:build|test)$/.test(t))).toEqual([]);
    });

    it.each([
      [
        "M9: the pinned Xcode is not installed",
        { env: CI, installed: false },
        /is not installed at/,
      ],
      [
        "M17: CI empty but GITHUB_ACTIONS=true, the pinned Xcode not installed",
        { env: ACTIONS_ONLY, installed: false, githubEnv: true },
        /is not installed at/,
      ],
      [
        "M10: another Xcode at the pinned path",
        { env: { ...CI, FAKE_XCODE: "Xcode 0.0" } },
        /is Xcode 0\.0, not the pinned/,
      ],
      [
        "M10: an Xcode whose version only starts with the pin",
        { env: { ...CI, FAKE_XCODE: `Xcode ${PIN}.1` } },
        /is Xcode [0-9.]+\.1, not the pinned/,
      ],
      [
        "M10: swift resolves outside the pinned Xcode",
        { env: { ...CI, FAKE_SWIFT_AT: "/usr/bin/swift" } },
        /swift resolves to \/usr\/bin\/swift, outside the pinned/,
      ],
      ["M17: TOOLCHAINS is set", { env: { ...CI, TOOLCHAINS: "swift" } }, /TOOLCHAINS is set/],
      [
        "M17: GITHUB_ACTIONS=true with GITHUB_ENV unset",
        { env: ACTIONS, githubEnv: false },
        /GITHUB_ENV is unset/,
      ],
      [
        "a preset DEVELOPER_DIR that is another Xcode",
        { env: { ...CI, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" } },
        /DEVELOPER_DIR is preset to/,
      ],
    ])("refuses %s", (_name, opts, why) => refused(run(opts), why));

    it("M10: refuses swift resolved beside, not under, the pinned Xcode", () => {
      refused(
        run({ env: (dev) => ({ ...CI, FAKE_SWIFT_AT: `${dev}-beside/usr/bin/swift` }) }),
        /-beside\/usr\/bin\/swift, outside the pinned/,
      );
    });

    // M2: a missing tool is red in CI mode, never a skip. MUTATION: drop the
    // ci_mode test from either branch and its row exits 0 with a WARN.
    it("M2: refuses no swift on PATH (GITHUB_ACTIONS=true, CI empty)", () => {
      const r = run({ env: ACTIONS_ONLY, githubEnv: true, without: ["swift"], bare: true });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/swift is not on PATH under CI/);
      expect(r.tools).toEqual([]);
    });

    it("M2: refuses no swift-format and no `swift format` (GITHUB_ACTIONS=true, CI empty)", () => {
      const r = run({
        env: { ...ACTIONS_ONLY, FAKE_NO_FORMAT: "1" },
        githubEnv: true,
        without: ["swift-format"],
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/no swift-format under CI/);
      expect(r.tools).toContain(`${r.dev}|xcrun swift test`);
    });

    it("control: with no swift-format, CI mode lints with the pinned Xcode's `swift format`", () => {
      const r = run({ env: ACTIONS_ONLY, githubEnv: true, without: ["swift-format"] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.tools).toContain(
        `${r.dev}|xcrun swift format lint --strict --recursive Sources Tests`,
      );
    });
  });

  describe("locally: the pin when it can, never a block", () => {
    it("on the pinned Xcode when it is installed, with the swift on PATH", () => {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      judgedWith(r, r.dev);
      expect(r.tools).toContain(`${r.dev}|swift build`);
      expect(r.stderr).not.toMatch(/WARN/);
    });

    it("M2 control: no swift on PATH is a loud WARN and a skip, not a red push", () => {
      const r = run({ without: ["swift"], bare: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/WARN: swift not on PATH/);
      expect(r.tools).toEqual([]);
    });

    it("M2 control: no swift-format is a loud WARN, after the suite", () => {
      const r = run({ env: { FAKE_NO_FORMAT: "1" }, without: ["swift-format"] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/WARN: swift-format not on PATH/);
      expect(r.tools).toContain(`${r.dev}|swift test`);
    });

    it("M13: the pin absent is a loud WARN naming the pin and the Xcode in use, then the suite", () => {
      const r = run({ installed: false, env: { FAKE_XCODE: "Xcode 27.1" } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/WARN/);
      expect(r.stderr).toContain(`Xcode ${PIN}`);
      expect(r.stderr).toContain("Xcode 27.1");
      judgedWith(r, "");
    });

    it("an explicit DEVELOPER_DIR wins, with one note line", () => {
      const mine = "/somewhere/Xcode-beta.app/Contents/Developer";
      const r = run({ env: { DEVELOPER_DIR: mine } });
      expect(r.status, r.stderr).toBe(0);
      judgedWith(r, mine);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).toContain(mine);
    });
  });
});
