#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Whether a release tag may publish, and what it publishes.
 *
 *   node tools/sdk-pack/resolve-publish.mjs --tag sdk-node-v0.1.0      a release
 *   node tools/sdk-pack/resolve-publish.mjs --unit node                a dry run
 *
 * The one place that decision is made. `sdk-publish.yml`'s setup job runs it,
 * and so does the `/release` skill before it pushes a tag. Nothing else may
 * re-check a tag, a version or a gate.
 *
 * The publish table is `publish[]` in `dagger/sdk-manifest.json`: one unit per
 * releasable package. A tag is `tagFormat` from that file, `sdk-<name>-v<semver>`.
 * It is refused, before any job that can reach a credential, when:
 *   - it is not shaped as `tagFormat` (strict regex, semver without build metadata),
 *     or a dry run's `--version` is not that semver;
 *   - it names no unit;
 *   - the unit's registry is `none`, or it is `blockedBy` an open issue;
 *   - the unit's gate is `pending` (nothing ships without a gate);
 *   - its version differs from the one the unit's `versionSource` declares;
 *   - (tag mode) a unit listed in `after` is not on its registry at the version
 *     this commit declares for it, read-only;
 *   - (tag mode) the commit is not an ancestor of main (`--main-ref`, required).
 *
 * Every value it emits comes from the matching unit, never from a substring of
 * the tag, and is checked against a safe character set, so a workflow can pass
 * it through `env:` without interpreting it.
 *
 * It runs from the tagged commit, so it is a guard against mistakes, not a
 * security boundary. The boundary is the tag ruleset and `/release`.
 *
 * Output: `key=value` lines appended to $GITHUB_OUTPUT when it is set, and one
 * JSON object on stdout. Refusals are one line on stderr.
 * Exit codes: 0 accepted, 1 refused, 2 usage error or unreadable input.
 *
 * Zero dependencies on purpose: it runs before `pnpm install`.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

export const MANIFEST = "dagger/sdk-manifest.json";

/** Semver core plus an optional pre-release, no leading zeros, no build metadata. */
const SEMVER =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

/** What an emitted value may contain. Anything else is refused, not escaped. */
const SAFE = /^[A-Za-z0-9@/._:{}+-]*$/;

export class Refusal extends Error {}

/** Input the resolver cannot read or parse: exit 2, never a refusal of the tag. */
export class InputError extends Error {}

/** The tag regex built from `tagFormat`. Only `{name}` and `{version}` are placeholders. */
export function tagRegex(tagFormat) {
  if (
    typeof tagFormat !== "string" ||
    !tagFormat.includes("{name}") ||
    !tagFormat.includes("{version}")
  )
    throw new Refusal(`${MANIFEST}: tagFormat must contain {name} and {version}`);
  const escaped = tagFormat.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped.replace("{name}", "(?<name>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)").replace("{version}", `(?<version>${SEMVER})`)}$`,
  );
}

/** Fill a `{version}` template (a release or mirror tag). */
export function fill(template, version) {
  return template.replaceAll("{version}", version);
}

/** The version a unit declares at this commit, or the tag's for `versionSource: "tag"`. */
export function declaredVersion(unit, root, tagVersion) {
  const src = unit.versionSource;
  if (src === "tag") {
    if (tagVersion === undefined)
      throw new Refusal(
        `unit "${unit.name}" takes its version from the tag; a dry run needs --version`,
      );
    return tagVersion;
  }
  if (
    src === null ||
    typeof src !== "object" ||
    typeof src.file !== "string" ||
    typeof src.pattern !== "string"
  )
    throw new Refusal(`unit "${unit.name}": versionSource must be "tag" or { file, pattern }`);
  let text;
  try {
    text = readFileSync(join(root, src.file), "utf8");
  } catch (e) {
    throw new InputError(`unit "${unit.name}": cannot read ${src.file} (${e.code ?? e.message})`, {
      cause: e,
    });
  }
  const matches = [...text.matchAll(new RegExp(src.pattern, "gm"))];
  if (matches.length !== 1)
    throw new Refusal(
      `unit "${unit.name}": ${src.file} must declare the version exactly once (found ${matches.length})`,
    );
  const version = matches[0][1];
  if (!new RegExp(`^${SEMVER}$`).test(version ?? ""))
    throw new Refusal(
      `unit "${unit.name}": ${src.file} declares "${version}", which is not semver`,
    );
  return version;
}

/** The gate a unit runs: `{ gate: "test", daggerFn }` or `{ gate: "skip" }`. */
export function gateOf(unit, roster) {
  if (typeof unit.gateFn === "string") return { gate: "test", daggerFn: unit.gateFn };
  const entry = roster.find((s) => s?.name === unit.gate);
  if (!entry)
    throw new Refusal(`unit "${unit.name}": gate "${unit.gate}" is not in the .sdks roster`);
  if (entry.status === "covered") {
    if (typeof entry.daggerFn !== "string" || entry.daggerFn === "")
      throw new Refusal(`unit "${unit.name}": covered gate "${entry.name}" has no daggerFn`);
    return { gate: "test", daggerFn: entry.daggerFn };
  }
  if (entry.status === "exempt") return { gate: "skip" };
  if (entry.status === "pending")
    throw new Refusal(`unit "${unit.name}": its gate is pending — nothing ships without a gate`);
  throw new Refusal(`unit "${unit.name}": unknown gate status "${entry.status}"`);
}

/** Where a dependency is looked for. Only registries that `after` is used with. */
export function registryUrl(unit, version) {
  if (unit.registry === "npm")
    return `https://registry.npmjs.org/${unit.coordinates.replace("/", "%2f")}/${encodeURIComponent(version)}`;
  return null;
}

