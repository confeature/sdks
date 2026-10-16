#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The release-pipeline rules every workflow in this repository is held to
 * (#794). They used to be checked only on the private export that created this
 * repository; since the repository went public, they are checked here, on
 * every `pnpm run verify`.
 *
 *   node tools/repo-gates/verify-workflows.mjs
 *
 * The rules, each a finding `file: job: why`:
 *   1. ENVIRONMENTS. A job binds only an environment declared in
 *      tools/repo-gates/release-settings.json. GitHub creates a missing one,
 *      unprotected, the first time a job names it. Every secret a job reads is
 *      declared in its environment's `secrets`, so the applier knows it exists
 *      and when it must be rotated (#901).
 *   2. NO CREDENTIALS OUTSIDE AN ENVIRONMENT. A job that binds no environment
 *      requests no `id-token: write` and reads no `secrets` context, and no
 *      workflow grants either at the top level, where every job would inherit
 *      it. A pack job or a dry run is exactly such a job.
 *   3. CREDENTIALED PUBLISH JOBS RUN NO PROJECT CODE, AND RESTORE NO CACHE. A
 *      job bound to a registry environment runs no package manager, build
 *      tool, script or interpreter on repository files (the pinned registry
 *      client installing itself is the one exception), keeps no checkout
 *      credential, and uses no cache: no `actions/cache`, no `cache:` /
 *      `bundler-cache:` / `cache-jdk:` input — nor does a pack job, whose artifact the publish
 *      job uploads. A dependency that runs in the job holding the OIDC token or
 *      a key can publish or steal it; a poisoned cache is such a dependency.
 *      `cache: false` restores nothing, and an action that caches unless told
 *      not to (DEFAULT_CACHE: actions/setup-go) must say it.
 *      PUBLISH_EXCEPTIONS names the one command each source-only registry
 *      (crates.io, pub.dev) needs instead, exact and for its job only.
 *   4. NO UNTRUSTED TRIGGERS. No workflow runs on `pull_request_target` or
 *      `workflow_run`, the two triggers that hand a fork's change a privileged
 *      context.
 *   5. NO EXPRESSIONS IN SHELL. No `run:` contains `${{`. Values reach a shell
 *      through `env:`, so text can never become a command.
 *   6. PUBLISH JOBS ARE TOP-LEVEL. A reusable workflow (`on: workflow_call`)
 *      binds no environment, and no caller passes `secrets: inherit`: a
 *      registry's trust binding names the CALLING file.
 *   7. ONE SHAPE PER REGISTRY. In sdk-publish.yml, `pack-<registry>` and
 *      `publish-<registry>` name a registry that has publish units, and
 *      `publish-<registry>` binds THAT registry's environment (the conclude job
 *      relies on the names). Every unit's tag (`tagFormat`) is matched by the
 *      workflow's tag trigger and by the protected release-tag patterns; its
 *      registry has exactly one environment, whose tag policy the operator's
 *      applier DERIVES from the units (it is never written out here); every
 *      registry environment has units; each trust binding names a declared
 *      environment of its registry and an existing workflow.
 *   8. ACTIONS. Every third-party `uses:` is pinned to a full commit SHA and
 *      allowed by `allowedActions`; every allowed entry is used somewhere (an
 *      allowance nobody needs is a standing hole).
 *   9. PINNED TOOLS. A pack or publish job installs npm at an exact version and
 *      gives `setup-node` an exact `node-version` — written once per workflow
 *      in its top-level `env:` (`NPM_VERSION`, `NODE_VERSION`) and referenced
 *      from there — and never runs a tool through `npx`. Every `*_VERSION` in
 *      that top-level `env:` is an exact version.
 *  10. EXPLICIT TARBALL PATHS. An `npm publish` argument holding a `/` starts
 *      with `./`, `/` or a `$` variable: npm reads `release/x.tgz` as the
 *      GitHub repository `release/x.tgz`, so that publish fails after the tag
 *      is pushed (#899, caught by a local dry run).
 *  11. MIRRORS AND MODULE TAGS (#901). Every `mirrors[]` entry names a unit
 *      whose manifest `mirror.repository` is that repository, an environment
 *      of that unit's registry, and tag patterns covering its mirror tag; every
 *      unit with a mirror has an entry. `goModuleTags` names the go registry's
 *      environment and covers every go unit's `releaseTag`, which each has.
 *      The operator's applier creates the deploy keys and rulesets from them.
 *
 * Exit codes: 0 clean, 1 at least one finding, 2 unreadable input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isEntry } from "../lib/is-entry.mjs";

export const SETTINGS = "tools/repo-gates/release-settings.json";
export const MANIFEST = "dagger/sdk-manifest.json";
export const WORKFLOWS = ".github/workflows";
export const PUBLISH_WORKFLOW = "sdk-publish.yml";

const EXACT = /^\d+\.\d+\.\d+$/;

/** GitHub's filter-pattern semantics for the patterns used here: `*` matches anything but `/`. */
export function globMatches(glob, ref) {
  if (/[?[\]!+]/.test(glob)) throw new Error(`unsupported glob character in ${glob}`);
  // `**` first, so its two stars are never read as two single ones.
  const body = glob
    .split("**")
    .map((part) => part.replace(/[.^$()|\\{}]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`).test(ref);
}

const envName = (job) =>
  typeof job?.environment === "string" ? job.environment : job?.environment?.name;
const grantsIdToken = (perms) => perms === "write-all" || perms?.["id-token"] === "write";
const readsSecrets = (node) => /\$\{\{[^}]*\bsecrets\b/.test(JSON.stringify(node ?? null));
const triggersOf = (doc) => {
  const on = doc?.on ?? doc?.[true]; // YAML 1.1 reads a bare `on` key as true
  return typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
};

/**
 * A shell line that runs repository code or a package manager: forbidden in a
 * publish job. `bundle` is bundler, not `git bundle` and not a `*.bundle` file
 * (the mirror publish jobs verify one, #901).
 */
const PROJECT_CODE =
  /\b(?:pnpm|yarn|bun|npx|make|gradlew?|mvnw?|mix|(?<!\bgit\s+|[.$/{-])bundle|pip|poetry|composer|uvx?|cargo|rake|dart|python3?|ruby|go\s+(?:run|build|generate)|dotnet\s+(?!nuget\s+push\b)\w+|gem\s+(?!push\b)\w+)\b|(?:^|[\s;&|])\.\/(?!release\/)|\bnpm\s+(?:ci|install|i|run|exec|test|rebuild)\b|\bnode\s+\S|\b(?:bash|sh|zsh)\s+[^-\s]/;
/**
 * Rule 3's recorded exceptions: the one command a registry that takes no
 * prebuilt archive needs in the job holding its credential (#900). crates.io:
 * `cargo publish --no-verify` packages the commit again and compiles nothing.
 * pub.dev: `dart pub publish --force` packs and uploads in one command, and
 * pub.dev accepts it only from the OIDC job. Each is exact, and for its job only.
 */
export const PUBLISH_EXCEPTIONS = {
  "publish-crates": [/^cargo "\+\$\{RUST_VERSION\}" publish --no-verify$/],
  "publish-pubdev": [/^dart pub publish --force$/],
};
/** Actions that restore a cache unless their `cache` input is false. */
const DEFAULT_CACHE = new Set(["actions/setup-go"]);
const PINNED_SELF_INSTALL = /^npm install --global --ignore-scripts "?npm@\$\{?NPM_VERSION\}?"?$/;

/** Rules 4 and 6 (workflow scope) and the workflow-level half of rule 2. */
function workflowRules(file, doc, add) {
  const triggers = triggersOf(doc);
  for (const t of ["pull_request_target", "workflow_run"])
    if (triggers.includes(t)) add(file, "-", `triggers on ${t}`);
  if (grantsIdToken(doc?.permissions))
    add(file, "-", "grants id-token: write at the top level, to every job");
  if (readsSecrets(doc?.env) || readsSecrets(doc?.defaults))
    add(file, "-", "reads the secrets context at the top level, for every job");
}

/** Rule 9's homes: the workflow-level pins, which must be exact. */
function workflowPins(file, doc, add) {
  const pins = { NODE_VERSION: doc?.env?.NODE_VERSION, NPM_VERSION: doc?.env?.NPM_VERSION };
  // Every tool pin in the top-level env, not only node and npm (#900).
  for (const [k, v] of Object.entries(doc?.env ?? {}))
    if (k.endsWith("_VERSION") && !EXACT.test(String(v)))
      add(file, "-", `env ${k} is ${String(v)}, not an exact version`);
  return pins;
}

function runRules(file, where, run, { jobId, isPublish, isPackOrPublish, pins, add }) {
  if (run.includes("${{"))
    add(file, where, "a run: block interpolates ${{ }} (pass it through env:)");
  const lines = run
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (isPublish)
    for (const line of lines)
      if (
        PROJECT_CODE.test(line) &&
        !PINNED_SELF_INSTALL.test(line) &&
        !(PUBLISH_EXCEPTIONS[jobId] ?? []).some((re) => re.test(line))
      )
        add(file, where, "a credentialed publish job runs a package manager or repository code");
  if (isPackOrPublish) {
    if (/\bnpx\b/.test(run)) add(file, where, "runs a tool through npx (unpinned)");
    if (/\beval\b/.test(run)) add(file, where, "a pack or publish job evals a string");
    for (const line of lines.filter((l) => /\bnpm publish\b/.test(l)))
      for (const arg of line
        .split(/\bnpm publish\b/)[1]
        .trim()
        .split(/\s+/)) {
        const a = arg.replace(/^["']|["']$/g, "");
        if (a.includes("/") && !a.startsWith("-") && !/^(\.\/|\/|\$)/.test(a))
          add(file, where, `npm publish ${a}: a path without ./ is read as a GitHub repository`);
      }
    for (const m of run.matchAll(/\bnpm@("?)([^\s"]+)\1/g))
      if (!/^\$\{?NPM_VERSION\}?$/.test(m[2]) || pins.NPM_VERSION === undefined)
        add(file, where, `installs npm@${m[2]}, not the workflow's exact NPM_VERSION`);
  }
}

function usesRules(file, where, step, ctx) {
  const { isPublish, isPackOrPublish, allowed, used, pins, add } = ctx;
  const uses = step.uses;
  if (uses.startsWith("./") || uses.startsWith("docker://")) return;
  const [repoPath, ref] = uses.split("@");
  const repo = repoPath.split("/").slice(0, 2).join("/");
  const owner = repo.split("/")[0];
  if (!/^[0-9a-f]{40}$/.test(ref ?? "")) add(file, where, `uses ${uses} without a full commit SHA`);
  if (owner !== "actions" && owner !== "github") {
    used.add(`${repo}@*`);
    if (!allowed.includes(`${repo}@*`))
      add(file, where, `uses ${repo}, which ${SETTINGS} does not allow`);
  }
  const w = step.with ?? {};
  const noCache = w.cache === false || w.cache === "false";
  const caches =
    repo === "actions/cache" ||
    ("cache" in w && !noCache) ||
    (DEFAULT_CACHE.has(repo) && !noCache) ||
    "bundler-cache" in w ||
    // setup-java's JDK cache, its own input (#902).
    ("cache-jdk" in w && w["cache-jdk"] !== false && w["cache-jdk"] !== "false");
  if (isPackOrPublish && caches) add(file, where, "a pack or credentialed job restores a cache");
  if (isPublish && repo === "actions/checkout" && w["persist-credentials"] !== false)
    add(file, where, "a publish job's checkout keeps its credential (persist-credentials: false)");
  if (isPackOrPublish && repo === "actions/setup-node") {
    const v = String(w["node-version"] ?? "");
    if (!/^\$\{\{\s*env\.NODE_VERSION\s*\}\}$/.test(v) || pins.NODE_VERSION === undefined)
      add(
        file,
        where,
        `setup-node's node-version is ${v || "unset"}, not the workflow's exact NODE_VERSION`,
      );
  }
}

/** Rules 1, 2, 3, 5, 6, 9 and the action half of 8, for one job. */
function jobRules({ file, jobId, job, reusable, envs, allowed, used, pins, add }) {
  const env = envName(job);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const credentialed = env !== undefined;
  const declared = credentialed ? envs.get(env) : undefined;
  if (credentialed && declared === undefined)
    add(file, jobId, `binds environment "${env}", which ${SETTINGS} does not declare`);
  if (credentialed && reusable) add(file, jobId, `a reusable workflow binds environment "${env}"`);
  if (job?.secrets === "inherit") add(file, jobId, "passes `secrets: inherit`");
  if (declared !== undefined) {
    const have = new Set((declared.secrets ?? []).map((x) => x?.name));
    const text = JSON.stringify(job ?? null);
    for (const m of text.matchAll(/\bsecrets(?:\.([A-Za-z_]\w*)|\[\\?['"]([^'"\\]+)\\?['"]\])/g)) {
      const name = m[1] ?? m[2];
      if (name !== "GITHUB_TOKEN" && !have.has(name))
        add(file, jobId, `reads secret ${name}, which environment ${env} does not declare`);
    }
  }
  if (!credentialed) {
    if (grantsIdToken(job?.permissions))
      add(file, jobId, "requests id-token: write outside an environment");
    if (readsSecrets(job)) add(file, jobId, "reads the secrets context outside an environment");
  }
  const isPublish = typeof declared?.registry === "string";
  const isPackOrPublish = isPublish || jobId.startsWith("pack-") || declared !== undefined;
  const ctx = { jobId, credentialed, isPublish, isPackOrPublish, allowed, used, pins, add };
  for (const [i, step] of steps.entries()) {
    const where = `${jobId} step ${step?.name ?? i + 1}`;
    if (typeof step?.run === "string") runRules(file, where, step.run, ctx);
    if (typeof step?.uses === "string") usesRules(file, where, step, ctx);
  }
}

/** Rule 7, over sdk-publish.yml, the manifest and the settings. */
function shapeRules({ settings, manifest, workflows, envs, add }) {
  const pub = workflows[PUBLISH_WORKFLOW];
  const on = pub?.on ?? pub?.[true];
  const pubTags = on?.push?.tags ?? [];
  const protectedTags = settings.releaseTags?.include ?? [];
  const units = (manifest.publish ?? []).filter((u) => u?.registry !== "none");
  const registries = new Set(units.map((u) => u.registry));
  const registryEnvs = [...envs.values()].filter((e) => typeof e.registry === "string");

  for (const u of units) {
    const tag = manifest.tagFormat.replace("{name}", u.name).replace("{version}", "1.0.0");
    if (!pubTags.some((g) => globMatches(g, tag)))
      add(PUBLISH_WORKFLOW, "-", `the tag trigger does not match unit ${u.name} (${tag})`);
    if (!protectedTags.some((g) => globMatches(g, `refs/tags/${tag}`)))
      add(SETTINGS, "-", `no protected release-tag pattern covers unit ${u.name} (${tag})`);
    const n = registryEnvs.filter((e) => e.registry === u.registry).length;
    if (n !== 1)
      add(
        SETTINGS,
        "-",
        `unit ${u.name}'s registry ${u.registry} has ${n} environments, not exactly one`,
      );
  }
  for (const e of registryEnvs)
    if (!registries.has(e.registry))
      add(SETTINGS, "-", `environment ${e.name} has no unit of registry ${e.registry}`);
  for (const b of settings.trustBindings ?? []) {
    const e = envs.get(b.environment);
    if (!e || e.registry !== b.registry)
      add(
        SETTINGS,
        "-",
        `trust binding ${b.registry} names environment ${b.environment}, which is not that registry's`,
      );
    if (!(b.workflow in workflows))
      add(
        SETTINGS,
        "-",
        `trust binding ${b.registry} names workflow ${b.workflow}, which does not exist`,
      );
  }
  for (const [jobId, job] of Object.entries(pub?.jobs ?? {})) {
    const m = /^(pack|publish)-(.+)$/.exec(jobId);
    if (m === null) continue;
    if (!registries.has(m[2]))
      add(PUBLISH_WORKFLOW, jobId, `names registry ${m[2]}, which has no publish unit`);
    if (m[1] === "publish") {
      const want = registryEnvs.find((e) => e.registry === m[2])?.name;
      if (envName(job) !== want)
        add(
          PUBLISH_WORKFLOW,
          jobId,
          `binds ${String(envName(job))}, not registry ${m[2]}'s environment ${String(want)}`,
        );
    } else if (envName(job) !== undefined)
      add(PUBLISH_WORKFLOW, jobId, "a pack job binds an environment");
  }
}

/** Rule 11, over the settings and the manifest: what the applier builds deploy keys from. */
function mirrorRules({ settings, manifest, envs, add }) {
  const units = (manifest.publish ?? []).filter((u) => u?.registry !== "none");
  const mirrors = settings.mirrors ?? [];
  const sample = (template) => `refs/tags/${String(template).replace("{version}", "1.0.0")}`;
  for (const m of mirrors) {
    const unit = units.find((u) => u.name === m.unit);
    if (unit?.mirror?.repository !== m.repository)
      add(
        SETTINGS,
        "-",
        `mirror ${m.repository} names unit ${m.unit}, whose manifest mirror is ${String(unit?.mirror?.repository)}`,
      );
    const e = envs.get(m.environment);
    if (e === undefined || unit === undefined || e.registry !== unit.registry)
      add(
        SETTINGS,
        "-",
        `mirror ${m.repository} names environment ${m.environment}, which is not unit ${m.unit}'s registry's`,
      );
    if (unit?.mirror !== undefined) {
      const tag = sample(unit.mirror.releaseTag);
      if (!(m.tags ?? []).some((g) => globMatches(g, tag)))
        add(SETTINGS, "-", `mirror ${m.repository}'s tag patterns do not cover ${tag}`);
    }
  }
  for (const u of units.filter((x) => x.mirror !== undefined))
    if (!mirrors.some((m) => m.unit === u.name))
      add(
        SETTINGS,
        "-",
        `unit ${u.name} has a mirror (${u.mirror.repository}) that ${SETTINGS} does not declare`,
      );
  const goUnits = units.filter((u) => u.registry === "go");
  const g = settings.goModuleTags;
  if (goUnits.length === 0 && g === undefined) return;
  if (envs.get(g?.environment)?.registry !== "go")
    add(
      SETTINGS,
      "-",
      `goModuleTags names environment ${String(g?.environment)}, which is not the go registry's`,
    );
  for (const u of goUnits) {
    if (typeof u.releaseTag !== "string") {
      add(MANIFEST, "-", `go unit ${u.name} has no releaseTag: its module tag would be empty`);
      continue;
    }
    const ref = sample(u.releaseTag);
    if (!(g?.include ?? []).some((p) => globMatches(p, ref)))
      add(SETTINGS, "-", `goModuleTags does not cover unit ${u.name}'s module tag (${ref})`);
  }
}

/** Every finding over parsed inputs. Pure: the tests feed it fixtures. */
export function findings({ settings, manifest, workflows }) {
  const out = [];
  const add = (file, job, why) => out.push({ file, job, why });
  const envs = new Map((settings.environments ?? []).map((e) => [e.name, e]));
  const allowed = settings.allowedActions ?? [];
  const used = new Set();
  for (const [file, doc] of Object.entries(workflows)) {
    workflowRules(file, doc, add);
    const pins = workflowPins(file, doc, add);
    const reusable = triggersOf(doc).includes("workflow_call");
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {}))
      jobRules({ file, jobId, job, reusable, envs, allowed, used, pins, add });
  }
  for (const a of allowed)
    if (!used.has(a)) add(SETTINGS, "-", `allows ${a}, which no workflow uses`);
  shapeRules({ settings, manifest, workflows, envs, add });
  mirrorRules({ settings, manifest, envs, add });
  return out;
}

/** Read the repository at `root` and return the findings. Throws on unreadable input. */
export function verifyWorkflows(root) {
  const settings = JSON.parse(readFileSync(join(root, SETTINGS), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const workflows = {};
  for (const f of readdirSync(join(root, WORKFLOWS)).filter((n) => /\.ya?ml$/.test(n)))
    workflows[f] = parseYaml(readFileSync(join(root, WORKFLOWS, f), "utf8"));
  return findings({ settings, manifest, workflows });
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  let out;
  try {
    out = verifyWorkflows(root);
  } catch (e) {
    console.error(`verify-workflows: cannot read the inputs (${e?.message ?? e})`);
    return 2;
  }
  for (const f of out) console.error(`${f.file}: ${f.job}: ${f.why}`);
  console.log(`verify-workflows: ${out.length === 0 ? "ok" : `${out.length} finding(s)`}`);
  return out.length === 0 ? 0 : 1;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
