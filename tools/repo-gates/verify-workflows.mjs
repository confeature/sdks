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
 *   3. CREDENTIALED JOBS RUN ONLY THEIR ALLOWLIST, AND RESTORE NO CACHE. EVERY
 *      job bound to an environment (a registry's, or cli-release's, whose two
 *      jobs hold the R2 token) runs only the commands of CREDENTIALED_COMMANDS
 *      (shell builtins, file tools that run no program, curl, git's transport,
 *      each registry client's upload, the pinned npm installing itself), read
 *      by shell-commands.mjs from every nesting level of every `run:` block,
 *      plus its PUBLISH_EXCEPTIONS (the one command crates.io, pub.dev and the
 *      CLI bucket each need, exact and for its job only). It sets no variable
 *      that decides what a later command runs, writes no GITHUB_ENV or
 *      GITHUB_PATH, runs no shell but bash, no container and no local or
 *      container action, and keeps no checkout credential. It uses no cache:
 *      no `actions/cache`, no `cache:` / `enable-cache:` / `bundler-cache:` /
 *      `cache-jdk:` input other than false — nor does a pack job, whose
 *      artifact the publish job uploads. An action that caches unless told not
 *      to (DEFAULT_CACHE: setup-go, setup-uv) must say false. A dependency that
 *      runs in the job holding the OIDC token or a key can publish or steal it;
 *      a poisoned cache is such a dependency. The allowlist replaced a
 *      blocklist that review walked past five ways (#794 review).
 *   4. NO UNTRUSTED TRIGGERS. No workflow runs on `pull_request_target` or
 *      `workflow_run`, the two triggers that hand a fork's change a privileged
 *      context.
 *   5. NO EXPRESSIONS IN SHELL. No `run:` contains `${{`. Values reach a shell
 *      through `env:`, so text can never become a command.
 *   6. PUBLISH JOBS ARE TOP-LEVEL. A reusable workflow (`on: workflow_call`)
 *      binds no environment, and no caller passes `secrets: inherit`: a
 *      registry's trust binding names the CALLING file. A release workflow
 *      calls only the reusable workflows RELEASE_CALLS records, and passes them
 *      no secret; a local call names a workflow of this repository.
 *   7. ONE SHAPE PER REGISTRY. In sdk-publish.yml, `pack-<registry>` and
 *      `publish-<registry>` name a registry that has publish units, and
 *      `publish-<registry>` binds THAT registry's environment (the conclude job
 *      relies on the names). Every unit's tag (`tagFormat`) is matched by the
 *      workflow's tag trigger and by the protected release-tag patterns; its
 *      registry has exactly one environment, whose tag policy the operator's
 *      applier DERIVES from the units (it is never written out here); every
 *      registry environment has units; each trust binding names a declared
 *      environment of its registry and an existing workflow.
 *   8. ACTIONS. Every third-party `uses:`, a step's action or a job's reusable
 *      workflow, is pinned to a full commit SHA and allowed by
 *      `allowedActions`; every allowed entry is used somewhere (an allowance
 *      nobody needs is a standing hole).
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
 *  12. THIS RUN'S ARTIFACT, ON A TAG PUSH (plan §5). A credentialed job
 *      downloads artifacts from its own run only (no `run-id`, `github-token`
 *      or `repository` input on download-artifact), and, in a workflow that
 *      runs on anything but a tag push, its `if:` requires one
 *      (`github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')`,
 *      never ORed away): a dry run publishes nothing.
 *  13. THE PUBLIC GATE RUNS (#794 review). verify.yml runs `pnpm run verify` on
 *      every push to main and every pull request, with no path filter, in a
 *      job and a step with no `if:` and no `continue-on-error`. sdk-publish.yml
 *      and cli-release.yml run these rules over the tagged commit in a first
 *      job everything else needs (declared in verify-declarations.mjs).
 *
 * Exit codes: 0 clean, 1 at least one finding, 2 unreadable input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isEntry } from "../lib/is-entry.mjs";
import { shellCommands } from "./shell-commands.mjs";

export const SETTINGS = "tools/repo-gates/release-settings.json";
export const MANIFEST = "dagger/sdk-manifest.json";
export const WORKFLOWS = ".github/workflows";
export const PUBLISH_WORKFLOW = "sdk-publish.yml";
export const CLI_WORKFLOW = "cli-release.yml";
export const VERIFY_WORKFLOW = "verify.yml";

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
 * Rule 3's recorded exceptions: the one command a credentialed job needs that
 * the allowlist below does not hold, exact, for its workflow and job only.
 * Each is matched against the whole command, so a prefix assignment, an extra
 * argument or a chained command is not the exception.
 *   crates.io (#900): `cargo publish --no-verify` packages the commit again and
 *     compiles nothing; crates.io takes no prebuilt archive.
 *   pub.dev (#900): `dart pub publish --force` packs and uploads in one
 *     command, and pub.dev accepts it only from the OIDC job.
 *   cli.confeature.io (#801): publish-r2.sh is the only writer of the bucket
 *     (it checks every binary against SHA256SUMS, refuses to rewrite a
 *     released version, and moves `latest` forward only), so the two jobs
 *     holding the R2 token run it, each with its one verb.
 */
export const PUBLISH_EXCEPTIONS = {
  [PUBLISH_WORKFLOW]: {
    "publish-crates": [/^cargo "\+\$\{RUST_VERSION\}" publish --no-verify$/],
    "publish-pubdev": [/^dart pub publish --force$/],
  },
  [CLI_WORKFLOW]: {
    upload: [/^bash apps\/cli\/scripts\/publish-r2\.sh upload "\$\{TAG#cli-v\}" dist$/],
    promote: [/^bash apps\/cli\/scripts\/publish-r2\.sh promote "\$\{TAG#cli-v\}"$/],
  },
};

/**
 * The reusable workflows a release workflow may call (rule 6), exact. A called
 * workflow runs with the caller's token, so a release workflow calls none but
 * these. cli-windows-install-verify.yml installs the CLI from the public host
 * between upload and promote: it binds no environment (rule 6), receives no
 * secret (checked), and its own jobs are held to every rule here.
 */
export const RELEASE_CALLS = {
  [PUBLISH_WORKFLOW]: [],
  [CLI_WORKFLOW]: ["./.github/workflows/cli-windows-install-verify.yml"],
};

/**
 * Cache inputs (rule 3): any value but `false` restores a cache. setup-uv's
 * `enable-cache` defaults to "auto", which caches on GitHub-hosted runners.
 */
const CACHE_INPUTS = ["cache", "enable-cache", "bundler-cache", "cache-jdk"];
/** Actions that restore a cache unless the named input is false, which they must therefore say. */
const DEFAULT_CACHE = new Map([
  ["actions/setup-go", "cache"],
  ["astral-sh/setup-uv", "enable-cache"],
]);
const isFalse = (v) => v === false || v === "false";
const PINNED_SELF_INSTALL = /^npm install --global --ignore-scripts "?npm@\$\{?NPM_VERSION\}?"?$/;

/**
 * Variables that decide what a later command runs or loads: a credentialed job
 * never sets one, in a `run:` block or an `env:` map. GIT_SSH_COMMAND is the
 * deploy-key jobs' one need, and is allowed as plain `ssh` with no config file
 * and no option that runs a command (SSH_COMMAND_RUNS).
 */
const EXEC_ENV =
  /^(?:PATH|HOME|ENV|BASH_ENV|BASH_FUNC_\w+|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LD_\w+|DYLD_\w+|GIT_(?!SSH_COMMAND$)\w+|SSH_ASKPASS|XDG_CONFIG_HOME|CURL_HOME|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_\w+|npm_config_\w+|RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|BUNDLE_\w+|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|CARGO_HOME|CARGO_BUILD_\w+|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_HOME|RUSTUP_TOOLCHAIN|NUGET_PLUGIN_PATHS|PUB_CACHE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)$/;
const SSH_COMMAND_RUNS =
  /ProxyCommand|LocalCommand|KnownHostsCommand|-F\s+(?!\/dev\/null(?:\s|$))/i;

/** A word as bash sees it once quoting is removed, near enough to read an option. */
const dequote = (w) => w.replace(/\\(.)/g, "$1").replace(/['"]/g, "");

/** Why setting `name` to `value` is refused, or null. */
function envProblem(name, value) {
  if (name === "GIT_SSH_COMMAND")
    return /^ssh\s/.test(value) && !SSH_COMMAND_RUNS.test(value)
      ? null
      : "GIT_SSH_COMMAND must be plain `ssh -F /dev/null …`, with no option that runs a command";
  return EXEC_ENV.test(name) ? `it sets ${name}, which decides what a later command runs` : null;
}
const assignmentProblem = (word) => {
  const m = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=(.*)$/s.exec(word);
  return m === null ? null : envProblem(m[1], dequote(m[2]));
};

const ok = () => null;
/** The command only with exactly these leading words. */
const only =
  (...sub) =>
  (args, name) =>
    sub.every((s, n) => args[n] === s) ? null : `${name} runs only \`${name} ${sub.join(" ")}\``;
const GIT_SUBCOMMANDS = new Set(["init", "fetch", "push", "bundle", "rev-parse"]);
const SED_SCRIPT = /^s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpI0-9]*$/;

/**
 * Rule 3's allowlist: every program a credentialed job may run, and, where
 * the program can run another, the arguments it may take. It is what the jobs
 * bound to an environment run today, and nothing else: shell builtins, file and
 * text tools that run no program, curl, git's transport commands, and each
 * registry client's upload. Functions the block defines are allowed (their
 * bodies are commands too, and are checked). Anything else is refused.
 */
export const CREDENTIALED_COMMANDS = {
  // Shell builtins: control and state, never another program.
  "[": ok,
  test: ok,
  ":": ok,
  true: ok,
  false: ok,
  echo: ok,
  printf: ok,
  exit: ok,
  return: ok,
  cd: ok,
  umask: ok,
  set: ok,
  read: ok,
  local: ok,
  export: (args) => args.map(assignmentProblem).find((p) => p !== null) ?? null,
  // File and text tools: they read and write files and run nothing, except
  // through the options refused here.
  mkdir: ok,
  rm: ok,
  ls: ok,
  cat: ok,
  head: ok,
  tail: ok,
  wc: ok,
  tr: ok,
  cut: ok,
  grep: ok,
  basename: ok,
  dirname: ok,
  sha256sum: ok,
  shasum: ok,
  sort: (args) =>
    args.some((a) => a.startsWith("--compress-program"))
      ? "sort --compress-program runs a program"
      : null,
  find: (args) =>
    args.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a)) ? "find -exec runs a program" : null,
  sed: (args) => {
    const script = args.filter((a) => !/^-[nEr]$|^--quiet$/.test(a));
    return script.length >= 1 && SED_SCRIPT.test(script[0]) && !script[0].startsWith("-")
      ? null
      : "sed runs only one s/…/…/ script ([gpI0-9] flags: never e or w)";
  },
  curl: ok,
  // git's transport, which runs nothing locally unless told to.
  git: (args) => {
    if (!GIT_SUBCOMMANDS.has(args[0]))
      return `git runs only ${[...GIT_SUBCOMMANDS].join(", ")} (and no option before them)`;
    return args.some((a) => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(a))
      ? "git --upload-pack, --receive-pack and --exec run a program"
      : null;
  },
  // Each registry client, for its upload only.
  npm: (args, _name, text) =>
    PINNED_SELF_INSTALL.test(text) || (args[0] === "publish" && args.includes("--ignore-scripts"))
      ? null
      : "npm runs only `publish --ignore-scripts`, or installs itself at NPM_VERSION",
  gem: only("push"),
  dotnet: only("nuget", "push"),
  aws: only("s3api"),
  rustup: only("toolchain", "install"),
};

/** Words a command may start with that are grammar, not a program. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
for (const k of ["!", "{", "}", "esac"]) KEYWORDS.add(k);
/** Headers whose remaining words are data (their substitutions are scanned on their own). */
const HEADERS = new Set(["for", "case", "function", "select"]);

/** Why one simple command may not run in a credentialed job, or null. */
function commandProblem(words, functions, exceptions) {
  let k = 0;
  while (k < words.length && KEYWORDS.has(words[k])) k += 1;
  const rest = words.slice(k);
  if (rest.length === 0 || HEADERS.has(rest[0])) return null;
  if (exceptions.some((re) => re.test(rest.join(" ")))) return null;
  let n = 0;
  for (; n < rest.length && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(rest[n]); n += 1) {
    const p = assignmentProblem(rest[n]);
    if (p !== null) return p;
  }
  const cmd = rest.slice(n);
  if (cmd.length === 0) return null; // assignments only
  const [name, ...args] = cmd;
  if (functions.has(name)) return null;
  if (!Object.hasOwn(CREDENTIALED_COMMANDS, name))
    return `${name} is not a command a credentialed job runs`;
  return CREDENTIALED_COMMANDS[name](args.map(dequote), name, cmd.join(" "));
}

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

/** Rule 3's allowlist over one `run:` block of a job bound to an environment. */
function credentialedRun(file, where, run, { jobId, add }) {
  const { commands, functions, problems } = shellCommands(run);
  for (const p of problems) add(file, where, `a credentialed job's run: block has ${p}`);
  const exceptions = PUBLISH_EXCEPTIONS[file]?.[jobId] ?? [];
  for (const words of commands) {
    const why = commandProblem(words, functions, exceptions);
    if (why !== null) add(file, where, `a credentialed job runs \`${words.join(" ")}\`: ${why}`);
  }
  if (/\bGITHUB_(?:ENV|PATH)\b/.test(run))
    add(
      file,
      where,
      "a credentialed job writes GITHUB_ENV or GITHUB_PATH, which decide what a later step runs",
    );
}

function runRules(file, where, run, ctx) {
  const { credentialed, isPackOrPublish, pins, add } = ctx;
  if (run.includes("${{"))
    add(file, where, "a run: block interpolates ${{ }} (pass it through env:)");
  if (credentialed) credentialedRun(file, where, run, ctx);
  if (isPackOrPublish) {
    const lines = run
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
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

/**
 * Rule 8 for one `uses:` reference, a step's action or a job's reusable
 * workflow: pinned to a full commit SHA, and allowed. Returns the `owner/repo`.
 */
function pinRules(file, where, uses, { allowed, used, add }) {
  const [repoPath, ref] = uses.split("@");
  const repo = repoPath.split("/").slice(0, 2).join("/");
  const owner = repo.split("/")[0];
  if (!/^[0-9a-f]{40}$/.test(ref ?? "")) add(file, where, `uses ${uses} without a full commit SHA`);
  if (owner !== "actions" && owner !== "github") {
    used.add(`${repo}@*`);
    if (!allowed.includes(`${repo}@*`))
      add(file, where, `uses ${repo}, which ${SETTINGS} does not allow`);
  }
  return repo;
}

function usesRules(file, where, step, ctx) {
  const { credentialed, isPackOrPublish, pins, add } = ctx;
  const uses = step.uses;
  if (uses.startsWith("./") || uses.startsWith("docker://")) {
    // A local action is repository code; a container image is code no SHA or
    // allow-list entry pins. Neither runs where an artifact or a credential is.
    if (isPackOrPublish)
      add(
        file,
        where,
        `uses ${uses}: a pack or credentialed job runs no local or container action`,
      );
    return;
  }
  const repo = pinRules(file, where, uses, ctx);
  const w = step.with ?? {};
  const caches =
    repo === "actions/cache" ||
    CACHE_INPUTS.some((k) => k in w && !isFalse(w[k])) ||
    (DEFAULT_CACHE.has(repo) && !isFalse(w[DEFAULT_CACHE.get(repo)]));
  if (isPackOrPublish && caches) add(file, where, "a pack or credentialed job restores a cache");
  if (credentialed && repo === "actions/checkout" && w["persist-credentials"] !== false)
    add(
      file,
      where,
      "a credentialed job's checkout keeps its credential (persist-credentials: false)",
    );
  // §5: a credentialed job uploads only what THIS run packed.
  if (credentialed && repo === "actions/download-artifact")
    for (const k of ["run-id", "github-token", "repository"])
      if (k in w)
        add(file, where, `a credentialed job downloads an artifact from another run (${k}:)`);
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

/** Rules 6 and 8 for a job that calls a reusable workflow (a job-level `uses:`). */
function callRules(file, jobId, job, ctx) {
  const { workflows, add } = ctx;
  const uses = job.uses;
  const release = Object.hasOwn(RELEASE_CALLS, file);
  if (release && !RELEASE_CALLS[file].includes(uses))
    add(file, jobId, `a release workflow calls ${uses}, which RELEASE_CALLS does not record`);
  if (release && job.secrets !== undefined)
    add(file, jobId, "a release workflow passes secrets to a called workflow");
  if (uses.startsWith("./")) {
    const m = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/.exec(uses);
    if (m === null || !(m[1] in workflows))
      add(file, jobId, `calls ${uses}, which is not a workflow of this repository`);
  } else pinRules(file, jobId, uses, ctx);
}

/**
 * Whether a workflow runs only on a tag push: `on: push` with `tags`, and no
 * branch filter or other trigger. Its jobs need no `if:` to stay off branches.
 */
function tagPushOnly(doc) {
  const on = doc?.on ?? doc?.[true];
  const push = on?.push;
  const triggers = triggersOf(doc);
  return (
    triggers.length === 1 &&
    triggers[0] === "push" &&
    Array.isArray(push?.tags) &&
    push.branches === undefined &&
    push["branches-ignore"] === undefined
  );
}

/** What only a job bound to an environment is held to, beyond its steps (rule 3, §5). */
function credentialedJobRules(file, jobId, job, doc, add) {
  if (job?.container !== undefined || job?.services !== undefined)
    add(
      file,
      jobId,
      "a credentialed job runs in a container or beside services, whose images no rule pins",
    );
  const cond = typeof job?.if === "string" ? job.if : "";
  if (
    !tagPushOnly(doc) &&
    (!/github\.event_name\s*==\s*'push'/.test(cond) ||
      !/startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/'\s*\)/.test(cond) ||
      cond.includes("||"))
  )
    add(
      file,
      jobId,
      "a credentialed job's if: does not require a tag push (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/'))",
    );
  const shells = [
    doc?.defaults?.run?.shell,
    job?.defaults?.run?.shell,
    ...(Array.isArray(job?.steps) ? job.steps.map((s) => s?.shell) : []),
  ];
  for (const sh of shells)
    if (sh !== undefined && !/^bash(?:\s+[-\w]+)*(?:\s+\{0\})?$/.test(String(sh)))
      add(file, jobId, `a credentialed job runs a shell other than bash (${String(sh)})`);
  const envMaps = [
    doc?.env,
    job?.env,
    ...(Array.isArray(job?.steps) ? job.steps.map((s) => s?.env) : []),
  ];
  for (const map of envMaps)
    for (const [k, v] of Object.entries(map ?? {})) {
      const why = envProblem(k, String(v));
      if (why !== null) add(file, jobId, `a credentialed job's env: ${why}`);
    }
}

/** Rules 1, 2, 3, 5, 6, 9 and the action half of 8, for one job. */
function jobRules({ file, jobId, job, doc, reusable, envs, workflows, allowed, used, pins, add }) {
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
  // Rule 3 holds EVERY job bound to an environment, not only a registry's:
  // cli-release's upload and promote hold the R2 token (#794 review).
  const isPackOrPublish = credentialed || jobId.startsWith("pack-");
  const ctx = { jobId, credentialed, isPackOrPublish, workflows, allowed, used, pins, add };
  if (credentialed) credentialedJobRules(file, jobId, job, doc, add);
  if (typeof job?.uses === "string") callRules(file, jobId, job, ctx);
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
      jobRules({ file, jobId, job, doc, reusable, envs, workflows, allowed, used, pins, add });
  }
  for (const a of allowed)
    if (!used.has(a)) add(SETTINGS, "-", `allows ${a}, which no workflow uses`);
  shapeRules({ settings, manifest, workflows, envs, add });
  mirrorRules({ settings, manifest, envs, add });
  return out;
}

/**
 * Rule 13, over the workflows: `pnpm run verify` runs on every push to main
 * and every pull request, in a job and a step that nothing can skip. Separate
 * from `findings` so the rule fixtures need not each carry a verify.yml.
 */
export function publicGateFindings(workflows) {
  const out = [];
  const add = (why) => out.push({ file: VERIFY_WORKFLOW, job: "-", why });
  const doc = workflows[VERIFY_WORKFLOW];
  if (doc === undefined) {
    add("is missing: `pnpm run verify` would run on no automated path");
    return out;
  }
  const on = doc?.on ?? doc?.[true];
  const triggers = triggersOf(doc);
  if (!triggers.includes("push") || !(on?.push?.branches ?? []).includes("main"))
    add("does not run on every push to main");
  if (!triggers.includes("pull_request")) add("does not run on every pull request");
  for (const t of ["push", "pull_request"])
    for (const k of ["paths", "paths-ignore"])
      if (on?.[t]?.[k] !== undefined) add(`filters ${t} by ${k}, so a change can skip the gate`);
  const runsGate = Object.values(doc?.jobs ?? {}).some(
    (job) =>
      job?.if === undefined &&
      job?.["continue-on-error"] === undefined &&
      (Array.isArray(job?.steps) ? job.steps : []).some(
        (s) =>
          typeof s?.run === "string" &&
          s.run.trim() === "pnpm run verify" &&
          s.if === undefined &&
          s["continue-on-error"] === undefined,
      ),
  );
  if (!runsGate) add("has no step that runs `pnpm run verify` and cannot be skipped");
  return out;
}

/** Read the repository at `root` and return the findings. Throws on unreadable input. */
export function verifyWorkflows(root) {
  const settings = JSON.parse(readFileSync(join(root, SETTINGS), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const workflows = {};
  for (const f of readdirSync(join(root, WORKFLOWS)).filter((n) => /\.ya?ml$/.test(n)))
    workflows[f] = parseYaml(readFileSync(join(root, WORKFLOWS, f), "utf8"));
  return [...findings({ settings, manifest, workflows }), ...publicGateFindings(workflows)];
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
