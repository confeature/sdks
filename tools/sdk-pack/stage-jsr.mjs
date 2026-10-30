#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Stage a unit's JSR package OUTSIDE the checkout (#935, architect ruling (b)).
 *
 *   node tools/sdk-pack/stage-jsr.mjs --unit deno --version 0.1.1 --out "$RUNNER_TEMP/jsr-stage"
 *
 * sdk-publish.yml's pack-jsr job runs it, dry-runs `deno publish` in the
 * stage, tars the stage and hands the tar to publish-jsr, which publishes
 * those same bytes. The stage holds exactly:
 *   - jsr.json: the unit's, with `imports` set to the one mapping of each
 *     BUNDLED workspace unit to its copy (`./src/_shared/index.ts`);
 *   - README.md, and LICENSE (the unit's, else the repository's);
 *   - src/**: the unit's TypeScript source, no tests;
 *   - src/_shared/**: the bundled unit's TypeScript source, no tests.
 * No package.json, no node_modules, no lockfile: deno resolves nothing
 * through a workspace or a registry, so what the dry run checks is what JSR
 * gets, and npm's bundle and JSR's package carry the same shared code.
 *
 * Refused (exit 1, one line on stderr):
 *   - any problem tools/sdk-pack/jsr-unit.mjs finds in the manifest's JSR
 *     entries (version drift between jsr.json and the versionSource included);
 *   - `--version` other than the version the unit declares;
 *   - `--out` that exists and is not empty, or lies inside the repository;
 *   - a staged specifier that is not relative (to a staged .ts file), a
 *     bundled unit or a NODE_BUILTINS name: npm:, jsr:, http(s):, bare names;
 *   - a non-.ts file in a copied source tree, or a staged file list that is
 *     not exactly the source lists (compared name by name).
 * Exit 2: usage error or unreadable input.
 *
 * Zero dependencies, like resolve-publish.mjs.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";
import {
  BUNDLED,
  JSR,
  JSR_CONFIG,
  jsrProblems,
  specifierProblem,
  specifiers,
} from "./jsr-unit.mjs";
import { declaredVersion, InputError, MANIFEST, Refusal } from "./resolve-publish.mjs";

/** Code-unit order, the same on every machine. */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under `dir`, relative to it, sorted; directories recursed. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort(byName);
}

const isTest = (f) => f.endsWith(".test.ts");

/** The source files of one tree to stage: its .ts files minus tests; anything else is refused. */
function sourceList(dir, what) {
  if (!existsSync(dir)) throw new Refusal(`${what}: ${dir} does not exist`);
  const files = listFiles(dir);
  const foreign = files.filter((f) => !f.endsWith(".ts"));
  if (foreign.length > 0) throw new Refusal(`${what}: ${foreign[0]} is not TypeScript source`);
  return files.filter((f) => !isTest(f));
}

const inside = (child, parent) => {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
};

