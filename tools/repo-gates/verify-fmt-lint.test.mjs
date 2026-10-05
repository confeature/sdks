// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { UNTRACKED_IGNORE, run, untrackedPaths } from "./verify-fmt-lint.mjs";

// The fmt + lint gate, with its processes injected: what it runs, in which
// order, and what it makes of each result. The two properties it exists for
// are each a mutation case: lint runs even when fmt fails, and a stage killed
// by a signal is a failure.

/**
 * A fake world: `git` answers `gitOut` (or fails), each `vp` stage answers the
 * next of `stages`. Every call and every write is recorded.
 */
function world({ gitStatus = 0, gitOut = "", stages = [{ status: 0 }, { status: 0 }] } = {}) {
  const calls = [];
  const writes = [];
  const said = [];
  const queue = [...stages];
  const io = {
    root: "/repo",
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git") return { status: gitStatus, stdout: gitOut };
      return queue.shift() ?? { status: 0 };
    },
    write: (path, text) => writes.push([path, text]),
    log: (m) => said.push(m),
    warn: (m) => said.push(m),
    error: (m) => said.push(m),
  };
  return { io, calls, writes, said };
}

describe("verify-fmt-lint", () => {
  it("passes when both stages pass, and runs fmt then lint with the right ignore files", () => {
    const w = world();
    expect(run(w.io)).toBe(0);
    expect(w.calls).toEqual([
      "git ls-files --others --exclude-standard --directory",
      `pnpm exec vp fmt --check --ignore-path .gitignore --ignore-path ${UNTRACKED_IGNORE}`,
      "pnpm exec vp lint",
    ]);
  });

  it("runs lint even when fmt fails, and fails the run", () => {
    // MUTATION: return after a failed fmt stage and lint is never called.
    const w = world({ stages: [{ status: 1 }, { status: 0 }] });
    expect(run(w.io)).toBe(1);
    expect(w.calls.at(-1)).toBe("pnpm exec vp lint");
    expect(w.said.join("\n")).toMatch(/format FAILED, lint ok/);
  });

  it("fails on a lint failure alone", () => {
    expect(run(world({ stages: [{ status: 0 }, { status: 1 }] }).io)).toBe(1);
  });

  it("a stage killed by a signal (no exit code) is a failure, never a pass", () => {
    // MUTATION: `r.status ?? 0` and this run is green.
    expect(run(world({ stages: [{ status: null }, { status: 0 }] }).io)).toBe(1);
  });

  it("a stage that cannot start is a failure", () => {
    const w = world({ stages: [{ status: null, error: new Error("ENOENT") }, { status: 0 }] });
    expect(run(w.io)).toBe(1);
    expect(w.said.join("\n")).toMatch(/could not run `vp fmt/);
  });

  it("hands what git neither tracks nor ignores to oxfmt, at the repository root", () => {
    const w = world({ gitOut: ".agents/\nskills-lock.json\n" });
    expect(run(w.io)).toBe(0);
    expect(w.writes).toEqual([[`/repo/${UNTRACKED_IGNORE}`, ".agents/\nskills-lock.json\n"]]);
  });

  it("outside a git checkout, excludes nothing and says so", () => {
    const w = world({ gitStatus: 128 });
    expect(untrackedPaths(w.io)).toEqual([]);
    expect(w.said.join("\n")).toMatch(/could not ask git/);
  });
});
