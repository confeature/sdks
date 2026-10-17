// SPDX-License-Identifier: MIT

/**
 * scripts/dagger-precheck.sh against a stub `dagger` and a stub `docker` on
 * PATH (#865, FR-004). The precheck is the one home of "the local CLI equals
 * `engineVersion`": an exact match passes, and every near miss, every
 * unparsable answer and every unreadable pin is refused.
 *
 * The script runs from a copy inside a fixture tree, so each case can hand it
 * its own `dagger/dagger.json`.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProgram, writeWrapper } from "../lib/sandbox-bin.mjs";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../scripts/dagger-precheck.sh");

/**
 * The tools the precheck and the stubs run, linked into a sealed bin dir that is
 * the whole PATH. A runner image ships a real `docker` in /usr/bin (GitHub's
 * ubuntu-latest does), so no system directory may be on PATH: only the stubs
 * decide what `dagger` and `docker` answer.
 */
const TOOLS = ["bash", "dirname", "head", "cut"];

/** The first executable `name` on the host PATH; throws when there is none. */
function host(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  throw new Error(`the precheck test needs ${name} on PATH`);
}
const BASH = host("bash");

// `dagger version` prints STUB_OUT and exits STUB_RC; `docker info` exits DOCKER_RC.
const DAGGER = `#!/usr/bin/env bash
[ "$1" = version ] || exit 99
printf '%s\\n' "$STUB_OUT"
exit "\${STUB_RC:-0}"
`;
const DOCKER = `#!/usr/bin/env bash
exit "\${DOCKER_RC:-0}"
`;

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dagger-precheck-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dagger"));
  mkdirSync(join(root, "bin"));
  copyFileSync(SCRIPT, join(root, "scripts", "dagger-precheck.sh"));
  // Exec wrappers, never links, and O_EXCL writes under the tmpdir only: a
  // stub written over a link to a host program replaced the machine's npm on
  // 2026-10-16 (#932). A host path is only ever a wrapper's exec target.
  const bin = join(root, "bin");
  writeWrapper(bin, "node", process.execPath, BASH);
  for (const tool of TOOLS) writeWrapper(bin, tool, host(tool), BASH);
  writeProgram(bin, "dagger", DAGGER.replace(/^#!.*\n/, ""), "/usr/bin/env bash");
  writeProgram(bin, "docker", DOCKER.replace(/^#!.*\n/, ""), "/usr/bin/env bash");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const cli = (v) => `dagger ${v} (image://registry.dagger.io/engine:${v}) darwin/arm64/v8`;

function run({
  pin = { engineVersion: "v0.21.10" },
  out = cli("v0.21.10"),
  rc = 0,
  docker = 0,
  env = {},
  withDagger = true,
} = {}) {
  writeFileSync(
    join(root, "dagger", "dagger.json"),
    typeof pin === "string" ? pin : JSON.stringify(pin),
  );
  if (!withDagger) rmSync(join(root, "bin", "dagger"));
  const clean = { ...process.env };
  delete clean._EXPERIMENTAL_DAGGER_RUNNER_HOST;
  const r = spawnSync(BASH, [join(root, "scripts", "dagger-precheck.sh")], {
    env: {
      ...clean,
      PATH: join(root, "bin"),
      STUB_OUT: out,
      STUB_RC: String(rc),
      DOCKER_RC: String(docker),
      ...env,
    },
    encoding: "utf-8",
  });
  return { code: r.status, stderr: r.stderr };
}

describe("the CLI matches engineVersion", () => {
  it("exactly: exit 0, silent", () => {
    expect(run()).toEqual({ code: 0, stderr: "" });
  });
});

describe("a CLI that does not match is refused", () => {
  it.each([
    ["an older patch", cli("v0.21.9")],
    ["a prefix of the pin", cli("v0.21.1")],
    ["the pin as a prefix", cli("v0.21.100")],
    ["the old engine", cli("v0.20.5")],
    ["no v", cli("0.21.10")],
    ["the pin in the wrong field", "v0.21.10 dagger"],
    ["the pin only later in the line", "dagger dev (v0.21.10)"],
    ["the pin only on a later line", "dagger dev\ndagger v0.21.10"],
    ["a bare version line", "v0.21.10"],
    ["unparsable output", "garbage"],
    ["empty output", ""],
  ])("%s", (_name, out) => {
    const { code, stderr } = run({ out });
    expect(code).toBe(1);
    expect(stderr).toMatch(/dagger CLI is '.*', dagger\/dagger\.json pins v0\.21\.10/);
  });

  it("the hint installs the version read from dagger.json, never a written one", () => {
    const { code, stderr } = run({ pin: { engineVersion: "v9.8.7" }, out: cli("v9.8.6") });
    expect(code).toBe(1);
    expect(stderr).toContain(
      'https://dl.dagger.io/dagger/install.sh | DAGGER_VERSION=v9.8.7 BIN_DIR="$HOME/.local/bin" sh',
    );
  });

  it("a right answer from a failing `dagger version`", () => {
    const { code, stderr } = run({ rc: 3 });
    expect(code).toBe(1);
    expect(stderr).toContain("`dagger version` failed");
  });

  it("no dagger on PATH", () => {
    const { code, stderr } = run({ withDagger: false });
    expect(code).toBe(1);
    expect(stderr).toContain("dagger CLI not on PATH");
    expect(stderr).toContain("DAGGER_VERSION=v0.21.10");
  });

  it("_EXPERIMENTAL_DAGGER_RUNNER_HOST is set, even with a matching CLI", () => {
    const { code, stderr } = run({
      env: { _EXPERIMENTAL_DAGGER_RUNNER_HOST: "tcp://elsewhere:1234" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("_EXPERIMENTAL_DAGGER_RUNNER_HOST is set");
  });
});

describe("an unreadable pin is refused, even when the CLI echoes it", () => {
  it.each([
    ["missing", {}, cli("undefined")],
    ["empty", { engineVersion: "" }, "dagger  x"],
    ["latest", { engineVersion: "latest" }, cli("latest")],
    ["without the v", { engineVersion: "0.21.10" }, cli("0.21.10")],
    ["two components", { engineVersion: "v0.21" }, cli("v0.21")],
    ["with a suffix", { engineVersion: "v0.21.10-rc1" }, cli("v0.21.10-rc1")],
    ["not a string", { engineVersion: 21 }, cli("21")],
    ["not JSON", "{ engineVersion: v0.21.10", cli("v0.21.10")],
  ])("%s", (_name, pin, out) => {
    const { code, stderr } = run({ pin, out });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "dagger/dagger.json has no engineVersion of the form vMAJOR.MINOR.PATCH",
    );
  });
});

describe("node's own reason is shown, not swallowed", () => {
  it("a parse error", () => {
    const { code, stderr } = run({ pin: "{ engineVersion: v0.21.10" });
    expect(code).toBe(1);
    expect(stderr).toMatch(/\[dagger-precheck\] .*JSON/);
  });

  it("a malformed value", () => {
    const { code, stderr } = run({ pin: { engineVersion: "latest" }, out: cli("latest") });
    expect(code).toBe(1);
    expect(stderr).toContain('[dagger-precheck] engineVersion is "latest"');
  });
});

describe("docker", () => {
  it("an unreachable daemon is refused after the version passes", () => {
    const { code, stderr } = run({ docker: 1 });
    expect(code).toBe(1);
    expect(stderr).toContain("docker daemon not responding");
  });
});
