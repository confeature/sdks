#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Whether a packed npm tarball is the package it claims to be, and usable.
 *
 *   node tools/sdk-pack/check-npm-tarball.mjs <file.tgz> <name> <version>
 *
 * `sdk-publish.yml`'s pack job runs it on the one tarball the publish job will
 * upload. It refuses, before any credential exists, a tarball that:
 *   - is not `<name>@<version>`;
 *   - still carries a `workspace:` range (pnpm rewrites them while packing);
 *   - ships no LICENSE at its root;
 *   - declares no entry point (`exports`, `main` or `module`);
 *   - names a file in `main`, `module`, `types`, `typings`, `browser`, `unpkg`,
 *     `jsdelivr`, `bin` or `exports` that it does not contain;
 *   - contains a file that never belongs in a published package: a secret, a
 *     `node_modules/` or `.git/` tree, or a test (UNPUBLISHABLE_*).
 *
 * The last two exist because @confeature/sdk-angular once packed its source
 * manifest, which declares no entry point, next to a `dist/` that held the
 * real one (#899): npm would have accepted it, and no import would resolve.
 * The same check found sdk-node and sdk-browser-js declaring `dist/index.d.ts`
 * types their build never emits, and an IIFE path no build writes.
 *
 * Exit codes: 0 accepted, 1 refused, 2 usage error or unreadable tarball.
 * Zero dependencies: `tar` is on every runner.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const PATH_FIELDS = ["main", "module", "types", "typings", "browser", "unpkg", "jsdelivr", "bin"];

/** Every string leaf of a field that names a file (patterns are skipped). */
function referencedPaths(manifest) {
  const out = [];
  const walk = (value, where) => {
    if (typeof value === "string") {
      if (!value.includes("*")) out.push([where, value]);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${where} > ${k}`);
    }
  };
  for (const field of [...PATH_FIELDS, "exports"]) walk(manifest[field], field);
  return out;
}

const normalise = (p) => p.replace(/^\.\//, "");

/**
 * Files no published package of ours ever carries: a registry keeps what it is
 * given, so the first publish of one is permanent. Deliberately small, each a
 * category, never a guess about a build's layout:
 *   - secrets: `.env*`, `.npmrc` (it can hold a token), private keys and
 *     certificate stores (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`,
 *     `id_ed25519*`);
 *   - a dependency tree or VCS data: a `node_modules/` or `.git/` directory;
 *   - tests: a `__tests__/`, `tests/`, `fixtures/` or `__fixtures__/`
 *     directory, or a `*.test.*` / `*.spec.*` file. The SDKs ship `dist/`,
 *     README and LICENSE; a test in the tarball is a build that swept up its
 *     source tree.
 */
const UNPUBLISHABLE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:test|spec)\.[^/]+)$/;
const UNPUBLISHABLE_DIR = new Set([
  "node_modules",
  ".git",
  "__tests__",
  "tests",
  "fixtures",
  "__fixtures__",
]);
const unpublishable = (path) => {
  const parts = path.split("/");
  return (
    UNPUBLISHABLE_NAME.test(parts.at(-1)) ||
    parts.slice(0, -1).some((d) => UNPUBLISHABLE_DIR.has(d))
  );
};

/**
 * The problems with a packed manifest and its file list (paths relative to
 * the package root). Empty when the tarball may be published.
 */
export function tarballProblems(manifest, files, name, version) {
  const problems = [];
  if (manifest.name !== name || manifest.version !== version) {
    problems.push(`the tarball is ${manifest.name}@${manifest.version}, not ${name}@${version}`);
  }
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) {
        problems.push(`unrewritten workspace range: ${field}.${dep} = ${String(range)}`);
      }
    }
  }
  const present = new Set(files.map(normalise));
  if (![...present].some((f) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(f))) {
    problems.push("no LICENSE at the package root");
  }
  if (manifest.exports === undefined && !manifest.main && !manifest.module) {
    problems.push("no entry point: the manifest declares no exports, main or module");
  }
  for (const f of present)
    if (unpublishable(f))
      problems.push(
        `${f}: a secret, a dependency tree, VCS data or a test file has no place in a published package`,
      );
  for (const [where, path] of referencedPaths(manifest)) {
    if (!present.has(normalise(path)))
      problems.push(`${where} names ${path}, which is not in the tarball`);
  }
  return problems;
}

function tar(args) {
  const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tar ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

export function main(argv) {
  const [file, name, version] = argv;
  if (!file || !name || !version || argv.length !== 3) {
    console.error("usage: check-npm-tarball.mjs <file.tgz> <name> <version>");
    return 2;
  }
  let manifest;
  let files;
  try {
    files = tar(["-tzf", file])
      .split("\n")
      .filter((l) => l.startsWith("package/") && !l.endsWith("/"))
      .map((l) => l.slice("package/".length));
    manifest = JSON.parse(tar(["-xOzf", file, "package/package.json"]));
  } catch (e) {
    console.error(`::error::cannot read ${file}: ${e.message}`);
    return 2;
  }
  const problems = tarballProblems(manifest, files, name, version);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length === 0)
    console.log(`${name}@${version}: ${files.length} files, entry points present`);
  return problems.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url)))
  process.exit(main(process.argv.slice(2)));
