#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The Unreal SDK's source-quality smoke (#793 FR-010, #916). NOT A BUILD.
 *
 * No GitHub-hosted runner has an Unreal Engine, so the plugin cannot be
 * compiled or its automation tests run anywhere in CI. This smoke checks what
 * can be checked from the source alone, and says plainly what it cannot:
 *
 *   uplugin     Confeature.uplugin parses and declares the Confeature module;
 *   checklist   every entry of the documented API-surface checklist
 *               (ApiSurfaceChecklistTest.cpp) is declared in the public
 *               UConfeatureClient header as a UFUNCTION or UPROPERTY;
 *   fixtures    every fixture file the tests name exists in the shared corpus
 *               (packages/test-fixtures-sdk-parity/fixtures);
 *   derivation  the checklist cites its derivation and the date of the
 *               snapshot it was anchored to (constitution, Principle II).
 *
 * Unverified, always: that the plugin compiles, that its automation tests
 * pass, and its wire and parity behaviour.
 *
 *   node apps/sdk-unreal/scripts/source-smoke.mjs [<repo root>]
 *
 * Exit 0 when every check passes, 1 otherwise. A summary goes to stdout and,
 * when set, to $GITHUB_STEP_SUMMARY; its first line says this is not a build.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../../../tools/lib/is-entry.mjs";

const HERE = fileURLToPath(import.meta.url);
const PLUGIN = "apps/sdk-unreal/Plugins/Confeature";
const SOURCE = `${PLUGIN}/Source/Confeature`;
const CHECKLIST = `${SOURCE}/Private/Tests/ApiSurfaceChecklistTest.cpp`;
const CLIENT_HEADER = `${SOURCE}/Public/ConfeatureClient.h`;
const TESTS = `${SOURCE}/Private/Tests`;
const FIXTURES = "packages/test-fixtures-sdk-parity/fixtures";

export const NOT_A_BUILD =
  "unreal: SOURCE-QUALITY SMOKE — NOT A BUILD. The plugin is not compiled and its automation tests do not run (no Unreal Engine on hosted runners).";
export const UNVERIFIED = [
  "the plugin compiles",
  "its automation tests pass",
  "its wire-case and parity behaviour",
];

/** The uplugin parses and declares the Confeature module. */
export function checkUplugin(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return [`Confeature.uplugin does not parse: ${e.message}`];
  }
  const modules = Array.isArray(doc?.Modules) ? doc.Modules : [];
  return modules.some((m) => m?.Name === "Confeature")
    ? []
    : ["Confeature.uplugin declares no Confeature module"];
}

/** The names the checklist asserts: every `FName(TEXT("…"))` in the test. */
export function checklistNames(text) {
  return [
    ...new Set([...text.matchAll(/FName\(TEXT\("([A-Za-z_][A-Za-z0-9_]*)"\)\)/g)].map((m) => m[1])),
  ];
}

/**
 * Each name must be declared in the header as a member opened by a UFUNCTION
 * or UPROPERTY macro: walking up from the declaration, the macro is found
 * before the previous declaration ends (a line ending in `;`, `{` or `}`),
 * the way the checklist test finds the member by reflection. A macro may span
 * several lines; blank and comment lines are skipped.
 */
export function reflected(lines, i) {
  for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
    const line = lines[j].trim();
    if (line === "" || line.startsWith("//")) continue;
    // The macro opens its line: one named inside a comment's text is not it.
    if (/^(UFUNCTION|UPROPERTY)\s*\(/.test(line)) return true;
    if (/[;{}]$/.test(line)) return false;
  }
  return false;
}

/**
 * The header as the compiler reads it, for these checks: block comments and
 * `#if 0` regions blanked, line count kept (#793 re-review F9). A declaration
 * inside either is not declared.
 */
export function stripInactive(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*#if\s+0\b[\s\S]*?^[ \t]*#endif\b.*$/gm, blank);
}

export function checkChecklist(checklistText, headerText) {
  const names = checklistNames(checklistText);
  if (names.length === 0) return ["the checklist names no entry"];
  const lines = stripInactive(headerText).split("\n");
  const problems = [];
  for (const name of names) {
    const decl = new RegExp(`\\b${name}\\s*(?:\\(|;)`);
    const declared = lines.some(
      (line, i) => decl.test(line) && !/^\s*\/\//.test(line) && reflected(lines, i),
    );
    if (!declared)
      problems.push(`checklist entry ${name} is not a UFUNCTION/UPROPERTY in ConfeatureClient.h`);
  }
  return problems;
}

/** The checklist cites its derivation and an anchor date (YYYY-MM-DD). */
export function checkDerivation(checklistText) {
  const problems = [];
  if (!/derived from/i.test(checklistText))
    problems.push("the checklist does not cite its derivation");
  if (!/anchored[^\n]*\b20\d\d-\d\d-\d\d\b|\b20\d\d-\d\d-\d\d\b[^\n]*anchored/i.test(checklistText))
    problems.push("the checklist does not state the date of the snapshot it was anchored to");
  return problems;
}