/** Default lookup: a read-only GET; true on 200, false on 404, a refusal on anything else. */
export async function httpExists(url) {
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new Refusal(`cannot reach ${url}`);
  }
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Refusal(`${url} answered ${res.status}`);
}

/** True when `commit` is an ancestor of `mainRef` in the repository at `root`. */
export function onMain(root, commit, mainRef) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", commit, mainRef], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Refusal(`git merge-base could not compare ${commit} with ${mainRef}`);
}

function checkSafe(out) {
  for (const [k, v] of Object.entries(out))
    if (typeof v !== "string" || !SAFE.test(v))
      throw new Refusal(`refusing to emit ${k}: unsafe characters`);
  return out;
}

/**
 * Resolve a tag (release) or a unit name (dry run). Returns the outputs, or
 * throws a Refusal. `exists` and `isOnMain` are injectable for the tests.
 */
export async function resolvePublish({
  root,
  tag,
  unit: unitName,
  version: dryRunVersion,
  commit = "HEAD",
  mainRef,
  exists = httpExists,
  isOnMain = onMain,
}) {
  if ((tag === undefined) === (unitName === undefined))
    throw new Refusal("pass exactly one of --tag or --unit");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  } catch (e) {
    throw new InputError(`cannot read ${MANIFEST} (${e.code ?? e.message})`, { cause: e });
  }
  const units = manifest.publish;
  const roster = manifest.sdks;
  if (!Array.isArray(units) || units.length === 0)
    throw new Refusal(`${MANIFEST}: publish[] is missing or empty`);
  if (!Array.isArray(roster)) throw new Refusal(`${MANIFEST}: sdks[] is missing`);

  let name;
  let tagVersion;
  if (tag !== undefined) {
    const m = tagRegex(manifest.tagFormat).exec(tag);
    if (!m) throw new Refusal(`"${tag}" is not shaped as ${manifest.tagFormat}`);
    ({ name, version: tagVersion } = m.groups);
  } else {
    name = unitName;
    // A dispatch input, which reaches the outputs (and the pack job's paths and
    // the mirror tag) like a tag's version does: held to the same semver.
    if (dryRunVersion !== undefined && !new RegExp(`^${SEMVER}$`).test(dryRunVersion))
      throw new Refusal(`--version "${dryRunVersion}" is not semver (X.Y.Z[-pre])`);
    tagVersion = dryRunVersion;
  }

  const unit = units.find((u) => u?.name === name);
  if (!unit) throw new Refusal(`no publish unit is named "${name}"`);
  if (typeof unit.registry !== "string" || unit.registry === "")
    throw new Refusal(`unit "${name}" names no registry`);
  if (unit.registry === "none")
    throw new Refusal(`unit "${name}" has no registry: ${unit.reason ?? "no reason given"}`);
  if (unit.blockedBy) throw new Refusal(`unit "${name}" is blocked by ${unit.blockedBy}`);

  const gate = gateOf(unit, roster);
  const version = declaredVersion(unit, root, tagVersion);
  if (tagVersion !== undefined && version !== tagVersion)
    throw new Refusal(
      `tag version ${tagVersion} differs from the ${version} that ${unit.name} declares`,
    );

  if (tag !== undefined) {
    for (const depName of unit.after ?? []) {
      const dep = units.find((u) => u?.name === depName);
      if (!dep) throw new Refusal(`unit "${name}": after names "${depName}", which is not a unit`);
      const depVersion = declaredVersion(dep, root, undefined);
      const url = registryUrl(dep, depVersion);
      if (url === null)
        throw new Refusal(`unit "${name}": cannot check "${depName}" on registry ${dep.registry}`);
      if (!(await exists(url)))
        throw new Refusal(
          `unit "${name}" must follow ${dep.coordinates}@${depVersion}, which is not published yet`,
        );
    }
    if (mainRef === undefined)
      throw new Refusal("a release tag needs --main-ref: release tags are cut from main only");
    // Both are `git merge-base` arguments: one starting with `-` is an option.
    for (const [flag, v] of [
      ["--commit", commit],
      ["--main-ref", mainRef],
    ])
      if (String(v).startsWith("-"))
        throw new Refusal(`${flag} "${String(v)}" starts with -: it would be read as a git option`);
    if (!isOnMain(root, commit, mainRef))
      throw new Refusal(`${commit} is not on ${mainRef}: release tags are cut from main only`);
  }

  return checkSafe({
    name: unit.name,
    registry: unit.registry,
    coordinates: unit.coordinates,
    path: unit.path,
    version,
    gate: gate.gate,
    daggerFn: gate.daggerFn ?? "",
    releaseTag: unit.releaseTag ? fill(unit.releaseTag, version) : "",
    mirrorRepository: unit.mirror?.repository ?? "",
    mirrorTag: unit.mirror ? fill(unit.mirror.releaseTag, version) : "",
  });
}

/** The CLI flags, by name: an explicit table, never a string transform. */
const FLAGS = Object.freeze({
  "--tag": "tag",
  "--unit": "unit",
  "--version": "version",
  "--commit": "commit",
  "--main-ref": "mainRef",
});

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    const v = argv[i + 1];
    if (key === undefined || v === undefined || key in out)
      throw new InputError(
        "usage: resolve-publish.mjs (--tag <tag> --main-ref <ref> | --unit <name> [--version <v>]) [--commit <sha>]",
      );
    out[key] = v;
  }
  return out;
}

async function main() {
  const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  try {
    const out = await resolvePublish({ root, ...args });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(out)
          .map(([k, v]) => `${k}=${String(v)}\n`)
          .join(""),
      );
    console.log(JSON.stringify(out));
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`refused: ${e.message}`);
      return 1;
    }
    console.error(`resolve-publish: ${e?.message ?? e}`);
    return 2;
  }
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = await main();
