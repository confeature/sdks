// SPDX-License-Identifier: MIT

// The entry-point check (tools/lib/is-entry.mjs) and every script that hangs
// its main() on it. Only a subprocess can test a main-module guard: each script
// is run through a symlink, and must still give its verdict. With the old
// `resolve(argv[1]) === fileURLToPath(import.meta.url)` check, a symlinked
// path skipped main() and the script exited 0 having checked nothing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntry } from "../lib/is-entry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Run `script` (repo-relative) through a symlink in a fresh temp directory. */
function viaSymlink(script, ...args) {
  const dir = mkdtempSync(join(tmpdir(), "is-entry-"));
  const link = join(dir, script.split("/").pop());
  symlinkSync(join(ROOT, script), link);
  return spawnSync(process.execPath, [link, ...args], { encoding: "utf8", cwd: dir });
}

describe("every gate still runs when invoked through a symlinked path", () => {
  // Bad input, so a gate that ran must exit non-zero; one that skipped main()
  // exits 0 in silence.
  it.each([
    ["tools/sdk-pack/check-npm-tarball.mjs", [], 2],
    ["tools/sdk-pack/check-maven-release.mjs", [], 2],
    ["tools/sdk-pack/resolve-publish.mjs", [], 1],
    ["tools/sdk-pack/resolve-publish.mjs", ["--bogus", "x"], 2],
    // Their own copies were already right; they now share the one module.
    ["tools/repo-gates/verify-codeowners.mjs", [], 1],
    ["tools/repo-gates/verify-no-dup-json-keys.mjs", ["no-such.json"], 2],
    ["tools/manifest-author.mjs", ["no-such.json"], 2],
  ])("%s %j exits %i", (script, args, code) => {
    const r = viaSymlink(script, ...args);
    expect(r.status, r.stderr).toBe(code);
  });

  // These read the repository, which is clean, so their verdict is a line.
  it.each([
    ["tools/repo-gates/verify-workflows.mjs", /verify-workflows: ok/],
    ["tools/repo-gates/verify-declarations.mjs", /Gate declarations OK/],
  ])("%s gives its verdict", (script, verdict) => {
    const r = viaSymlink(script);
    expect(`${r.stdout}${r.stderr}`).toMatch(verdict);
    expect(r.status).toBe(0);
  });
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