/** Every `TEXT("<file>.json")` the tests name, by basename. */
export function fixtureNames(testTexts) {
  const out = new Set();
  for (const t of testTexts)
    for (const m of t.matchAll(/TEXT\("([A-Za-z0-9_.-]+\.json)"\)/g)) out.add(m[1]);
  return [...out].sort();
}

/**
 * The directory variables the tests load fixtures through, as FIXTURES-relative
 * paths (TestPaths.h: FindFixturesDirectory, FindUpstreamFixturesDirectory).
 */
const FIXTURE_DIRS = { FixturesDir: "", UpstreamDir: "upstream" };

/**
 * Every fixture the tests load, by the path they load it from (#930): the
 * `FixturesDir` / `UpstreamDir` argument followed by a `TEXT("<file>.json")`,
 * or by `FPaths::Combine(TEXT("<dir>"), TEXT("<file>.json"))`. A file-name
 * literal that is not in one of those forms is returned as `unresolved`: a
 * load the smoke cannot place is reported, never matched by name alone (a
 * same-named file in another directory used to pass).
 */
export function fixtureRefs(testTexts) {
  const paths = new Set();
  const unresolved = new Set();
  const dirs = Object.keys(FIXTURE_DIRS).join("|");
  const direct = new RegExp(`\\b(${dirs})\\s*,\\s*TEXT\\("([A-Za-z0-9_.-]+\\.json)"\\)`, "g");
  const nested = new RegExp(
    `\\b(${dirs})\\s*,\\s*FPaths::Combine\\(\\s*TEXT\\("([A-Za-z0-9_.-]+)"\\)\\s*,\\s*TEXT\\("([A-Za-z0-9_.-]+\\.json)"\\)\\s*\\)`,
    "g",
  );
  for (const t of testTexts) {
    const placed = new Set();
    for (const m of t.matchAll(direct)) {
      paths.add(join(FIXTURE_DIRS[m[1]], m[2]));
      placed.add(m[2]);
    }
    for (const m of t.matchAll(nested)) {
      paths.add(join(FIXTURE_DIRS[m[1]], m[2], m[3]));
      placed.add(m[3]);
    }
    for (const name of fixtureNames([t])) if (!placed.has(name)) unresolved.add(name);
  }
  return { paths: [...paths].sort(), unresolved: [...unresolved].sort() };
}

/** The fixtures check over test sources, given which FIXTURES-relative paths exist. */
export function checkFixtures(testTexts, exists) {
  const { paths, unresolved } = fixtureRefs(testTexts);
  if (paths.length === 0 && unresolved.length === 0) return ["the tests name no fixture file"];
  return [
    ...unresolved.map(
      (n) => `fixture ${n} is named but not loaded through FixturesDir or UpstreamDir`,
    ),
    ...paths.filter((p) => !exists(p)).map((p) => `fixture ${p} is missing from ${FIXTURES}`),
  ];
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function run(root) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const results = [];
  const check = (name, fn) => {
    let problems;
    try {
      problems = fn();
    } catch (e) {
      problems = [`could not run: ${e.message}`];
    }
    results.push({ name, problems });
  };
  check("uplugin", () => checkUplugin(read(`${PLUGIN}/Confeature.uplugin`)));
  check("checklist", () => checkChecklist(read(CHECKLIST), read(CLIENT_HEADER)));
  check("derivation", () => checkDerivation(read(CHECKLIST)));
  check("fixtures", () => {
    // Every test source under Private/Tests, subdirectories included (#930).
    const tests = walk(join(root, TESTS))
      .filter((f) => f.endsWith(".cpp") || f.endsWith(".h"))
      .map((f) => readFileSync(f, "utf8"));
    if (!existsSync(join(root, FIXTURES))) return [`${FIXTURES} does not exist`];
    return checkFixtures(tests, (p) => existsSync(join(root, FIXTURES, p)));
  });
  return results;
}

export function summary(results) {
  const ok = results.every((r) => r.problems.length === 0);
  const lines = [NOT_A_BUILD, ""];
  for (const r of results)
    lines.push(`- ${r.name}: ${r.problems.length === 0 ? "ok" : r.problems.join("; ")}`);
  lines.push(
    "",
    `Unverified: ${UNVERIFIED.join(", ")}.`,
    "",
    `unreal smoke: ${ok ? "passed" : "FAILED"}`,
  );
  return { ok, text: `${lines.join("\n")}\n` };
}

export function main(argv, { out = process.stdout } = {}) {
  const root = resolve(argv[0] ?? join(dirname(HERE), "..", "..", ".."));
  const { ok, text } = summary(run(root));
  out.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return ok ? 0 : 1;
}

// Both sides realpathed: through a symlinked checkout the old check never
// matched, and the smoke exited 0 having run nothing (#793 re-review F8).
if (isEntry(process.argv[1], HERE)) process.exitCode = main(process.argv.slice(2));
