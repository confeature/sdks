#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Whether a Maven release directory is exactly the release of one unit, and
 * may be uploaded to https://maven.confeature.io as it is (#902).
 *
 *   node tools/sdk-pack/check-maven-release.mjs <repo-dir> <group:artifactId> <version> [<live-dir>]
 *
 * `<repo-dir>` is what the unit's `publishAllPublicationsToReleaseRepository`
 * wrote (a Maven layout); `<live-dir>` holds `<artifactId>.xml`, the
 * `maven-metadata.xml` each artifact had on the live repository before the
 * build, when it had one. sdk-publish.yml's Maven pack job runs this on the
 * directory its publish job uploads, file for file, so it refuses, before any
 * credential exists, a release that:
 *   - carries a file outside the unit's group, or an artifact id that is
 *     neither the unit's nor the unit's with a target suffix (a Kotlin
 *     Multiplatform build publishes `<id>-jvm`, `<id>-iosarm64`, ...);
 *   - carries any version but the resolved one: the upload would rewrite a
 *     released version, which never changes;
 *   - carries a file without its `.md5` and `.sha1` (what Maven and Gradle
 *     clients fetch), or a checksum, of any algorithm, that does not match;
 *   - has an artifact with no POM, or a main jar, aar or klib without its
 *     sources and javadoc jars;
 *   - has a POM of other coordinates, or without a name, description, url,
 *     MIT licence, MakerLabs developer and scm connection and url, or with an
 *     `@` or an `<email>` anywhere: no address is ever published;
 *   - has metadata that does not list the version, names another artifact,
 *     drops a version the live metadata lists (it would vanish from the
 *     listing), or a version that is already live.
 *
 * There is no registry to refuse a bad upload here: R2 stores what it is
 * given. So every rule a registry would enforce is enforced before the upload.
 *
 * Exit codes: 0 accepted, 1 refused, 2 usage error or unreadable input.
 * Zero dependencies.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

const SUMS = ["md5", "sha1", "sha256", "sha512"];
/** Clients fetch these two; the others Gradle writes are checked when present. */
const REQUIRED_SUMS = ["md5", "sha1"];
const METADATA = "maven-metadata.xml";
const MAIN = /\.(?:jar|aar|klib)$/;

const sumOf = (path) => SUMS.find((alg) => path.endsWith(`.${alg}`));
const text = (body) => (typeof body === "string" ? body : body.toString("utf8"));
const versionsOf = (xml) => [...xml.matchAll(/<version>([^<]*)<\/version>/g)].map((m) => m[1]);

/**
 * The project's own element, never a dependency's or the parent's: those
 * sections are cut before the first match is read. The caller has already cut
 * the sections whose children share a name with a project element (a
 * licence's or the scm's <url>).
 */
function own(pomText, element) {
  const top = pomText
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(dependencies|dependencyManagement|parent|build|profiles)>[\s\S]*?<\/\1>/g, "");
  const m = new RegExp(`<project[^>]*>[\\s\\S]*?<${element}>([^<]*)</${element}>`).exec(top);
  return m?.[1];
}

/** The POM's problems, `where` naming it. */
function pomProblems(where, pomText, group, aid, version) {
  const problems = [];
  // Every nested section that can hold a same-named element is cut, so
  // `<url>` is the project's, not a licence's or the scm's.
  const flat = pomText.replace(
    /<(licenses|developers|scm|organization|issueManagement|ciManagement|distributionManagement|mailingLists|contributors)>[\s\S]*?<\/\1>/g,
    "",
  );
  for (const [el, want] of [
    ["groupId", group],
    ["artifactId", aid],
    ["version", version],
  ]) {
    const got = own(flat, el);
    if (got !== want) problems.push(`${where}: <${el}> is ${got ?? "absent"}, not ${want}`);
  }
  for (const el of ["name", "description", "url"])
    if (!own(flat, el)?.trim()) problems.push(`${where}: no <${el}>`);
  const section = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(pomText)?.[1] ?? "";
  if (!/<license>\s*<name>MIT<\/name>/.test(section("licenses")))
    problems.push(`${where}: no MIT licence`);
  if (!/<developer>[\s\S]*?<name>MakerLabs<\/name>/.test(section("developers")))
    problems.push(`${where}: no developer named MakerLabs`);
  const scm = section("scm");
  if (!/<connection>[^<]+<\/connection>/.test(scm) || !/<url>[^<]+<\/url>/.test(scm))
    problems.push(`${where}: no <scm> with a <connection> and a <url>`);
  if (pomText.includes("@"))
    problems.push(`${where}: carries an '@' (no address may be published)`);
  if (/<email>/.test(pomText)) problems.push(`${where}: carries an <email> element`);
  return problems;
}

/**
 * The problems with a release tree (relative path → content) of the unit at
 * `coordinates` and `version`, given the live metadata per artifact id.
 * Empty when it may be uploaded.
 */
