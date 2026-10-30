// SPDX-License-Identifier: MIT

/**
 * The JSR target of a publish unit (#935), and every check that holds it.
 *
 * A unit that also publishes to JSR has a SECOND `publish[]` entry in
 * `dagger/sdk-manifest.json`, with the same `name` and `registry: "jsr"`.
 * Same name, so the one tag (`sdk-<name>-v<version>`) publishes both, and the
 * operator's applier derives the `sdk-publish-jsr` environment's tag policy
 * from that entry the way it does for every registry. The entry is held to:
 *
 *   - it follows a primary entry of the same name (any registry but jsr), and
 *     a name has at most one primary and one jsr entry;
 *   - its keys are exactly JSR_ENTRY_KEYS: no gate, no `after`, no mirror of
 *     its own; the primary's gate and order apply to both;
 *   - its `path` and `versionSource` are the primary's, so both registries get
 *     the same version from the same tag;
 *   - its coordinates are a JSR package name (`@scope/name`);
 *   - `<path>/jsr.json` is that package: the same name, license MIT, the
 *     version the unit declares (the drift guard), only JSR_CONFIG_KEYS;
 *     `exports` naming TypeScript source files under `src/` that exist, never
 *     `dist/`; and NO `imports` (architect ruling, #935 (a)): a workspace unit
 *     the source imports is BUNDLED, its TypeScript source copied into the
 *     package by tools/sdk-pack/stage-jsr.mjs, which writes the one mapping
 *     itself. A registry specifier (`npm:`, `jsr:`) for a workspace unit would
 *     ship JSR a different copy of it than npm's bundle, and a version floor
 *     cannot see content drift;
 *   - every specifier the exported source imports is relative, a BUNDLED
 *     workspace unit, or one of NODE_BUILTINS: nothing that resolves through
 *     node_modules or a registry.
 *
 * Zero dependencies: resolve-publish.mjs runs it before `pnpm install`, and
 * verify-workflows.mjs runs it on every `pnpm run verify`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

export const JSR = "jsr";
export const JSR_ENTRY_KEYS = Object.freeze([
  "name",
  "registry",
  "coordinates",
  "path",
  "versionSource",
]);
export const JSR_CONFIG_KEYS = Object.freeze(["name", "version", "license", "exports", "publish"]);
export const JSR_CONFIG = "jsr.json";
/** A JSR scope is 2 to 32 characters, a package 2 to 20 (jsr.io/docs/publishing-packages). */
export const JSR_NAME = /^@[a-z0-9][a-z0-9-]{1,31}\/[a-z0-9][a-z0-9-]{1,19}$/;
/** An export target: TypeScript source under `./src/`, no `..`, never the build output. */
const EXPORT_TARGET =
  /^\.\/src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.ts$/;
/**
 * The workspace units a JSR package bundles, each by its import specifier:
 * where stage-jsr.mjs copies its `src/` (inside the package's `src/`).
 */
export const BUNDLED = Object.freeze({ "@confeature/sdk-shared": "src/_shared" });
/** The runtime built-ins the source may import: not dependencies, no registry. */
export const NODE_BUILTINS = Object.freeze(["node:fs"]);
/** Why a specifier may not appear in a JSR package's source, or null. */
export function specifierProblem(s) {
  if (s.startsWith("./") || s.startsWith("../"))
    return s.endsWith(".ts") ? null : `relative import ${s} does not name a .ts file`;
  if (Object.hasOwn(BUNDLED, s) || NODE_BUILTINS.includes(s)) return null;
  return `imports ${s}, which is neither relative, a bundled workspace unit (${Object.keys(BUNDLED).join(", ")}) nor one of ${NODE_BUILTINS.join(", ")}`;
}

