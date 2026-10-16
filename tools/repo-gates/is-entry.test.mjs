// SPDX-License-Identifier: MIT

// The entry-point check (tools/lib/is-entry.mjs) and every script that hangs
// its main() on it. Only a subprocess can test a main-module guard: each script
// is run through a symlink, and must still give its verdict. With the old
// `resolve(argv[1]) === fileURLToPath(import.meta.url)` check, a symlinked
// path skipped main() and the script exited 0 having checked nothing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isEntry } from "../lib/is-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A crash is not a verdict: an uncaught error prints a stack, never the script's own words. */
const CRASH = /ERR_[A-Z_]+|^\s+at .+:\d+:\d+\)?$|Error \[/m;

/** Run `script` (repo-relative) through a symlink in a fresh temp directory. */
function viaSymlink(script, ...args) {
  const dir = mkdtempSync(join(tmpdir(), "is-entry-"));
  dirs.push(dir);
  const link = join(dir, script.split("/").pop());
  symlinkSync(join(ROOT, script), link);
  return spawnSync(process.execPath, [link, ...args], { encoding: "utf8", cwd: dir });
}

describe("every gate still runs when invoked through a symlinked path", () => {
  // Bad input, so a gate that ran must exit non-zero; one that skipped main()
  // exits 0 in silence.
  it.each([
    ["tools/sdk-pack/check-npm-tarball.mjs", [], 2, /usage: check-npm-tarball/],
    ["tools/sdk-pack/check-maven-release.mjs", [], 2, /usage: check-maven-release/],
    ["tools/sdk-pack/resolve-publish.mjs", [], 1, /refused: pass exactly one of --tag or --unit/],
    ["tools/sdk-pack/resolve-publish.mjs", ["--bogus", "x"], 2, /usage: resolve-publish/],
    // Their own copies were already right; they now share the one module.
    ["tools/repo-gates/verify-codeowners.mjs", [], 1, /verify-codeowners: 1 finding/],
    [
      "tools/repo-gates/verify-no-dup-json-keys.mjs",
      ["no-such.json"],
      2,
      /no-such\.json: cannot read/,
    ],
    ["tools/manifest-author.mjs", ["no-such.json"], 2, /manifest-author: no-such\.json/],
  ])("%s %j exits %i with its own verdict, not a crash", (script, args, code, verdict) => {
    const r = viaSymlink(script, ...args);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(CRASH);
    expect(out).toMatch(verdict);
    expect(r.status, out).toBe(code);
  });

  // These read the repository, which is clean, so their verdict is a line.
  it.each([
    ["tools/repo-gates/verify-workflows.mjs", /verify-workflows: ok/],
    ["tools/repo-gates/verify-declarations.mjs", /Gate declarations OK/],
    // Its verdict depends on the working tree; that it gives one is the point.
    [
      "tools/repo-gates/verify-fmt-lint.mjs",
      /verify:fmt-lint: format (?:ok|FAILED), lint (?:ok|FAILED)/,
    ],
  ])(
    "%s gives its verdict, not a crash",
    (script, verdict) => {
      const r = viaSymlink(script);
      const out = `${r.stdout}${r.stderr}`;
      expect(out).not.toMatch(CRASH);
      expect(out).toMatch(verdict);
      expect([0, 1]).toContain(r.status);
    },
    60_000,
  );
});

describe("isEntry", () => {
  const throwing = () => {
    throw new Error("EACCES");
  };

  it("is the entry point under --preserve-symlinks, where only ONE side would be realpathed", () => {
    // Under --preserve-symlinks argv[1] and the module's own path can BOTH be
    // symlinked paths; only realpathing both sides makes them compare equal.
    // MUTATION: compare real(argv1) against a bare `here` and this is false.
    const real = (p) =>
      p === "/links/guard.mjs" || p === "/sym/repo/guard.mjs" ? "/real/guard.mjs" : p;
    expect(isEntry("/links/guard.mjs", "/sym/repo/guard.mjs", { real, warn: () => {} })).toBe(true);
    expect(isEntry("/links/other.mjs", "/sym/repo/guard.mjs", { real, warn: () => {} })).toBe(
      false,
    );
  });

  it("a realpath failure falls back to comparing resolved paths, and says so", () => {
    const warned = [];
    expect(isEntry("/a/x.mjs", "/a/x.mjs", { real: throwing, warn: (m) => warned.push(m) })).toBe(
      true,
    );
    expect(warned).toHaveLength(1);
    expect(isEntry("/elsewhere.mjs", "/a/x.mjs", { real: throwing, warn: () => {} })).toBe(false);
  });

  it("no argv[1] (an importer) is not the entry point", () => {
    expect(isEntry(undefined, "/a/x.mjs", { real: throwing })).toBe(false);
  });
});