export function releaseProblems(tree, coordinates, version, live = {}) {
  const [group, rootId] = coordinates.split(":");
  const base = `${group.replaceAll(".", "/")}/`;
  const problems = [];
  const aids = new Map(); // artifact id → its files, relative to its directory

  for (const path of Object.keys(tree).sort()) {
    if (!path.startsWith(base)) {
      problems.push(`${path}: outside group ${group} (${base})`);
      continue;
    }
    const [aid, ...rest] = path.slice(base.length).split("/");
    if (!aids.has(aid)) aids.set(aid, []);
    aids.get(aid).push(rest.join("/"));
  }
  if (!aids.has(rootId)) problems.push(`no ${coordinates} in the release`);

  // Checksums, over the whole tree: present where clients need them, and true.
  for (const path of Object.keys(tree).sort()) {
    const alg = sumOf(path);
    if (alg !== undefined) {
      const of = path.slice(0, -(alg.length + 1));
      if (!(of in tree)) problems.push(`${path}: a checksum of a file the release does not carry`);
      else if (text(tree[path]).trim() !== createHash(alg).update(tree[of]).digest("hex"))
        problems.push(`${path}: does not match ${of}`);
      continue;
    }
    for (const req of REQUIRED_SUMS)
      if (!(`${path}.${req}` in tree)) problems.push(`${path}: no .${req} checksum`);
  }

  for (const [aid, files] of aids) {
    const dir = `${base}${aid}`;
    if (aid !== rootId && !aid.startsWith(`${rootId}-`)) {
      problems.push(`${dir}: artifact id ${aid} is not ${rootId} nor ${rootId}-<target>`);
      continue;
    }
    const prefix = `${aid}-${version}`;
    const inVersion = [];
    for (const f of files) {
      const name = sumOf(f) ? f.slice(0, f.lastIndexOf(".")) : f;
      if (name === METADATA) continue;
      const [v, file, ...deeper] = f.split("/");
      if (file === undefined)
        problems.push(`${dir}/${f}: neither ${METADATA} nor a file of version ${version}`);
      else if (v !== version)
        problems.push(`${dir}/${f}: version ${v} is not the release (${version})`);
      else if (deeper.length > 0 || !file.startsWith(prefix))
        problems.push(`${dir}/${f}: not named ${prefix}*`);
      else if (!sumOf(file)) inVersion.push(file);
    }
    const has = (f) => inVersion.includes(f);
    const vdir = `${dir}/${version}`;
    if (!has(`${prefix}.pom`)) problems.push(`${vdir}: no ${prefix}.pom`);
    else
      problems.push(
        ...pomProblems(
          `${vdir}/${prefix}.pom`,
          text(tree[`${vdir}/${prefix}.pom`]),
          group,
          aid,
          version,
        ),
      );
    if (inVersion.some((f) => MAIN.test(f) && f.startsWith(`${prefix}.`)))
      for (const cls of ["sources", "javadoc"])
        if (!has(`${prefix}-${cls}.jar`)) problems.push(`${vdir}: no ${prefix}-${cls}.jar`);

    const metaPath = `${dir}/${METADATA}`;
    if (!(metaPath in tree)) {
      problems.push(`${dir}: no ${METADATA}`);
      continue;
    }
    const meta = text(tree[metaPath]);
    const named = `${/<groupId>([^<]*)</.exec(meta)?.[1]}:${/<artifactId>([^<]*)</.exec(meta)?.[1]}`;
    if (named !== `${group}:${aid}`)
      problems.push(`${metaPath}: names ${named}, not ${group}:${aid}`);
    const listed = versionsOf(meta);
    if (!listed.includes(version)) problems.push(`${metaPath}: does not list ${version}`);
    if (aid in live) {
      const was = versionsOf(text(live[aid]));
      if (was.includes(version))
        problems.push(`${dir}: ${version} is already published (live ${METADATA} lists it)`);
      for (const v of was.filter((x) => !listed.includes(x)))
        problems.push(`${metaPath}: drops ${v}, which the live metadata lists`);
    }
  }
  for (const aid of Object.keys(live))
    if (!aids.has(aid))
      problems.push(`${aid}: live metadata for an artifact this release does not publish`);
  return problems;
}

/** Every file under `dir`, by its path relative to it, with `/` separators. */
function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join("/")] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

function main(argv) {
  const [repo, coordinates, version, liveDir] = argv;
  if (!repo || !version || !/^[^:]+:[^:]+$/.test(coordinates ?? "")) {
    console.error(
      "usage: check-maven-release.mjs <repo-dir> <group:artifactId> <version> [<live-dir>]",
    );
    return 2;
  }
  let tree;
  const live = {};
  try {
    tree = readTree(repo);
    if (liveDir)
      for (const f of readdirSync(liveDir).filter((n) => n.endsWith(".xml")))
        live[f.slice(0, -4)] = readFileSync(join(liveDir, f), "utf8");
  } catch (e) {
    console.error(`check-maven-release: cannot read the release (${e?.message ?? e})`);
    return 2;
  }
  const problems = releaseProblems(tree, coordinates, version, live);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) return 1;
  console.log(
    `check-maven-release: ${coordinates}:${version} accepted (${Object.keys(tree).length} files)`,
  );
  return 0;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
