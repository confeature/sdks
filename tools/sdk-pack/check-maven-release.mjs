#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Whether a Maven release directory is exactly the release of one unit, and
 * may be uploaded to https://maven.confeature.io as it is (#902).
 *
 *   node tools/sdk-pack/check-maven-release.mjs <repo-dir> <group:artifactId> <version> <live-dir>
 *
 * `<repo-dir>` is what the unit's `publishAllPublicationsToReleaseRepository`
 * wrote (a Maven layout); `<live-dir>` holds the live repository's answer for
 * each artifact before the build: `<artifactId>.xml`, its `maven-metadata.xml`
 * (a 200), or `<artifactId>.absent` (a 404, a first release). An artifact with
 * neither is refused: the live state is never assumed. sdk-publish.yml's Maven pack job runs this on the
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
 *     listing), or a version that is already live;
 *   - has an artifact the live repository gave no answer for, or whose live
 *     answer is not that artifact's metadata listing a version.
 *   - omits any of the Kotlin OpenFeature companion's five target artifacts
 *     or a reference to it in the root Gradle module.
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
const KOTLIN_OPENFEATURE = "io.confeature:confeature-openfeature-kotlin";
const KOTLIN_TARGETS = {
  android: "aar",
  jvm: "jar",
  js: "klib",
  iosarm64: "klib",
  iossimulatorarm64: "klib",
};

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

/** Read the direct identity fields of a Gradle-generated Maven POM. */
function pomIdentity(pomText) {
  const fields = new Set(["modelVersion", "groupId", "artifactId", "version"]);
  const xml = pomText.replace(/^\s*(?:<\?xml[^?]*\?>)?/, "");
  const tokens =
    /<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  const stack = [];
  const values = new Map();
  let seenProject = false;
  let consumed = 0;
  for (const [token, closing, opening] of xml.matchAll(tokens)) {
    consumed += token.length;
    if (token.startsWith("<!--")) continue;
    if (closing) {
      if (stack.pop() !== closing) return null;
      continue;
    }
    const field = stack.length === 2 && fields.has(stack[1]) ? stack[1] : null;
    if (!opening) {
      if (field) values.set(field, values.get(field) + token);
      if (stack.length === 0 && token.trim()) return null;
      continue;
    }
    if (field) return null;
    if (stack.length === 0) {
      if (seenProject || opening !== "project") return null;
      seenProject = true;
    }
    if (stack.length === 1 && fields.has(opening)) {
      if (values.has(opening)) return null;
      values.set(opening, "");
    }
    if (!token.endsWith("/>")) stack.push(opening);
  }
  if (!seenProject || stack.length > 0 || consumed !== xml.length) return null;
  return values;
}