const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`;

/** Every module specifier a TypeScript file imports or re-exports, comments aside. */
export function specifiers(text) {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const out = [];
  const re =
    /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function tsFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Every problem of the manifest's JSR entries, as strings (empty when none).
 * `declared(unit)` is the version a unit declares (resolve-publish's
 * declaredVersion); it may throw, which is reported as a problem.
 */
export function jsrProblems(manifest, root, declared) {
  const units = Array.isArray(manifest?.publish) ? manifest.publish : [];
  const out = [];
  const seen = new Map();
  for (const [i, u] of units.entries()) {
    const key = `${String(u?.name)}\u0000${String(u?.registry)}`;
    if (seen.has(key)) out.push(`publish[${i}]: unit ${u?.name} has two ${u?.registry} entries`);
    seen.set(key, i);
  }
  for (const name of new Set(units.map((u) => u?.name))) {
    const named = units.filter((u) => u?.name === name);
    const primaries = named.filter((u) => u?.registry !== JSR);
    if (named.length > 1 && primaries.length > 1)
      out.push(
        `unit ${String(name)}: only a jsr entry may share a unit's name (${primaries.length} others do)`,
      );
  }
  for (const [i, u] of units.entries()) {
    if (u?.registry !== JSR) continue;
    const at = `publish[${i}] (${String(u?.name)}, jsr)`;
    const primary = units.find((p) => p?.name === u.name && p?.registry !== JSR);
    if (primary === undefined || units.indexOf(primary) > i) {
      out.push(`${at}: a jsr entry follows the unit's primary entry of the same name`);
      continue;
    }
    const keys = Object.keys(u);
    if (canonical([...keys].sort()) !== canonical([...JSR_ENTRY_KEYS].sort()))
      out.push(`${at}: its keys are ${keys.join(",")}, not exactly ${JSR_ENTRY_KEYS.join(",")}`);
    if (typeof u.coordinates !== "string" || !JSR_NAME.test(u.coordinates))
      out.push(
        `${at}: coordinates ${JSON.stringify(u.coordinates)} is not a JSR package name (@scope/name)`,
      );
    if (u.path !== primary.path)
      out.push(
        `${at}: path ${JSON.stringify(u.path)} is not the primary's ${JSON.stringify(primary.path)}`,
      );
    if (canonical(u.versionSource) !== canonical(primary.versionSource))
      out.push(`${at}: versionSource differs from the primary's: one tag, one version`);
    if (typeof primary.path !== "string") continue;
    out.push(...configProblems(at, u, primary, root, declared));
  }
  return out;
}

function configProblems(at, u, primary, root, declared) {
  const out = [];
  const file = posix.join(primary.path, JSR_CONFIG);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (e) {
    return [`${at}: cannot read ${file} (${e.code ?? e.message})`];
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
    return [`${at}: ${file} is not an object`];
  for (const k of Object.keys(cfg))
    if (!JSR_CONFIG_KEYS.includes(k))
      out.push(`${at}: ${file} has ${k}, which is not one of ${JSR_CONFIG_KEYS.join(",")}`);
  if (cfg.name !== u.coordinates)
    out.push(
      `${at}: ${file} names ${JSON.stringify(cfg.name)}, the entry ${JSON.stringify(u.coordinates)}`,
    );
  if (cfg.license !== "MIT")
    out.push(`${at}: ${file} license is ${JSON.stringify(cfg.license)}, not MIT`);
  let version;
  try {
    version = declared(primary);
  } catch (e) {
    out.push(`${at}: ${e.message}`);
  }
  if (version !== undefined && cfg.version !== version)
    out.push(
      `${at}: ${file} version ${JSON.stringify(cfg.version)} drifts from ${version}, which ${primary.versionSource?.file ?? "the unit"} declares`,
    );
  const exp = cfg.exports;
  const targets =
    typeof exp === "string"
      ? [exp]
      : exp !== null && typeof exp === "object" && !Array.isArray(exp)
        ? Object.values(exp)
        : [];
  if (targets.length === 0) out.push(`${at}: ${file} exports nothing`);
  const dirs = new Set();
  for (const t of targets) {
    if (typeof t !== "string" || !EXPORT_TARGET.test(t)) {
      out.push(
        `${at}: ${file} exports ${JSON.stringify(t)}, which is not TypeScript source under ./src/`,
      );
      continue;
    }
    if (!existsSync(join(root, primary.path, t)))
      out.push(`${at}: ${file} exports ${t}, which does not exist`);
    else dirs.add(dirname(join(root, primary.path, t)));
  }
  if (cfg.imports !== undefined)
    out.push(
      `${at}: ${file} maps imports; a workspace unit is bundled, and stage-jsr.mjs writes the one mapping (never npm: or jsr:)`,
    );
  for (const d of dirs)
    for (const f of tsFiles(d))
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        const why = specifierProblem(s);
        if (why !== null) out.push(`${at}: ${relative(root, f)} ${why}`);
      }
  return out;
}
