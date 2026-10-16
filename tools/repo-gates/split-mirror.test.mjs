// SPDX-License-Identifier: MIT

// The mirror split (tools/sdk-pack/split-mirror.sh) on fixture repositories:
// a clean split bundles and prints its commit, every way personal data could
// reach a public mirror is refused, and the same history splits to the same
// commit every time (a mirror only ever fast-forwards).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/sdk-pack/split-mirror.sh");

const NOREPLY = "6215184+someone@users.noreply.github.com";
// No machine configuration reaches a fixture: no global identity, hooks or
// signing. Fixed dates, so two fixtures with the same history are the same.
const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Someone",
  GIT_COMMITTER_NAME: "Someone",
  GIT_AUTHOR_DATE: "2026-10-16T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-16T10:00:00Z",
};

const git = (cwd, args, env = {}) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...BASE_ENV, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * A repository whose commits are `[{ file, author?, committer?, message? }]`,
 * each adding one file. Emails default to a noreply address.
 */
function repo(commits) {
  const dir = mkdtempSync(join(tmpdir(), "split-mirror-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  for (const [i, c] of commits.entries()) {
    mkdirSync(join(dir, dirname(c.file)), { recursive: true });
    writeFileSync(join(dir, c.file), `${String(i)}\n`);
    git(dir, ["add", "--", c.file]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", c.message ?? `commit ${String(i)}`], {
      GIT_AUTHOR_EMAIL: c.author ?? NOREPLY,
      GIT_COMMITTER_EMAIL: c.committer ?? NOREPLY,
    });
  }
  return dir;
}

const split = (cwd, args) =>
  spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", env: BASE_ENV });

const UNIT = [
  { file: "apps/sdk-x/a.txt" },
  { file: "other/b.txt" },
  { file: "apps/sdk-x/c.txt", message: "add c\n\nCo-Authored-By: Bot <noreply@anthropic.com>" },
];
// Each case spawns git a dozen times; a CI runner is many times slower than a laptop.
const T = { timeout: 30_000 };

describe("split-mirror.sh", T, () => {
  it("bundles the unit's history as main and prints the split commit last", () => {
    const dir = repo(UNIT);
    const out = join(dir, "..", `${String(Date.now())}-x.bundle`);
    const r = split(dir, ["apps/sdk-x", out]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const sha = r.stdout.trim().split("\n").pop();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The bundle is valid, carries main at that commit, and holds only the unit.
    const clone = mkdtempSync(join(tmpdir(), "split-mirror-clone-"));
    git(clone, ["init", "--quiet", "--bare"]);
    git(clone, ["bundle", "verify", out]);
    expect(git(clone, ["bundle", "list-heads", out])).toBe(`${sha} refs/heads/main`);
    git(clone, ["fetch", "--quiet", out, "refs/heads/main:refs/heads/main"]);
    expect(git(clone, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toEqual([
      "a.txt",
      "c.txt",
    ]);
    expect(git(clone, ["rev-list", "--count", "main"])).toBe("2");
  });

  it("splits the same history to the same commit, every time", () => {
    const a = repo(UNIT);
    const b = repo(UNIT);
    const first = split(a, ["apps/sdk-x", join(a, "..", "a1.bundle")]);
    const again = split(a, ["apps/sdk-x", join(a, "..", "a2.bundle")]);
    const other = split(b, ["apps/sdk-x", join(b, "..", "b.bundle")]);
    expect([first.status, again.status, other.status]).toEqual([0, 0, 0]);
    expect(again.stdout).toBe(first.stdout);
    expect(other.stdout).toBe(first.stdout);
  });

  it("ignores a personal address on a commit outside the unit", () => {
    const dir = repo([...UNIT, { file: "other/d.txt", author: "person@example.com" }]);
    expect(split(dir, ["apps/sdk-x", join(dir, "..", "o.bundle")]).status).toBe(0);
  });

  it.each([
    ["an author", { author: "person@example.com" }, /author/],
    ["a committer", { committer: "person@example.com" }, /committer/],
    [
      "a noreply address of another shape",
      { author: "someone@users.noreply.github.com" },
      /author/,
    ],
    [
      "a co-author trailer",
      { message: "fix\n\nCo-Authored-By: Person <person@example.com>" },
      /message/,
    ],
    ["an address in the body", { message: "reported by person@example.org" }, /message/],
  ])("refuses %s with a personal address, and writes no bundle", (_, commit, why) => {
    const dir = repo([...UNIT, { file: "apps/sdk-x/e.txt", ...commit }]);
    const out = join(dir, "..", `${String(Date.now())}-refused.bundle`);
    const r = split(dir, ["apps/sdk-x", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(why);
    // The address itself is never echoed: the log of a public run is public.
    expect(r.stderr).not.toMatch(/person@example/);
    expect(spawnSync("test", ["-e", out]).status).toBe(1);
  });

  it.each([["noreply@github.com"], [NOREPLY]])("accepts %s as an author and committer", (email) => {
    const dir = repo([{ file: "apps/sdk-x/a.txt", author: email, committer: email }]);
    expect(split(dir, ["apps/sdk-x", join(dir, "..", "n.bundle")]).status).toBe(0);
  });

  it("accepts version specifiers that look like addresses but are not", () => {
    const dir = repo([
      { file: "apps/sdk-x/a.txt", message: "pin npm@11.20.0 and actions/checkout@v4" },
    ]);
    expect(split(dir, ["apps/sdk-x", join(dir, "..", "v.bundle")]).status).toBe(0);
  });

  it("refuses a prefix with no history", () => {
    const dir = repo(UNIT);
    const r = split(dir, ["apps/absent", join(dir, "..", "e.bundle")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no history/);
  });

  it("refuses a unit deleted at HEAD, and a file in its place", () => {
    const dir = repo(UNIT);
    git(dir, ["rm", "--quiet", "-r", "apps/sdk-x"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "drop the unit"], {
      GIT_AUTHOR_EMAIL: NOREPLY,
      GIT_COMMITTER_EMAIL: NOREPLY,
    });
    expect(split(dir, ["apps/sdk-x", join(dir, "..", "d.bundle")]).status).toBe(1);
    expect(split(dir, ["other/b.txt", join(dir, "..", "f.bundle")]).status).toBe(1);
  });

  it("refuses a shallow clone, whose split would be another commit", () => {
    const src = repo(UNIT);
    const dir = mkdtempSync(join(tmpdir(), "split-mirror-shallow-"));
    git(dir, ["clone", "--quiet", "--depth", "1", `file://${src}`, "c"]);
    const r = split(join(dir, "c"), ["apps/sdk-x", join(dir, "s.bundle")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/shallow/);
  });

  it.each([[[]], [["apps/sdk-x"]], [["", "x.bundle"]], [["a", "b", "c"]]])(
    "exits 2 on usage %j",
    (args) => {
      const dir = repo(UNIT);
      expect(split(dir, args).status).toBe(2);
    },
  );
});
