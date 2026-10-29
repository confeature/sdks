// SPDX-License-Identifier: MIT

/**
 * scripts/swift-precheck.sh is the one home of the Xcode the Swift SDK is
 * judged with: the pin, the path derived from it, what counts as CI, and what
 * happens when the pin is missing (CI: red; locally: a loud WARN, then on).
 *
 * Each guard is run here against a sandbox copy of the script, with
 * `/Applications/` moved into the sandbox and fake `swift`, `swift-format`,
 * `xcrun` and `xcodebuild` first on PATH. The environment is built from
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

/** The fakes log the DEVELOPER_DIR each tool ran under, so a row can see which Xcode judged. */
const FAKES = {
  swift: `printf '%s|swift %s\\n' "\${DEVELOPER_DIR:-}" "$*" >> "$FAKE_LOG"`,
  "swift-format": `printf '%s|swift-format %s\\n' "\${DEVELOPER_DIR:-}" "$*" >> "$FAKE_LOG"`,
  xcrun: [
    `[ "$*" = "--find swift" ] || exit 64`,
    `printf '%s\\n' "\${FAKE_SWIFT_AT:-\${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift}"`,
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
 * `env` is a map, or a function of the sandbox's pinned path.
 */
function run({ env = {}, installed = true, githubEnv = false, source = SOURCE } = {}) {
  const box = mkdtempSync(join(tmpdir(), "swift-precheck-"));
  boxes.push(box);
  const bin = join(box, "bin");
  for (const d of [bin, join(box, "scripts"), join(box, "apps", "sdk-swift")])
    mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
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
  const r = spawnSync("bash", [script], {
    cwd: box,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
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
/** The suite ran, every tool under `devDir`. */
const judgedWith = (r, devDir) => {
  expect(
    r.tools.some((t) => t.endsWith("|swift build")),
    r.stderr,
  ).toBe(true);
  for (const t of r.tools) expect(t.split("|")[0]).toBe(devDir);
};
/** Exit 1 before any tool ran, naming the pin. */
const refused = (r) => {
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
  expect(r.stderr).toContain(`Xcode ${PIN}`);
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

    it.each([
      ["M9: the pinned Xcode is not installed", { env: CI, installed: false }],
      [
        "M17: CI empty but GITHUB_ACTIONS=true, the pinned Xcode not installed",
        { env: { CI: "", GITHUB_ACTIONS: "true" }, installed: false, githubEnv: true },
      ],
      ["M10: another Xcode at the pinned path", { env: { ...CI, FAKE_XCODE: "Xcode 0.0" } }],
      [
        "M10: an Xcode whose version only starts with the pin",
        { env: { ...CI, FAKE_XCODE: `Xcode ${PIN}.1` } },
      ],
      [
        "M10: swift resolves outside the pinned Xcode",
        { env: { ...CI, FAKE_SWIFT_AT: "/usr/bin/swift" } },
      ],
      ["M17: TOOLCHAINS is set", { env: { ...CI, TOOLCHAINS: "swift" } }],
      ["M17: GITHUB_ACTIONS=true with GITHUB_ENV unset", { env: ACTIONS, githubEnv: false }],
      [
        "a preset DEVELOPER_DIR that is another Xcode",
        { env: { ...CI, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" } },
      ],
    ])("refuses %s", (_name, opts) => refused(run(opts)));

    it("M10: refuses swift resolved beside, not under, the pinned Xcode", () => {
      refused(run({ env: (dev) => ({ ...CI, FAKE_SWIFT_AT: `${dev}-beside/usr/bin/swift` }) }));
    });
  });

  describe("locally: the pin when it can, never a block", () => {
    it("on the pinned Xcode when it is installed", () => {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      judgedWith(r, r.dev);
      expect(r.stderr).not.toMatch(/WARN/);
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
