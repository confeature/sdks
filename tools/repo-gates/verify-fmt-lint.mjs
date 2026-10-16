#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The repository's format + lint gate, with two properties `vp check` does not
 * have: it only judges files this repository owns, and one stage cannot hide
 * the other.
 *
 * ## Only the files this repository owns
 *
 * `vp fmt` walks the working tree honouring `.gitignore`, so anything
 * UNTRACKED and NOT ignored is formatted as if it were ours. Coding agents,
 * editors and language servers drop exactly that shape into a checkout — their
 * own configuration directories, lock files, vendored bundles — and none of it
 * is this project's to format. A gate that fails on them trains people to skip
 * it.
 *
 * Ownership is asked of git, not of a name list: `git ls-files --others
 * --exclude-standard --directory` IS the set of paths this repository neither
 * tracks nor ignores, and it is handed to oxfmt as an extra `--ignore-path`.
 * The next tool to appear is excluded on the day it appears, with no edit
 * here. (Passing the tracked paths as operands instead would discard
 * `fmt.ignorePatterns`, which is how the vendored ConfigCat corpus and the
 * Deno CLI stay unformatted.)
 *
 * The generated ignore file must sit at the repository ROOT: oxfmt anchors a
 * pattern containing a slash to the directory of the ignore file that carries
 * it, so the same list written to a temp dir silently stops matching nested
 * paths.
 *
 * The bound, stated: a brand-new file is "untracked" until it is staged, so it
 * is skipped until `git add`. Nothing has to be committed first.
 *
 * ## Neither stage hides the other
 *
 * fmt does not short-circuit lint. Both stages run on every invocation and both
 * results are reported: a branch with one stray blank line should still learn,
 * in the same run, that it also has a lint error. The exit status is the worse
 * of the two.
 *
 * Exit codes:
 *   0 — formatting and lint both clean.
 *   1 — at least one stage failed; both were run and both were reported.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..", "..");

/**
 * Generated on every run and never committed (`.gitignore`). Root-relative on
 * purpose — see the anchoring note above. It ignores itself once written.
 */
export const UNTRACKED_IGNORE = ".vp-untracked-ignore";

/** The real side effects, injectable so the gate's own logic can be tested. */
const DEFAULTS = {
  root: ROOT,
  /** Run a command to completion in `cwd`: `{ status, stdout, error }`. */
  spawn: (cmd, args, opts) => spawnSync(cmd, args, { encoding: "utf8", ...opts }),
  write: (path, text) => writeFileSync(path, text, "utf8"),
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Paths present in the tree that git neither tracks nor ignores.
 * `--directory` collapses a wholly-untracked directory to one entry. A
 * non-git checkout (a release tarball) yields an empty list, with a warning:
 * the fmt stage then judges the whole tree.
 */
export function untrackedPaths(io = DEFAULTS) {
  const r = io.spawn("git", ["ls-files", "--others", "--exclude-standard", "--directory"], {
    cwd: io.root,
  });
  if (r.status !== 0) {
    io.warn(
      `verify:fmt-lint: could not ask git which files are untracked (${r.error?.message ?? `exit ${String(r.status)}`}); ` +
        "formatting the whole tree.",
    );
    return [];
  }
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

/** Run one Vite+ stage to completion, inheriting stdio. Returns its exit code. */
function stage(args, io) {
  const r = io.spawn("pnpm", ["exec", "vp", ...args], { cwd: io.root, stdio: "inherit" });
  if (r.error !== undefined) {
    io.error(`verify:fmt-lint: could not run \`vp ${args.join(" ")}\`: ${r.error.message}`);
    return 1;
  }
  // A stage killed by a signal has no exit code. Treating that as success is
  // how a gate reports green on a run that enforced nothing.
  return r.status ?? 1;
}

/** The gate: returns the exit code. Every side effect goes through `io`. */
export function run(overrides = {}) {
  const io = { ...DEFAULTS, ...overrides };
  const untracked = untrackedPaths(io);
  io.write(resolve(io.root, UNTRACKED_IGNORE), `${untracked.join("\n")}\n`);
  if (untracked.length > 0) {
    io.log(
      `verify:fmt-lint: excluding ${String(untracked.length)} untracked path(s) this repo does not own: ${untracked.join(", ")}`,
    );
  }

  // `--ignore-path` REPLACES the defaults once given, so `.gitignore` is passed
  // back explicitly.
  const fmt = stage(
    ["fmt", "--check", "--ignore-path", ".gitignore", "--ignore-path", UNTRACKED_IGNORE],
    io,
  );

  // Unconditional. This is the whole point of the file.
  const lint = stage(["lint"], io);

  const label = (code) => (code === 0 ? "ok" : "FAILED");
  io.log(`\nverify:fmt-lint: format ${label(fmt)}, lint ${label(lint)}`);
  if (fmt !== 0 || lint !== 0) {
    io.error("\nBoth stages ran; fix whichever is reported above.\n");
    return 1;
  }
  return 0;
}

if (isEntry(process.argv[1], HERE)) process.exit(run());
