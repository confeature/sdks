// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEOWNERS_PATHS,
  ORG,
  codeownersFindings,
  verifyCodeowners,
} from "./verify-codeowners.mjs";

// CODEOWNERS names org teams only. Every rejected owner below is a mutation
// case: drop the team test and it turns green.

const GUARD = fileURLToPath(new URL("verify-codeowners.mjs", import.meta.url));

describe("codeownersFindings — one file", () => {
  it("accepts org teams, comments, blank lines and an ownerless pattern", () => {
    const text = [
      "# The maintainers own everything.",
      "",
      `*                 @${ORG}/sdk-maintainers`,
      `/.github/         @${ORG}/sdk-maintainers @${ORG}/release_team`,
      "/docs/\\#notes.md",
      `/apps/  @${ORG}/sdk-maintainers  # a trailing comment`,
    ].join("\n");
    expect(codeownersFindings(text)).toEqual([]);
  });

  it.each([
    ["a personal handle", "* @someone", "not-a-team"],
    ["a personal handle beside a team", `* @${ORG}/sdk-maintainers @someone`, "not-a-team"],
    ["an email address", "* someone@example.com", "not-a-team"],
    ["another organisation's team", "* @other-org/sdk-maintainers", "not-a-team"],
    ["a team of a lookalike org", `* @${ORG}x/sdk-maintainers`, "not-a-team"],
    ["a team with no slug", `* @${ORG}/`, "not-a-team"],
    ["a team slug with a path", `* @${ORG}/a/b`, "not-a-team"],
    ["an encoded address", "* someone&#64;example.com", "not-a-team"],
  ])("refuses %s", (_name, line, rule) => {
    expect(codeownersFindings(`# header\n${line}\n`)).toEqual([{ line: 2, rule }]);
  });

  it("an escaped \\# is part of the pattern, so the owner after it is still checked", () => {
    // MUTATION: treat every # as a comment and the personal handle below is
    // cut off with it, so the line passes.
    expect(codeownersFindings("/docs/\\#notes.md @someone\n")).toEqual([
      { line: 1, rule: "not-a-team" },
    ]);
    expect(codeownersFindings(`/docs/\\#notes.md @${ORG}/sdk-maintainers\n`)).toEqual([]);
    // An unescaped # still starts a comment: the handle after it is not an owner.
    expect(codeownersFindings(`* @${ORG}/sdk-maintainers # @someone\n`)).toEqual([]);
  });

  it("refuses a file that owns nothing (no rule names an owner)", () => {
    expect(codeownersFindings("# only a comment\n*\n")).toEqual([{ line: 0, rule: "no-owner" }]);
  });
});

describe("verifyCodeowners — the repository", () => {
  let root;
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeowners-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads every location GitHub reads", () => {
    expect(CODEOWNERS_PATHS).toEqual([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
  });

  it("passes one clean file", () => {
    write(".github/CODEOWNERS", `* @${ORG}/sdk-maintainers\n`);
    expect(verifyCodeowners(root)).toEqual({ files: 1, findings: [] });
  });

  it("fails closed when there is no CODEOWNERS file at all", () => {
    expect(verifyCodeowners(root).findings).toEqual([
      { path: "(CODEOWNERS)", line: 0, rule: "missing" },
    ]);
  });

  it("checks a second file too: GitHub ignores it, but it is still published", () => {
    write(".github/CODEOWNERS", `* @${ORG}/sdk-maintainers\n`);
    write("docs/CODEOWNERS", "* @someone\n");
    expect(verifyCodeowners(root).findings).toEqual([
      { path: "docs/CODEOWNERS", line: 1, rule: "not-a-team" },
    ]);
  });

  it("the CLI exits 1 on a personal handle and never prints the owner", () => {
    write(".github/CODEOWNERS", "* @someone-personal\n");
    const r = spawnSync(process.execPath, [GUARD], { cwd: root, timeout: 60_000 });
    expect(r.status).toBe(1);
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(out).toContain(".github/CODEOWNERS:1");
    expect(out).not.toContain("someone-personal");
  });

  it("the CLI exits 0 on a clean file", () => {
    write(".github/CODEOWNERS", `* @${ORG}/sdk-maintainers\n`);
    const r = spawnSync(process.execPath, [GUARD], { cwd: root, timeout: 60_000 });
    expect(r.status).toBe(0);
  });
});