export function matchesPomCoordinates(pomText, coordinates, version) {
  const [group, artifact] = coordinates.split(":");
  const identity = pomIdentity(pomText);
  return (
    identity?.get("modelVersion")?.trim() === "4.0.0" &&
    identity.get("groupId")?.trim() === group &&
    identity.get("artifactId")?.trim() === artifact &&
    identity.get("version")?.trim() === version
  );
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
  const identity = pomIdentity(pomText);
  for (const [el, want] of [
    ["modelVersion", "4.0.0"],
    ["groupId", group],
    ["artifactId", aid],
    ["version", version],
  ]) {
    const got = identity?.get(el)?.trim();
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

/** Whether `xml` is a maven-metadata.xml document naming exactly `group:aid`. */
const isMetadataOf = (xml, group, aid) =>
  /<metadata[\s>]/.test(xml) &&
  /<groupId>([^<]*)</.exec(xml)?.[1] === group &&
  /<artifactId>([^<]*)</.exec(xml)?.[1] === aid;

/**
 * The problems with a release tree (relative path → content) of the unit at
 * `coordinates` and `version`, given the live repository's answer per artifact
 * id: its maven-metadata.xml, or null for a 404 (a first release). An artifact
 * with NO answer is refused, never read as a 404: a failed or skipped fetch
 * would otherwise publish metadata that drops every earlier version, and so
 * is a 200 whose body is not that artifact's metadata (#794 review).
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
  if (coordinates === KOTLIN_OPENFEATURE) {
    problems.push(...kotlinCompanionProblems(tree, base, rootId, version, aids));
  }

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
    if (!Object.hasOwn(live, aid)) {
      problems.push(
        `${aid}: no answer from the live repository (neither ${aid}.xml nor ${aid}.absent): refusing to guess whether it has releases`,
      );
      continue;
    }
    if (live[aid] !== null) {
      const liveXml = text(live[aid]);
      const was = versionsOf(liveXml);
      if (!isMetadataOf(liveXml, group, aid) || was.length === 0) {
        problems.push(
          `${aid}: the live maven-metadata.xml is not metadata of ${group}:${aid} listing a version: refusing to guess`,
        );
        continue;
      }
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

function kotlinCompanionProblems(tree, base, rootId, version, aids) {
  const group = KOTLIN_OPENFEATURE.split(":")[0];
  const expected = new Map([[rootId, "jar"]]);
  for (const [target, extension] of Object.entries(KOTLIN_TARGETS)) {
    expected.set(`${rootId}-${target}`, extension);
  }
  const problems = [];
  for (const aid of aids.keys()) {
    if (!expected.has(aid)) problems.push(`${aid}: unexpected Kotlin OpenFeature artifact`);
  }
  for (const [aid, extension] of expected) {
    const path = `${base}${aid}/${version}/${aid}-${version}`;
    for (const suffix of [extension, "module"]) {
      if (!Object.hasOwn(tree, `${path}.${suffix}`)) problems.push(`missing ${path}.${suffix}`);
    }
  }
  const modulePath = `${base}${rootId}/${version}/${rootId}-${version}.module`;
  if (!Object.hasOwn(tree, modulePath)) return problems;
  let module;
  try {
    module = JSON.parse(text(tree[modulePath]));
  } catch (error) {
    return [...problems, `${modulePath}: invalid Gradle metadata (${error.name})`];
  }
  if (
    module?.component?.group !== group ||
    module?.component?.module !== rootId ||
    module?.component?.version !== version ||
    !Array.isArray(module?.variants)
  ) {
    return [...problems, `${modulePath}: does not describe ${KOTLIN_OPENFEATURE}:${version}`];
  }
  expected.delete(rootId);
  const referenced = new Set();
  for (const variant of module.variants) {
    if (!Object.hasOwn(variant ?? {}, "available-at")) continue;
    const route = variant["available-at"];
    const aid = route?.module;
    if (
      !expected.has(aid) ||
      route.group !== group ||
      route.version !== version ||
      route.url !== `../../${aid}/${version}/${aid}-${version}.module`
    ) {
      problems.push(`${modulePath}: invalid Kotlin target reference`);
    } else {
      referenced.add(aid);
    }
  }
  for (const aid of expected.keys()) {
    if (!referenced.has(aid)) problems.push(`${modulePath}: no reference to ${aid}`);
  }
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
  if (!repo || !version || !liveDir || !/^[^:]+:[^:]+$/.test(coordinates ?? "")) {
    console.error(
      "usage: check-maven-release.mjs <repo-dir> <group:artifactId> <version> <live-dir>",
    );
    return 2;
  }
  let tree;
  const live = {};
  const contradictory = [];
  try {
    tree = readTree(repo);
    for (const f of readdirSync(liveDir)) {
      const aid = f.endsWith(".xml")
        ? f.slice(0, -4)
        : f.endsWith(".absent")
          ? f.slice(0, -7)
          : null;
      if (aid === null) continue;
      // A 200 and a 404 for one artifact: the fetch's outcome is unknown.
      if (Object.hasOwn(live, aid)) contradictory.push(aid);
      live[aid] = f.endsWith(".xml") ? readFileSync(join(liveDir, f), "utf8") : null;
    }
  } catch (e) {
    console.error(`check-maven-release: cannot read the release (${e?.message ?? e})`);
    return 2;
  }
  const problems = [
    ...contradictory.map(
      (aid) =>
        `${aid}: the live directory holds both ${aid}.xml and ${aid}.absent: refusing to guess`,
    ),
    ...releaseProblems(tree, coordinates, version, live),
  ];
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) return 1;
  console.log(
    `check-maven-release: ${coordinates}:${version} accepted (${Object.keys(tree).length} files)`,
  );
  return 0;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
