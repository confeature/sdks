#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * CODEOWNERS names organisation teams only — `@confeature/<team>` — never a
 * personal handle and never an email address.
 *
 * Why a team: a personal handle in CODEOWNERS is a public statement of who
 * reviews what, tied to one person's account. A team survives people joining
 * and leaving, and says nothing about anyone in particular.
 *
 *   node tools/repo-gates/verify-codeowners.mjs
 *
 * Reads every location GitHub reads (`.github/`, the root, `docs/`). GitHub
 * honours only the first one it finds, but every one of them is published, so
 * every one is checked. No file at all is a failure: a missing CODEOWNERS
 * means no review is required of anyone.
 *
 * Exit codes: 0 clean, 1 at least one finding. A finding is printed as
 * `path:line:rule`, never with the owner that matched.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The one organisation whose teams may own code here. */
export const ORG = "confeature";

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * A team of this organisation: `@confeature/` and a slug — letters, digits,
 * `-` and `_`, nothing after it. A lookalike org, a nested path or an empty
 * slug does not match.
 */
const TEAM = new RegExp(`^@${ORG}/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$`, "i");

/**
 * The tokens of one CODEOWNERS line: the pattern, then its owners. A `#`
 * starts a comment unless it is escaped (`\#`), which GitHub allows in a
 * pattern.
 */
function tokens(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[++i];
    } else if (c === "#") {
      break;
    } else if (c === " " || c === "\t") {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * The findings of one CODEOWNERS text, as `{ line, rule }`. `not-a-team` for
 * any owner that is not a team of `ORG` (a handle, an address, another org);
 * `no-owner` when no line names an owner at all.
 */
export function codeownersFindings(text) {
  const findings = [];
  let owned = 0;
  text.split("\n").forEach((raw, i) => {
    const [, ...owners] = tokens(raw);
    if (owners.length > 0) owned++;
    if (owners.some((o) => !TEAM.test(o))) findings.push({ line: i + 1, rule: "not-a-team" });
  });
  if (owned === 0) findings.push({ line: 0, rule: "no-owner" });
  return findings;
}

/** Every CODEOWNERS file under `root`, checked: `{ files, findings }`. */
export function verifyCodeowners(root) {
  const findings = [];
  let files = 0;
  for (const path of CODEOWNERS_PATHS) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      throw e;
    }
    files++;
    for (const f of codeownersFindings(text)) findings.push({ path, ...f });
  }
  if (files === 0) findings.push({ path: "(CODEOWNERS)", line: 0, rule: "missing" });
  return { files, findings };
}

const HERE = fileURLToPath(import.meta.url);

/** The CLI, over the current directory: returns the exit code. */
export function main(root = process.cwd()) {
  const { files, findings } = verifyCodeowners(root);
  if (findings.length === 0) {
    process.stdout.write(
      `verify-codeowners: ${String(files)} file(s), every owner is an @${ORG}/<team>\n`,
    );
    return 0;
  }
  for (const f of findings) process.stderr.write(`${f.path}:${String(f.line)}:${f.rule}\n`);
  process.stderr.write(
    `verify-codeowners: ${String(findings.length)} finding(s). Owners must be @${ORG}/<team>, never a person or an address.\n`,
  );
  return 1;
}

/** Whether this file is the process entry point, symlinks resolved on both sides. */
function isEntry(argv1) {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(HERE);
  } catch {
    process.stderr.write("verify-codeowners: realpath failed; comparing the paths unresolved\n");
    return resolve(argv1) === resolve(HERE);
  }
}

if (isEntry(process.argv[1])) process.exit(main());