function gitTop(root) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Stage unit `unitName` at `version` into `out`. Returns the staged file list. */
export function stageJsr({ root, unit: unitName, version, out }) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  } catch (e) {
    throw new InputError(`cannot read ${MANIFEST} (${e.code ?? e.message})`, { cause: e });
  }
  const units = Array.isArray(manifest.publish) ? manifest.publish : [];
  const primary = units.find((u) => u?.name === unitName && u?.registry !== JSR);
  const entry = units.find((u) => u?.name === unitName && u?.registry === JSR);
  if (primary === undefined || entry === undefined)
    throw new Refusal(`unit "${unitName}" has no jsr entry in ${MANIFEST}`);
  const problems = jsrProblems(manifest, root, (u) => declaredVersion(u, root, undefined));
  if (problems.length > 0) throw new Refusal(problems.join("; "));
  const declared = declaredVersion(primary, root, undefined);
  if (version !== declared)
    throw new Refusal(
      `--version ${version} differs from the ${declared} unit "${unitName}" declares`,
    );

  // Out of the tree: no package.json, workspace or node_modules above the stage.
  const top = gitTop(root);
  for (const tree of [root, top].filter((x) => x !== null))
    if (inside(out, tree)) throw new Refusal(`--out ${out} is inside the repository (${tree})`);
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Refusal(`--out ${out} exists and is not empty`);

  const unitDir = join(root, primary.path);
  const cfg = JSON.parse(readFileSync(join(unitDir, JSR_CONFIG), "utf8"));
  const own = sourceList(join(unitDir, "src"), `unit ${unitName}`);
  const expected = [JSR_CONFIG, "LICENSE", "README.md", ...own.map((f) => `src/${f}`)];
  const imports = {};
  const copies = [];
  for (const [spec, into] of Object.entries(BUNDLED)) {
    const dep = units.find((u) => u?.registry === "npm" && u.coordinates === spec);
    if (dep === undefined || typeof dep.path !== "string")
      throw new Refusal(`bundled ${spec} is not an npm unit of ${MANIFEST}`);
    if (own.some((f) => `src/${f}`.startsWith(`${into}/`)))
      throw new Refusal(`unit ${unitName} already has ${into}/, where ${spec} is bundled`);
    const files = sourceList(join(root, dep.path, "src"), spec);
    if (!files.includes("index.ts")) throw new Refusal(`bundled ${spec} has no src/index.ts`);
    imports[spec] = `./${into}/index.ts`;
    for (const f of files) {
      copies.push([join(root, dep.path, "src", f), `${into}/${f}`]);
      expected.push(`${into}/${f}`);
    }
  }
  for (const f of own) copies.push([join(unitDir, "src", f), `src/${f}`]);
  const license = existsSync(join(unitDir, "LICENSE"))
    ? join(unitDir, "LICENSE")
    : join(root, "LICENSE");
  copies.push([join(unitDir, "README.md"), "README.md"], [license, "LICENSE"]);

  mkdirSync(out, { recursive: true });
  for (const [from, to] of copies) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(from, join(out, to));
  }
  writeFileSync(join(out, JSR_CONFIG), `${JSON.stringify({ ...cfg, imports }, null, 2)}\n`);

  // What was staged, against the source lists, name by name.
  const got = listFiles(out);
  const want = [...expected].sort(byName);
  if (got.length !== want.length || got.some((f, i) => f !== want[i]))
    throw new Refusal(
      `the stage holds ${got.filter((f) => !want.includes(f)).join(", ") || "-"}, lacks ${want.filter((f) => !got.includes(f)).join(", ") || "-"}`,
    );
  // Every specifier of every staged file: relative to a staged .ts, bundled, or a built-in.
  for (const f of got.filter((x) => x.endsWith(".ts"))) {
    for (const s of specifiers(readFileSync(join(out, f), "utf8"))) {
      const why = specifierProblem(s);
      if (why !== null) throw new Refusal(`${f} ${why}`);
      if (s.startsWith(".")) {
        const target = resolve(dirname(join(out, f)), s);
        if (!inside(target, out) || !existsSync(target))
          throw new Refusal(`${f} imports ${s}, which is not a staged file`);
      }
    }
  }
  return got;
}

const FLAGS = Object.freeze({ "--unit": "unit", "--version": "version", "--out": "out" });

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    if (key === undefined || argv[i + 1] === undefined || key in args)
      throw new InputError("usage: stage-jsr.mjs --unit <name> --version <v> --out <dir>");
    args[key] = argv[i + 1];
  }
  if (Object.keys(args).length !== 3)
    throw new InputError("usage: stage-jsr.mjs --unit <name> --version <v> --out <dir>");
  return args;
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  try {
    const files = stageJsr({ root, ...parseArgs(process.argv.slice(2)) });
    console.log(`stage-jsr: ${files.length} file(s) staged`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`refused: ${e.message}`);
      return 1;
    }
    console.error(`stage-jsr: ${e?.message ?? e}`);
    return 2;
  }
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
