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
 *   3. CREDENTIALED JOBS FAIL CLOSED ON GRAMMAR. EVERY job bound to an
 *      environment (a registry's, or cli-release's, whose two jobs hold the R2
 *      token) is held to strict-shell.mjs's minimal grammar (simple commands,
 *      plain words, quotes holding only `$NAME`, plain if/then/else/fi;
 *      everything else refused outright), and runs only CREDENTIALED_COMMANDS,
 *      each with its exact option spellings and pinned destinations, plus its
 *      PUBLISH_EXCEPTIONS (the one reviewed command crates.io, pub.dev, the
 *      Maven bucket and the CLI bucket each need, exact, for its job only). It
 *      writes only publish-tmp/, sets only CREDENTIALED_ENV variables, names
 *      no GITHUB_ENV, GITHUB_PATH or runner temp directory, sets no
 *      working-directory, runs only plain bash on an ubuntu-* runner, in no
 *      container, beside no service, with no local or container action, and
 *      keeps no checkout credential. It uses no cache: no `actions/cache`, no
 *      `cache:` / `enable-cache:` / `bundler-cache:` / `cache-jdk:` input
 *      other than false — nor does a pack job, whose artifact the publish job
 *      uploads; an action that caches unless told not to (DEFAULT_CACHE:
 *      setup-go, setup-uv) must say false. A job that does not fit is
 *      simplified, never the grammar widened (#794 review, round 3).
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
 *  13. THE PUBLIC GATE RUNS (#794 review). verify.yml runs PUBLIC_GATE_STEPS
 *      (`pnpm run verify` and the CLI's deno suite) on every push to main and
 *      every pull request, unfiltered, under plain bash, with no step env,
 *      working-directory or continue-on-error, in jobs that need nothing.
 *      Below the workflow, a pack or credentialed job's or step's env: never
 *      redefines a workflow env name, and its *_VERSION values are exact (or
 *      the resolver's unit version).
 *  16. EVERY REFERENCE NAMES SOMETHING (round 5). In the two release
 *      workflows, each needs./steps./env./inputs. reference names a direct
 *      need and its output, an earlier step id, an env name in scope, an input.
 *  15. NO UNDEFINED VARIABLE (round 4). A pack or credentialed run block reads
 *      only variables its step's, job's or workflow's env: defines, it assigns
 *      itself, or RUNNER_DEFAULTS lists.
 *  14. THE RULES GATE THE RELEASES. sdk-publish.yml and cli-release.yml run
 *      these rules over the tagged commit in a first job, workflow-rules,
 *      which nothing can skip and every other job transitively needs.
 *
 * Exit codes: 0 clean, 1 at least one finding, 2 unreadable input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isEntry } from "../lib/is-entry.mjs";
import { lexStrict } from "./strict-shell.mjs";

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
 * Each is matched against the whole command (its raw words), so a prefix
 * assignment, an extra argument, a redirection or a chained command is not
 * the exception; no credentialed job may `cd` or set working-directory, so the
 * path each names is the checkout's.
 *   crates.io (#900): `cargo publish --no-verify` packages the commit again and
 *     compiles nothing; crates.io takes no prebuilt archive.
 *   pub.dev (#900): `dart pub publish --force` packs and uploads in one
 *     command, and pub.dev accepts it only from the OIDC job.
 *   maven.confeature.io (#902): maven-r2-upload.sh, whose ordering and
 *     immutability logic is outside the strict grammar (round 3).
 *   cli.confeature.io (#801): publish-r2.sh is the only writer of the bucket
 *     (it checks every binary against SHA256SUMS, refuses to rewrite a
 *     released version, and moves `latest` forward only), so the two jobs
 *     holding the R2 token run it, each with its one verb.
 */
export const PUBLISH_EXCEPTIONS = {
  [PUBLISH_WORKFLOW]: {
    "publish-crates": [
      /^cargo "\+\$\{RUST_VERSION\}" publish --no-verify --manifest-path "\$\{UNIT_PATH\}\/Cargo\.toml"$/,
    ],
    "publish-pubdev": [/^dart pub publish --force --directory "\$\{UNIT_PATH\}"$/],
    "publish-maven": [/^bash tools\/sdk-pack\/maven-r2-upload\.sh release$/],
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
 * Rule 3's environment allowlist, and each name's one value (rounds 3 to 6):
 * the only variables a credentialed job may set, in the workflow's, the job's
 * or a step's env:, each pinned. A blocklist of "dangerous" names missed
 * DOTNET_STARTUP_HOOKS and friends (round 3); an unpinned allowed name took
 * `${{ secrets['X'] }}`, `${{ toJSON(secrets) }}` or `${{ github['token'] }}`
 * and carried it into a tag name (round 6). So every allowed name has an
 * exact form: a literal, a resolver or pack output of THIS job's chain, a
 * declared secret written exactly `${{ secrets.NAME }}` (rule 1 checks the
 * declaration), or the named step output of an OIDC exchange.
 * A function of the job id: a publish job trusts its own pack job's outputs.
 */
const EXPR = (e) => new RegExp(`^\\$\\{\\{\\s*${e}\\s*\\}\\}$`);
const LIT = (v) => new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
const VERSION_PIN = /^\d+\.\d+\.\d+$/;
const SECRET_PIN = EXPR("secrets\\.[A-Z][A-Z0-9_]*");
const PACK = (jobId, out) =>
  EXPR(`needs\\.${jobId.replace(/^publish-/, "pack-")}\\.outputs\\.${out}`);
const WS = "\\$\\{\\{ github\\.workspace \\}\\}";
export const PINNED_ENV = {
  NODE_VERSION: () => VERSION_PIN,
  NPM_VERSION: () => VERSION_PIN,
  UV_VERSION: () => VERSION_PIN,
  TWINE_VERSION: () => VERSION_PIN,
  RUST_VERSION: () => VERSION_PIN,
  RUBY_VERSION: () => VERSION_PIN,
  DOTNET_VERSION: () => VERSION_PIN,
  DART_VERSION: () => VERSION_PIN,
  GO_VERSION: () => VERSION_PIN,
  JAVA_VERSION: () => VERSION_PIN,
  DENO_VERSION: () => VERSION_PIN,
  MAVEN_URL: () => LIT("https://maven.confeature.io"),
  MAVEN_BUCKET: () => LIT("confeature-maven"),
  GITHUB_SSH_KNOWN_HOST: () => /^github\.com ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/,
  UNIT_PATH: () => EXPR("needs\\.setup\\.outputs\\.path"),
  UNIT_VERSION: () => EXPR("needs\\.setup\\.outputs\\.version"),
  UNIT_COORDINATES: () => EXPR("needs\\.setup\\.outputs\\.coordinates"),
  UNIT_NAME: () => EXPR("needs\\.setup\\.outputs\\.name"),
  RELEASE_TAG: () => EXPR("needs\\.setup\\.outputs\\.releaseTag"),
  MIRROR_TAG: () => EXPR("needs\\.setup\\.outputs\\.mirrorTag"),
  TAG: () => EXPR("github\\.ref_name"),
  ARTIFACT: (j) => PACK(j, "file"),
  EXPECTED_SHA256: (j) => PACK(j, "sha256"),
  EXPECTED_SUMS: (j) => PACK(j, "sums"),
  SPLIT_SHA: (j) => PACK(j, "split"),
  EXPECTED: () => EXPR("needs\\.release\\.outputs\\.sums-digest"),
  DEPLOY_KEY: () => SECRET_PIN,
  R2_ACCESS_KEY_ID: () => SECRET_PIN,
  R2_SECRET_ACCESS_KEY: () => SECRET_PIN,
  CLOUDFLARE_ACCOUNT_ID: () => SECRET_PIN,
  MAVEN_R2_ACCESS_KEY_ID: () => SECRET_PIN,
  MAVEN_R2_SECRET_ACCESS_KEY: () => SECRET_PIN,
  NUGET_API_KEY: () => EXPR("steps\\.login\\.outputs\\.NUGET_API_KEY"),
  CARGO_REGISTRY_TOKEN: () => EXPR("steps\\.auth\\.outputs\\.token"),
  DOTNET_NOLOGO: () => LIT("1"),
  DOTNET_CLI_TELEMETRY_OPTOUT: () => LIT("1"),
  CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: () => LIT("fallback"),
  GIT_SSH_COMMAND: () =>
    new RegExp(
      `^ssh -F /dev/null -i ${WS}/publish-tmp/ssh/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${WS}/publish-tmp/ssh/known_hosts$`,
    ),
  GIT_ALLOW_PROTOCOL: () => LIT("ssh"),
  GIT_CONFIG_GLOBAL: () => LIT("/dev/null"),
  GIT_CONFIG_NOSYSTEM: () => LIT("1"),
};
export const CREDENTIALED_ENV = new Set(Object.keys(PINNED_ENV));
const SSH_COMMAND_RUNS =
  /ProxyCommand|LocalCommand|KnownHostsCommand|ProxyJump|-F\s+(?!\/dev\/null(?:\s|$))/i;

/**
 * Names that point git, curl and every tool at a configuration file of the
 * job's choosing (a .gitconfig or .curlrc written into publish-tmp): never set
 * in a credentialed job, however spelled, except the belt-and-braces values
 * that turn the global and system git config off.
 */
const CONFIG_HOMES = new Map([
  ["HOME", null],
  ["XDG_CONFIG_HOME", null],
  ["GIT_CONFIG_GLOBAL", "/dev/null"],
  ["GIT_CONFIG_NOSYSTEM", "1"],
]);

/** Why a credentialed job may not set `name` to `value`, or null. */
function envProblem(name, value) {
  if (CONFIG_HOMES.has(name))
    return CONFIG_HOMES.get(name) === value
      ? null
      : `it sets ${name}, which points every tool at another configuration`;
  if (!CREDENTIALED_ENV.has(name)) return `it sets ${name}, which CREDENTIALED_ENV does not allow`;
  if (name === "GIT_SSH_COMMAND" && (!/^ssh\s/.test(value) || SSH_COMMAND_RUNS.test(value)))
    return "GIT_SSH_COMMAND must be plain `ssh -F /dev/null …`, with no option that runs a command";
  if (name === "GIT_ALLOW_PROTOCOL" && !/^(?:ssh|file|ssh:file)$/.test(value))
    return "GIT_ALLOW_PROTOCOL allows ssh and file only";
  return null;
}

const FLAG = "flag";
const LITERAL = "literal";
const VALUE = "value";
/** The one scratch directory a credentialed job writes (and removes). */
const SCRATCH = /^publish-tmp(?:\/[A-Za-z0-9._-]+)*$/;
const scratchOnly = (name) => (ops) =>
  ops.every((w) => SCRATCH.test(w.text) && !w.text.split("/").includes(".."))
    ? null
    : `${name} touches only publish-tmp/`;
/** The printf formats the credentialed jobs use, as bash passes them (unquoted). */
const PRINTF_FORMATS = new Set(["%s\\n", "%s  %s\\n"]);
const SED_SCRIPT = /^s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1g?$/;

/**
 * Why `args` (lexed words) may not follow `name` under `spec`, or null.
 *
 *   options    exact spellings only, each FLAG, LITERAL (a literal value),
 *              VALUE (a value that may be an expansion: the parser consumes it
 *              as a value) or "=<x>" (exactly x). `--opt=value` and
 *              `--opt value` are both read. No abbreviation, no unlisted option.
 *   eoo        the end-of-options word the tool honours (`--`,
 *              `--end-of-options`): an operand starting with an expansion is
 *              allowed only after it, since one could expand to an option.
 *   positional "none", "literal" or "any"; `check(operands)` sees the rest.
 *   require    options that must be present.
 */
function argsProblem(name, args, spec) {
  let afterEoo = false;
  const operands = [];
  const seen = new Set();
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k];
    if (!afterEoo && spec.eoo !== undefined && w.text === spec.eoo) {
      afterEoo = true;
      continue;
    }
    if (!afterEoo && !w.leadsWithExpansion && w.text.startsWith("-") && w.text !== "-") {
      if (w.hasExpansion) return `${name}: the option ${w.raw} is not a literal word`;
      const eq = w.text.startsWith("--") ? w.text.indexOf("=") : -1;
      const opt = eq === -1 ? w.text : w.text.slice(0, eq);
      const kind = Object.hasOwn(spec.options ?? {}, opt) ? spec.options[opt] : undefined;
      if (kind === undefined) return `${name}: ${opt} is not an option it may take`;
      seen.add(opt);
      if (kind === FLAG) {
        if (eq !== -1) return `${name}: ${opt} takes no value`;
        continue;
      }
      const value = eq !== -1 ? { text: w.text.slice(eq + 1), hasExpansion: false } : args[++k];
      if (value === undefined) return `${name}: ${opt} needs a value`;
      if (kind === LITERAL && value.hasExpansion) return `${name}: ${opt} takes a literal value`;
      if (kind.startsWith("=") && (value.hasExpansion || value.text !== kind.slice(1)))
        return `${name}: ${opt} must be exactly ${kind.slice(1)}`;
      continue;
    }
    if (w.leadsWithExpansion && !afterEoo)
      return `${name}: ${w.raw} starts with an expansion, which could become an option`;
    if (spec.positional === "none") return `${name} takes no operand here`;
    if (spec.positional === "literal" && w.hasExpansion) return `${name}: ${w.raw} must be literal`;
    operands.push(w);
  }
  for (const r of spec.require ?? []) if (!seen.has(r)) return `${name} must run with ${r}`;
  return spec.check?.(operands) ?? null;
}

/** A git refspec a credentialed push or fetch may name: never forced, never a transport. */
const refspecOk = (w) =>
  /^(?:HEAD|refs\/[^:]+):refs\/(?:heads|tags)\/[^:]+$/.test(w.text) && !w.text.includes("::");
/** A remote: a literal URL of a repository the settings name, or (fetch) a received bundle. */
function remoteOk(w, remotes, bundle) {
  // Neither shape's character class admits `$`, `{` or `::`: an expansion never matches.
  if (bundle && /^release\/[A-Za-z0-9._-]+\.bundle$/.test(w.text)) return true;
  const m =
    /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\.git$/.exec(
      w.text,
    );
  return m !== null && remotes.has(m[1]);
}
const GIT_DIR = /^--git-dir=publish-tmp(?:\/[A-Za-z0-9._-]+)+$/;
function gitProblem(args, ctx) {
  let k = 0;
  while (k < args.length && args[k].text.startsWith("-")) {
    if (args[k].hasExpansion || !GIT_DIR.test(args[k].text))
      return `git: ${args[k].raw} is not a global option it may take (--git-dir=publish-tmp/… only)`;
    k += 1;
  }
  const sub = args[k]?.text;
  const rest = args.slice(k + 1);
  const transport = (fetch) => (ops) => {
    if (ops.length < 2 || !remoteOk(ops[0], ctx.remotes, fetch))
      return `git ${sub}: the remote must be a literal URL of a repository ${SETTINGS} names${fetch ? ", or a received release/*.bundle" : ""}`;
    return ops.slice(1).every(refspecOk)
      ? null
      : `git ${sub}: every refspec is <HEAD|refs/…>:refs/heads|tags/…, never forced`;
  };
  switch (args[k]?.text) {
    case "init":
      return argsProblem("git init", rest, {
        options: { "--quiet": FLAG, "--bare": FLAG },
        positional: "literal",
        check: scratchOnly("git init"),
      });
    case "bundle":
      if (rest[0]?.text !== "verify") return "git bundle runs only `verify`";
      return argsProblem("git bundle verify", rest.slice(1), {
        options: { "--quiet": FLAG },
        eoo: "--end-of-options",
        positional: "literal",
        check: (ops) =>
          ops.length === 1 && remoteOk(ops[0], ctx.remotes, true)
            ? null
            : "git bundle verify reads one received release/*.bundle",
      });
    case "fetch":
      return argsProblem("git fetch", rest, {
        options: { "--quiet": FLAG },
        eoo: "--end-of-options",
        positional: "any",
        check: transport(true),
      });
    case "push":
      return argsProblem("git push", rest, {
        options: { "--atomic": FLAG },
        eoo: "--end-of-options",
        positional: "any",
        check: transport(false),
      });
    case "rev-parse":
      return argsProblem("git rev-parse", rest, { positional: "literal" });
    default:
      return `git runs only init, bundle verify, fetch, push and rev-parse`;
  }
}

/**
 * Rule 3's allowlist: every program a credentialed job may run, with the exact
 * options each may take. It is what the jobs bound to an environment run
 * today, and nothing else. Each upload's destination is pinned: npm and gem
 * take no host option, dotnet's --source is nuget.org's, git's remote is a
 * literal repository of the settings, and curl reaches proxy.golang.org only,
 * writing nothing. What it promises: a credentialed run block runs these
 * programs, reaches these hosts, and writes only publish-tmp/ (and the pinned
 * npm's global prefix); anything else is refused.
 */
export const CREDENTIALED_COMMANDS = {
  "[": () => null,
  test: () => null,
  echo: () => null,
  exit: (a) => argsProblem("exit", a, { positional: "literal" }),
  // No option (bash strips the quotes, so `printf '-v' X` binds X), and only
  // the formats the jobs use: the arguments after one are data.
  printf: (a) =>
    a[0] !== undefined && !a[0].hasExpansion && PRINTF_FORMATS.has(a[0].text)
      ? null
      : `printf takes no option, and its format is one of ${[...PRINTF_FORMATS].map((f) => `'${f}'`).join(", ")}`,
  umask: (a) => argsProblem("umask", a, { positional: "literal" }),
  mkdir: (a) =>
    argsProblem("mkdir", a, {
      options: { "-p": FLAG },
      positional: "literal",
      check: scratchOnly("mkdir"),
    }),
  rm: (a) =>
    argsProblem("rm", a, {
      options: { "-rf": FLAG },
      positional: "literal",
      check: scratchOnly("rm"),
    }),
  ls: (a) => argsProblem("ls", a, { options: { "-1": FLAG }, positional: "literal" }),
  find: (a) => argsProblem("find", a, { options: { "-type": LITERAL }, positional: "literal" }),
  sort: (a) => argsProblem("sort", a, { positional: "none" }),
  cut: (a) =>
    argsProblem("cut", a, { options: { "-d": LITERAL, "-f": LITERAL }, positional: "none" }),
  cmp: (a) => argsProblem("cmp", a, { positional: "literal" }),
  sha256sum: (a) =>
    argsProblem("sha256sum", a, {
      options: { "--check": FLAG, "--strict": FLAG, "--quiet": FLAG },
      positional: "none",
    }),
  sed: (a) =>
    a.length === 1 && !a[0].hasExpansion && SED_SCRIPT.test(a[0].text)
      ? null
      : "sed runs one single-quoted s/…/…/ script (flag g at most)",
  curl: (a, ctx) =>
    argsProblem("curl", a, {
      options: {
        "-fsS": FLAG,
        "--tlsv1.2": FLAG,
        "--proto": "==https",
        "--retry": LITERAL,
        "--retry-delay": LITERAL,
        "--retry-all-errors": FLAG,
      },
      positional: "any",
      // Literal up to the module's /@v/: the proxy fetches whatever origin a
      // path names, so an expansion before it could carry a secret anywhere.
      // Exactly the module's version info: a prefix let `../`, `%2e`, `?` or
      // `@` (which curl collapses or reparses) leave the module (round 6).
      check: (ops) =>
        ops.length === 1 &&
        ctx.goProxyPrefixes.some((p) => ops[0].text === `${p}v\${UNIT_VERSION}.info`)
          ? null
          : `curl reaches only ${ctx.goProxyPrefixes.map((p) => `${p}v\${UNIT_VERSION}.info`).join(", ") || "no URL"}, exactly`,
    }),
  git: gitProblem,
  npm: (a, ctx) => {
    if (PINNED_SELF_INSTALL.test(ctx.text)) return null;
    if (a[0]?.text !== "publish")
      return "npm runs only `publish`, or installs itself at NPM_VERSION";
    return argsProblem("npm publish", a.slice(1), {
      options: { "--access": LITERAL, "--provenance": FLAG, "--ignore-scripts": FLAG },
      positional: "any",
      require: ["--ignore-scripts"],
      check: (ops) => (ops.length === 1 ? null : "npm publish uploads one tarball"),
    });
  },
  gem: (a) =>
    a[0]?.text === "push"
      ? argsProblem("gem push", a.slice(1), {
          positional: "any",
          check: (ops) => (ops.length === 1 ? null : "gem push uploads one gem"),
        })
      : "gem runs only `push`",
  dotnet: (a) =>
    a[0]?.text === "nuget" && a[1]?.text === "push"
      ? argsProblem("dotnet nuget push", a.slice(2), {
          options: { "--api-key": VALUE, "--source": "=https://api.nuget.org/v3/index.json" },
          positional: "any",
          require: ["--source"],
        })
      : "dotnet runs only `nuget push`",
  rustup: (a) =>
    a[0]?.text === "toolchain" && a[1]?.text === "install"
      ? argsProblem("rustup toolchain install", a.slice(2), {
          options: { "--profile": LITERAL },
          eoo: "--",
          positional: "any",
        })
      : "rustup runs only `toolchain install`",
};

/**
 * Rule 3, per environment (round 5): the commands each credentialed job may
 * run, exactly the ones it uses (a recorded exception aside). A secret can
 * leave a job only through a tool that talks to the network, so curl is the
 * Go job's alone, git the three git jobs', and each registry client its own
 * job's. An environment not listed runs nothing.
 */
export const ENVIRONMENT_COMMANDS = {
  "sdk-publish-npm": ["npm", "printf", "sha256sum"],
  "sdk-publish-pypi": [
    "cmp",
    "cut",
    "echo",
    "exit",
    "ls",
    "mkdir",
    "printf",
    "sed",
    "sha256sum",
    "sort",
  ],
  "sdk-publish-crates": ["rustup"],
  "sdk-publish-rubygems": ["gem", "printf", "sha256sum"],
  "sdk-publish-nuget": [
    "cmp",
    "cut",
    "dotnet",
    "echo",
    "exit",
    "ls",
    "mkdir",
    "printf",
    "sed",
    "sha256sum",
    "sort",
  ],
  "sdk-publish-pubdev": [],
  "sdk-publish-go": ["[", "curl", "echo", "exit", "git", "mkdir", "printf", "rm", "umask"],
  "sdk-publish-packagist": [
    "[",
    "cmp",
    "echo",
    "exit",
    "git",
    "mkdir",
    "printf",
    "rm",
    "sha256sum",
    "umask",
  ],
  "sdk-publish-swiftpm": [
    "[",
    "cmp",
    "echo",
    "exit",
    "git",
    "mkdir",
    "printf",
    "rm",
    "sha256sum",
    "umask",
  ],
  "sdk-publish-maven": [
    "cmp",
    "cut",
    "echo",
    "exit",
    "find",
    "mkdir",
    "printf",
    "sed",
    "sha256sum",
    "sort",
  ],
  "cli-release": ["printf", "sha256sum"],
};

/**
 * Why a command reads a credential outside its recorded position, or null
 * (round 5). A credential (an env value from `secrets.*`, a step output such
 * as an OIDC exchange's token, or github.token) may be read only as the
 * operand of an emptiness test, as dotnet's --api-key, or, for a deploy key,
 * by the one write that installs it: `printf '%s\n' "$KEY" > publish-tmp/ssh/key`.
 */
function credentialProblem(cmd, redirects, ctx) {
  const reads = (w) =>
    [...w.text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1])
      .filter((n) => ctx.creds.has(n));
  const name = cmd[0]?.text;
  for (const [k, w] of cmd.entries()) {
    for (const n of reads(w)) {
      const alone = w.text === `\${${n}}`;
      const prev = cmd[k - 1]?.text;
      // An emptiness test, and nothing else on its line: `[ -n "$K" -a … ]`
      // or `[ -n "$K" = abc ]` would compare it (round 6).
      const shape =
        name === "["
          ? cmd.length === 4 && cmd[3].raw === "]" && k === 2
          : name === "test" && cmd.length === 3 && k === 2;
      if (alone && shape && (prev === "-z" || prev === "-n")) continue;
      if (alone && name === "dotnet" && prev === "--api-key") continue;
      if (
        alone &&
        name === "printf" &&
        ctx.deployKeys.has(n) &&
        cmd.length === 3 &&
        k === 2 &&
        cmd[1].text === "%s\\n" &&
        redirects.length === 1 &&
        redirects[0].op === ">" &&
        redirects[0].word.text === "publish-tmp/ssh/key"
      )
        continue;
      return `it reads the credential ${n} outside its recorded position`;
    }
  }
  // A redirection target is never an expansion (refused above), so it reads none.
  return null;
}

/** The grammar keywords a credentialed run block may use: a plain if, nothing else. */
const KEYWORDS = new Set(["if", "then", "else", "fi"]);

/** Why one lexed command may not run in a credentialed job, or null. */
function commandProblem({ words, redirects }, exceptions, ctx) {
  let k = 0;
  // `.raw` on purpose, the one place: bash recognises a reserved word only
  // unquoted, and a quoted `'if'` is then judged as a command name (by .text).
  while (k < words.length && KEYWORDS.has(words[k].raw)) k += 1;
  const cmd = words.slice(k);
  for (const r of redirects) {
    const tgt = r.word;
    if (tgt.hasExpansion || tgt.text.split("/").includes(".."))
      return `a redirection target must be a literal path (${tgt.raw})`;
    if (r.op !== "<" && tgt.text !== "/dev/null" && !SCRATCH.test(tgt.text))
      return `a credentialed job writes only publish-tmp/ or /dev/null (${tgt.raw})`;
    // Input only from what the job wrote (publish-tmp/) or received (the
    // path of a download-artifact step of this job): never a device (bash
    // opens /dev/tcp/<host>/<port> as a socket), never the checkout's files,
    // which a symlink in the checkout could point anywhere (round 5).
    if (
      r.op === "<" &&
      tgt.text !== "/dev/null" &&
      !SCRATCH.test(tgt.text) &&
      !(ctx.downloads ?? []).some(
        (d) => tgt.text.startsWith(`${d}/`) && /^[A-Za-z0-9._/-]+$/.test(tgt.text),
      )
    )
      return `a credentialed job reads input only from publish-tmp/ or a path this job downloads to (${tgt.raw})`;
  }
  if (cmd.length === 0) return null;
  // The exceptions match the raw words: an exact spelling, quotes included,
  // is stricter than the unquoted text, never looser.
  const text = cmd.map((w) => w.raw).join(" ");
  if (redirects.length === 0 && exceptions.some((re) => re.test(text))) return null;
  if (cmd.some((w) => w.opExpansion))
    return "an operator expansion (${NAME…}) is allowed only in a recorded exception";
  const name = cmd[0].text;
  const leak = credentialProblem(cmd, redirects, ctx);
  if (leak !== null) return leak;
  if (
    /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(cmd[0].raw) ||
    /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(name)
  )
    return "a credentialed job assigns no variable";
  if (!Object.hasOwn(CREDENTIALED_COMMANDS, name))
    return `${name} is not a command a credentialed job runs`;
  if (!(ctx.commands[ctx.environment] ?? []).includes(name))
    return `${name} is not a command environment ${ctx.environment}'s job runs`;
  return CREDENTIALED_COMMANDS[name](cmd.slice(1), { ...ctx, text });
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

/** Rule 3's grammar and allowlist over one `run:` block of a job bound to an environment. */
function credentialedRun(file, where, run, ctx) {
  const { jobId, add } = ctx;
  const { commands, problems } = lexStrict(run);
  for (const p of problems) add(file, where, `a credentialed job's run: block has ${p}`);
  if (problems.length > 0) return;
  const exceptions = PUBLISH_EXCEPTIONS[file]?.[jobId] ?? [];
  for (const c of commands) {
    const why = commandProblem(c, exceptions, ctx);
    if (why !== null)
      add(
        file,
        where,
        `a credentialed job runs \`${c.words.map((w) => w.raw).join(" ")}\`: ${why}`,
      );
  }
}

/**
 * The runner's own variables a pack or credentialed run block may read
 * without defining them: an explicit, short list (rule 15). In a credentialed
 * job rule 3 refuses the runner-file ones by name anyway.
 */
export const RUNNER_DEFAULTS = new Set([
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_WORKSPACE",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "RUNNER_TEMP",
]);

/**
 * Rule 15 (#794 review, round 4): the variables a run block reads but neither
 * its step's, its job's or its workflow's `env:` defines, nor the block itself
 * assigns (`NAME=`, `local`/`export NAME=`, `read … NAME`, `for NAME in`), nor
 * the runner provides. publish-crates and publish-pubdev read `${UNIT_PATH}`
 * that nothing defined: cargo would have been handed /Cargo.toml after the
 * OIDC exchange, burning the version.
 */
export function undefinedVariables(run, defined) {
  const assigned = assignedNames(run);
  const used = new Set([...run.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]));
  return [...used].filter((n) => !defined.has(n) && !assigned.has(n) && !RUNNER_DEFAULTS.has(n));
}

/**
 * The names a block assigns, found only at command position (round 5): a
 * raw-text search let `# FOO=`, `echo "NAME=x"` or prose mask an undefined
 * read. A block the strict grammar reads is judged on its commands; any
 * other (a pack job's) on its text with quoted strings and comments removed,
 * a NAME= counting only at the start of a simple command (line start, or
 * after ; & | ( { then do else elif, local, export, readonly or declare).
 */
export function assignedNames(run) {
  const out = new Set();
  const lexed = lexStrict(run);
  if (lexed.problems.length === 0) {
    const KW = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!"]);
    for (const c of lexed.commands) {
      let k = 0;
      while (k < c.words.length && KW.has(c.words[k].raw)) k += 1;
      for (; k < c.words.length; k += 1) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(c.words[k].raw);
        if (m === null) break;
        out.add(m[1]);
      }
      const rest = c.words.slice(k);
      if (rest[0]?.raw === "read")
        for (const w of rest.slice(1)) if (/^[A-Za-z_]\w*$/.test(w.raw)) out.add(w.raw);
      if (rest[0]?.raw === "for" && /^[A-Za-z_]\w*$/.test(rest[1]?.raw ?? "")) out.add(rest[1].raw);
    }
    return out;
  }
  const bare = run
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/(^|\s)#.*$/gm, "$1");
  const AT = String.raw`(?:^|[;&|({]|\b(?:then|do|else|elif)\b)\s*`;
  for (const m of bare.matchAll(
    new RegExp(
      `${AT}(?:(?:local|export|readonly|declare(?:\\s+-\\w+)*)\\s+)?([A-Za-z_]\\w*)\\+?=`,
      "gm",
    ),
  ))
    out.add(m[1]);
  for (const m of bare.matchAll(
    new RegExp(
      `${AT}(?:while\\s+)?(?:IFS=\\S*\\s+)?read\\s+(?:-r\\s+)?((?:[A-Za-z_]\\w*[ \\t]*)+)`,
      "gm",
    ),
  ))
    for (const n of m[1].trim().split(/\s+/)) out.add(n);
  for (const m of bare.matchAll(new RegExp(`${AT}for\\s+([A-Za-z_]\\w*)\\s+in\\b`, "gm")))
    out.add(m[1]);
  return out;
}

function runRules(file, where, run, ctx) {
  const { credentialed, isPackOrPublish, pins, add } = ctx;
  if (isPackOrPublish)
    for (const n of undefinedVariables(run, ctx.defined))
      add(file, where, `reads $${n}, which no env: of its step, job or workflow defines`);
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
  // It lands where no script of the checkout lives, so it can replace none.
  if (credentialed && repo === "actions/download-artifact" && !["release", "dist"].includes(w.path))
    add(file, where, "a credentialed job downloads an artifact to release/ or dist/ only");
  if (credentialed && repo === "actions/checkout" && w.path !== undefined)
    add(file, where, "a credentialed job's checkout takes no path:");
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

/** The shell a credentialed step may run under: GitHub's default bash, named or not. */
const BASH = new Set(["bash", "bash --noprofile --norc -eo pipefail {0}"]);
/** Files through which a step changes what later steps run, or where the runner keeps them. */
const RUNNER_FILES = /GITHUB_ENV|GITHUB_PATH|RUNNER_TEMP|runner\.temp|_runner_file_commands/;

/**
 * Rule 12's tag-push condition: `github.event_name == 'push'` and
 * `startsWith(github.ref, 'refs/tags/')` as conjuncts of the top-level `&&`
 * chain, with no `||`, `!` or `!=` anywhere that could turn them off.
 */
/** The top-level `&&` conjuncts of a GitHub expression, trimmed. */
export function topConjuncts(cond) {
  const top = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cond.length; i += 1) {
    if (cond[i] === "(") depth += 1;
    else if (cond[i] === ")") depth -= 1;
    else if (depth === 0 && cond.startsWith("&&", i)) {
      top.push(cond.slice(start, i).trim());
      start = i + 2;
    }
  }
  top.push(cond.slice(start).trim());
  return top;
}

export function requiresTagPush(cond) {
  if (typeof cond !== "string" || /\|\||!/.test(cond)) return false;
  const top = topConjuncts(cond);
  return (
    top.some((c) => /^github\.event_name\s*==\s*'push'$/.test(c)) &&
    top.some((c) => /^startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/'\s*\)$/.test(c))
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
  if (typeof job?.["runs-on"] !== "string" || !job["runs-on"].startsWith("ubuntu-"))
    add(
      file,
      jobId,
      "a credentialed job runs on a Linux (ubuntu-*) runner only, whose default shell is bash",
    );
  if (!tagPushOnly(doc) && !requiresTagPush(job?.if))
    add(
      file,
      jobId,
      "a credentialed job's if: does not require a tag push (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/'), top-level conjuncts, no || or !)",
    );
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const shells = [
    doc?.defaults?.run?.shell,
    job?.defaults?.run?.shell,
    ...steps.map((s) => s?.shell),
  ];
  for (const sh of shells)
    if (sh !== undefined && !BASH.has(String(sh)))
      add(file, jobId, `a credentialed job runs a shell other than plain bash (${String(sh)})`);
  const dirs = [
    doc?.defaults?.run?.["working-directory"],
    job?.defaults?.run?.["working-directory"],
    ...steps.map((s) => s?.["working-directory"]),
  ];
  if (dirs.some((d) => d !== undefined))
    add(
      file,
      jobId,
      "a credentialed job sets working-directory: (an exception would resolve another script)",
    );
  for (const map of [doc?.env, job?.env, ...steps.map((s) => s?.env)])
    for (const [k, v] of Object.entries(map ?? {})) {
      const why = envProblem(k, String(v));
      if (why !== null) add(file, jobId, `a credentialed job's env: ${why}`);
      if (Object.hasOwn(PINNED_ENV, k) && !PINNED_ENV[k](jobId).test(String(v)))
        add(
          file,
          jobId,
          `a credentialed job's env: ${k} is ${String(v)}, not its pinned expression`,
        );
    }
  // One scope per name: a step never redefines what its job sets.
  for (const s of steps)
    for (const k of Object.keys(s?.env ?? {}))
      if (Object.hasOwn(job?.env ?? {}, k))
        add(file, jobId, `a credentialed job's step ${s?.name ?? "?"} redefines the job's ${k}`);
  if (RUNNER_FILES.test(JSON.stringify(job ?? null)))
    add(
      file,
      jobId,
      "a credentialed job names GITHUB_ENV, GITHUB_PATH or the runner's temp directory",
    );
}

/**
 * Rule 9 below the workflow (round 4): in a pack or credentialed job, a job's
 * or step's env: never redefines a name the workflow's env: sets (a job-level
 * `NPM_VERSION: npm:evil@1.0.0` still matched the pinned self-install), and
 * every `*_VERSION` it sets is an exact version, or the resolver's version of
 * the unit (`${{ needs.setup.outputs.version }}`, which resolve-publish holds
 * to semver).
 */
function pinScopeRules(file, jobId, job, doc, add) {
  const top = new Set(Object.keys(doc?.env ?? {}));
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const [where, map] of [
    [jobId, job?.env],
    ...steps.map((s, i) => [`${jobId} step ${s?.name ?? i + 1}`, s?.env]),
  ])
    for (const [k, v] of Object.entries(map ?? {})) {
      if (top.has(k)) add(file, where, `env ${k} redefines the workflow's ${k}`);
      if (
        k.endsWith("_VERSION") &&
        !EXACT.test(String(v)) &&
        !/^\$\{\{\s*needs\.setup\.outputs\.version\s*\}\}$/.test(String(v))
      )
        add(file, where, `env ${k} is ${String(v)}, not an exact version`);
    }
}

/**
 * The credential names a step can read: every env name, at any scope, whose
 * value comes from `secrets.*`, a step output, github.token, or another
 * credential through `env.`; and the deploy keys among them (a secret the
 * environment declares with kind deploy-key). Derived, never listed.
 */
export function credentialsOf(maps, declared) {
  const creds = new Set();
  const deployKeys = new Set();
  const kinds = new Map((declared?.secrets ?? []).map((s) => [s?.name, s?.kind]));
  const entries = maps.flatMap((m) => Object.entries(m ?? {}));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [k, v] of entries) {
      const s = String(v);
      const isCred =
        /\$\{\{[^}]*\b(?:secrets|steps)\./.test(s) ||
        /\$\{\{[^}]*\bgithub\.token\b/.test(s) ||
        [...s.matchAll(/\benv\.([A-Za-z_]\w*)/g)].some((m) => creds.has(m[1]));
      if (isCred && !creds.has(k)) {
        creds.add(k);
        grew = true;
      }
      const m = /^\$\{\{\s*secrets\.([A-Za-z_]\w*)\s*\}\}$/.exec(s);
      if (m !== null && kinds.get(m[1]) === "deploy-key") deployKeys.add(k);
    }
  }
  return { creds, deployKeys };
}

const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * Git's configuration isolation belongs on the git steps, never wider (round
 * 5): at job or workflow level, actions/checkout inherits it, and checkout
 * writes safe.directory with `git config --global`. So a job with a checkout
 * sets neither at job or workflow level, and a credentialed step that runs
 * git sets both, exactly, in its own env.
 */
function gitConfigRules(file, jobId, job, doc, credentialed, add) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const checkout = steps.some(
    (s) => typeof s?.uses === "string" && s.uses.startsWith("actions/checkout@"),
  );
  for (const [scope, map] of [
    ["the workflow's", doc?.env],
    ["the job's", job?.env],
  ])
    for (const k of Object.keys(GIT_ISOLATION))
      if (checkout && Object.hasOwn(map ?? {}, k))
        add(
          file,
          jobId,
          `${k} is set in ${scope} env, which actions/checkout inherits (set it on the git steps)`,
        );
  if (!credentialed) return;
  for (const s of steps) {
    if (typeof s?.run !== "string") continue;
    const runsGit = lexStrict(s.run).commands.some(
      (c) => c.words.find((w) => !["if", "then", "else", "fi"].includes(w.raw))?.text === "git",
    );
    if (!runsGit) continue;
    for (const [k, v] of Object.entries(GIT_ISOLATION))
      if (String(s?.env?.[k]) !== v)
        add(file, jobId, `step ${s?.name ?? "?"} runs git without ${k}: ${v} in its own env`);
  }
}

/** Rules 1, 2, 3, 5, 6, 9 and the action half of 8, for one job. */
function jobRules(args) {
  const {
    file,
    jobId,
    job,
    doc,
    reusable,
    envs,
    workflows,
    allowed,
    used,
    pins,
    remotesByEnv,
    commands,
    goProxyPrefixes,
    add,
  } = args;
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
  const ctx = {
    jobId,
    credentialed,
    isPackOrPublish,
    workflows,
    allowed,
    used,
    pins,
    remotes: remotesByEnv.get(envName(job)) ?? new Set(),
    downloads: steps
      .filter((s) => typeof s?.uses === "string" && s.uses.startsWith("actions/download-artifact@"))
      .map((s) => String(s?.with?.path ?? "")),
    environment: envName(job),
    commands,
    goProxyPrefixes,
    add,
  };
  if (credentialed) credentialedJobRules(file, jobId, job, doc, add);
  if (isPackOrPublish) pinScopeRules(file, jobId, job, doc, add);
  gitConfigRules(file, jobId, job, doc, credentialed, add);
  if (typeof job?.uses === "string") callRules(file, jobId, job, ctx);
  for (const [i, step] of steps.entries()) {
    const where = `${jobId} step ${step?.name ?? i + 1}`;
    if (typeof step?.run === "string")
      runRules(file, where, step.run, {
        ...ctx,
        ...credentialsOf([doc?.env, job?.env, step?.env], declared),
        defined: new Set([
          ...Object.keys(doc?.env ?? {}),
          ...Object.keys(job?.env ?? {}),
          ...Object.keys(step?.env ?? {}),
        ]),
      });
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
export function findings({ settings, manifest, workflows, commands = ENVIRONMENT_COMMANDS }) {
  // The only URLs curl may name: each Go unit's module on the proxy, literal to /@v/.
  const goProxyPrefixes = (manifest.publish ?? [])
    .filter((u) => u?.registry === "go" && typeof u.coordinates === "string")
    .map((u) => `https://proxy.golang.org/${u.coordinates}/@v/`);
  const out = [];
  const add = (file, job, why) => out.push({ file, job, why });
  const envs = new Map((settings.environments ?? []).map((e) => [e.name, e]));
  const allowed = settings.allowedActions ?? [];
  const used = new Set();
  // The repositories a credentialed git command may reach, per environment:
  // each mirror from its own environment only, and this repository from the
  // Go module tags' environment only (round 4: one literal per registry).
  const remotesByEnv = new Map();
  const reach = (env, repo) => {
    if (!remotesByEnv.has(env)) remotesByEnv.set(env, new Set());
    remotesByEnv.get(env).add(repo);
  };
  for (const m of settings.mirrors ?? []) reach(m.environment, m.repository);
  if (settings.goModuleTags?.environment !== undefined)
    reach(settings.goModuleTags.environment, "confeature/sdks");
  for (const [file, doc] of Object.entries(workflows)) {
    workflowRules(file, doc, add);
    const pins = workflowPins(file, doc, add);
    const reusable = triggersOf(doc).includes("workflow_call");
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {}))
      jobRules({
        file,
        jobId,
        job,
        doc,
        reusable,
        envs,
        workflows,
        allowed,
        used,
        pins,
        remotesByEnv,
        commands,
        goProxyPrefixes,
        add,
      });
  }
  for (const a of allowed)
    if (!used.has(a)) add(SETTINGS, "-", `allows ${a}, which no workflow uses`);
  shapeRules({ settings, manifest, workflows, envs, add });
  mirrorRules({ settings, manifest, envs, add });
  return out;
}

/** The only workflow-level env verify.yml may set: its two tool pins. */
export const PUBLIC_GATE_ENV = new Set(["NODE_VERSION", "DENO_VERSION"]);

/** The steps the public gate must run, each exactly, in a job and a step nothing can skip. */
export const PUBLIC_GATE_STEPS = ["pnpm run verify", "deno task --cwd apps/cli test"];

/**
 * Rule 13, over the workflows: verify.yml runs PUBLIC_GATE_STEPS on every push
 * to main and every pull request, unfiltered, under plain bash, in jobs that
 * wait on nothing and steps nothing can skip or redirect. Separate from
 * `findings` so the rule fixtures need not each carry a verify.yml.
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
  const branches = on?.push?.branches;
  if (
    !triggers.includes("push") ||
    !Array.isArray(branches) ||
    branches.length !== 1 ||
    branches[0] !== "main"
  )
    add("does not run on every push to main (push: branches: [main], exactly)");
  if (!triggers.includes("pull_request")) add("does not run on every pull request");
  for (const [t, keys] of [
    ["push", ["paths", "paths-ignore", "branches-ignore", "tags", "tags-ignore"]],
    ["pull_request", ["paths", "paths-ignore", "branches", "branches-ignore", "types"]],
  ])
    for (const k of keys)
      if (on?.[t]?.[k] !== undefined) add(`filters ${t} by ${k}, so a change can skip the gate`);
  for (const k of Object.keys(doc?.env ?? {}))
    if (!PUBLIC_GATE_ENV.has(k)) add(`sets env ${k}, which PUBLIC_GATE_ENV does not allow`);
  if (
    doc?.defaults?.run?.shell !== undefined ||
    doc?.defaults?.run?.["working-directory"] !== undefined
  )
    add("sets defaults.run (a shell or working-directory every step inherits)");
  const jobs = Object.values(doc?.jobs ?? {});
  for (const job of jobs) {
    if (job?.needs !== undefined) add("a job waits on another (needs:), which can skip it");
    if (job?.defaults?.run !== undefined) add("a job sets defaults.run");
    if (job?.env !== undefined) add("a job sets env:, which can change what the gate runs");
    for (const s of Array.isArray(job?.steps) ? job.steps : []) {
      if (s?.shell !== undefined && s.shell !== "bash")
        add(`a step runs a shell other than bash (${String(s.shell)})`);
      if (s?.["working-directory"] !== undefined) add("a step sets working-directory:");
      if (s?.env !== undefined) add("a step sets env:, which can change what the gate runs");
      if (s?.["continue-on-error"] !== undefined) add("a step sets continue-on-error:");
    }
  }
  for (const gate of PUBLIC_GATE_STEPS) {
    const runs = jobs.some(
      (job) =>
        job?.if === undefined &&
        job?.["continue-on-error"] === undefined &&
        (Array.isArray(job?.steps) ? job.steps : []).some(
          (s) => typeof s?.run === "string" && s.run.trim() === gate && s.if === undefined,
        ),
    );
    if (!runs) add(`has no step that runs \`${gate}\` and cannot be skipped`);
  }
  return out;
}

const STATUS_FN = /\b(?:always|failure|cancelled)\(\)/;

/**
 * sdk-publish.yml's conclude job runs `always()` to report the run, holds
 * nothing, and fails red itself when workflow-rules did not succeed: the one
 * job rule 14 lets run past a failed gate, and only while its script says so.
 */
function reportsGateFailure(file, id, job) {
  return (
    file === PUBLISH_WORKFLOW &&
    id === "conclude" &&
    envName(job) === undefined &&
    /^\$\{\{\s*toJSON\(needs\)\s*\}\}$/.test(String(job?.env?.NEEDS)) &&
    Array.isArray(job?.steps) &&
    job.steps.length === 1 &&
    job.steps[0]?.if === undefined &&
    job.steps[0]?.["continue-on-error"] === undefined &&
    CONCLUDE_GATE.test(String(job.steps[0]?.run))
  );
}

/**
 * conclude's one step, as its first statements must read (round 5): parse
 * NEEDS, then exit 1 unless workflow-rules succeeded. A `.includes()` of the
 * comparison alone let a block mention it and carry on.
 */
const CONCLUDE_GATE =
  /^node -e '\s*const needs = JSON\.parse\(process\.env\.NEEDS\);\s*if \(needs\["workflow-rules"\]\?\.result !== "success"\) \{ console\.error\("[^"\\]*"\); process\.exit\(1\); \}\n/;

const asList = (n) => (Array.isArray(n) ? n : n === undefined ? [] : [n]);

/**
 * Why one context reference in an expression names nothing, or null (rule 16,
 * round 5). `where` is { doc, jobId, step }: `step` the step object the
 * expression sits in (null for job-level keys), `ownEnv` whether the step's
 * own env is in scope (with, run, if: yes; the step's env values: no).
 */
export function referenceProblem(
  expr,
  { doc, jobId, step = null, ownEnv = false, scriptOutputs = {} },
) {
  // Only dot paths into a context are judged here, so whatever reaches a
  // context any other way is refused outright (round 6): an index
  // (`secrets['X']`, `needs['x']`), a function that serialises or rebuilds
  // (`toJSON(secrets)`, `fromJSON(…)`, `format(…)`, `join(…)`), or a bare
  // context. conclude's `toJSON(needs)` is the one exception, exact.
  const e = expr.trim();
  if (e !== "toJSON(needs)") {
    if (/\[/.test(e)) return `${e}: an index ([…]) into a context`;
    if (/\b(?:toJSON|fromJSON|format|join)\s*\(/.test(e))
      return `${e}: toJSON, fromJSON, format and join are refused`;
    const bare =
      /(?<![\w.'])(secrets|github|env|vars|steps|needs|inputs|matrix|job|runner|strategy)(?![\w.])/.exec(
        e.replace(/'[^']*'/g, "''"),
      );
    if (bare !== null) return `${e}: the bare ${bare[1]} context`;
  }
  const job = doc?.jobs?.[jobId];
  const needs = asList(job?.needs);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const before = step === null ? steps : steps.slice(0, Math.max(0, steps.indexOf(step)));
  const env = new Set([
    ...Object.keys(doc?.env ?? {}),
    ...Object.keys(job?.env ?? {}),
    ...(ownEnv ? Object.keys(step?.env ?? {}) : []),
  ]);
  const on = doc?.on ?? doc?.[true];
  const inputs = new Set([
    ...Object.keys(on?.workflow_dispatch?.inputs ?? {}),
    ...Object.keys(on?.workflow_call?.inputs ?? {}),
  ]);
  for (const m of expr.matchAll(
    /(?<![\w.])(needs|steps|env|inputs)\.([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?(?:\.([A-Za-z_][\w-]*))?/g,
  )) {
    const [ref, ctxName, a, b, c] = m;
    if (ctxName === "needs") {
      if (!needs.includes(a)) return `${ref}: ${jobId} does not need ${a}`;
      if (b === "outputs" && !Object.hasOwn(doc.jobs[a]?.outputs ?? {}, c ?? ""))
        return `${ref}: job ${a} has no output ${String(c)}`;
    } else if (ctxName === "steps") {
      const s = before.find((x) => x?.id === a);
      if (s === undefined) return `${ref}: no earlier step of ${jobId} has id ${a}`;
      if (b === "outputs") {
        const why = stepOutputProblem(s, c ?? "", scriptOutputs);
        if (why !== null) return `${ref}: ${why}`;
      }
    } else if (ctxName === "env") {
      if (!env.has(a)) return `${ref}: no env: in scope defines ${a}`;
    } else if (!inputs.has(a)) return `${ref}: the workflow declares no input ${a}`;
  }
  return null;
}

/**
 * Rule 16 (round 5): every `needs.*`, `steps.*`, `env.*` and `inputs.*`
 * reference in sdk-publish.yml and cli-release.yml names something: a direct
 * need and its declared output, an earlier step's id, an env name in scope,
 * a declared input. A renamed `setup.outputs.path` would otherwise hand every
 * job an empty UNIT_PATH while every other check stays green.
 */
export function referenceFindings(workflows, scriptOutputs = {}) {
  const out = [];
  const exprs = (v) => [...String(v).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
  for (const file of [PUBLISH_WORKFLOW, CLI_WORKFLOW]) {
    const doc = workflows[file];
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      const check = (where, list, scope) => {
        for (const e of list) {
          const why = referenceProblem(e, { doc, jobId, scriptOutputs, ...scope });
          if (why !== null) out.push({ file, job: where, why });
        }
      };
      check(jobId, typeof job?.if === "string" ? [job.if, ...exprs(job.if)] : [], {});
      for (const v of [
        job?.name,
        ...Object.values(job?.env ?? {}),
        ...Object.values(job?.with ?? {}),
      ])
        check(jobId, exprs(v ?? ""), {});
      for (const v of Object.values(job?.outputs ?? {})) check(jobId, exprs(v), { step: null });
      for (const [i, s] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
        const where = `${jobId} step ${s?.name ?? i + 1}`;
        for (const v of Object.values(s?.env ?? {})) check(where, exprs(v), { step: s });
        const own = [s?.name, s?.run, ...Object.values(s?.with ?? {})].flatMap((v) =>
          exprs(v ?? ""),
        );
        if (typeof s?.if === "string") own.push(s.if);
        check(where, own, { step: s, ownEnv: true });
      }
    }
  }
  return out;
}

/**
 * The outputs an action step offers, recorded (round 6): a reference to any
 * other is a typo or a renamed output, and resolves to "" at run time.
 */
export const ACTION_OUTPUTS = {
  "rust-lang/crates-io-auth-action": ["token"],
  "NuGet/login": ["NUGET_API_KEY"],
};
/** The repository scripts whose outputs a step reference may name, read by verifyWorkflows. */
export const OUTPUT_SCRIPTS = ["tools/sdk-pack/resolve-publish.mjs"];

/** The keys a script appends to $GITHUB_OUTPUT: those of its `return checkSafe({ … })`. */
export function scriptOutputKeys(source) {
  const m = /return checkSafe\(\{([\s\S]*?)\}\);/.exec(source);
  // `key: value` and the shorthand `key,`.
  return m === null ? [] : [...m[1].matchAll(/^\s*([A-Za-z_]\w*)\s*[:,]/gm)].map((x) => x[1]);
}

/**
 * Why `steps.<id>.outputs.<name>` names nothing the step writes, or null
 * (rule 16, round 6): a run step must write `<name>=` (or `<name><<`) to
 * $GITHUB_OUTPUT, or run a recorded script that emits it; an action step
 * must offer it (ACTION_OUTPUTS). A resolver that stopped emitting `path`
 * would otherwise pass while every job got an empty UNIT_PATH.
 */
function stepOutputProblem(s, name, scriptOutputs) {
  if (typeof s?.uses === "string") {
    const repo = s.uses.split("@")[0];
    return (ACTION_OUTPUTS[repo] ?? []).includes(name)
      ? null
      : `action ${repo} offers no recorded output ${name}`;
  }
  const run = String(s?.run ?? "");
  const script = OUTPUT_SCRIPTS.find((f) => run.includes(`node ${f}`));
  if (script !== undefined)
    return (scriptOutputs[script] ?? []).includes(name)
      ? null
      : `${script} emits no output ${name}`;
  const writes =
    /GITHUB_OUTPUT/.test(run) && new RegExp(`(?:^|[\\s"'{;])${name}(?:=|<<)`, "m").test(run);
  return writes ? null : `step ${s?.id} writes no ${name}= to $GITHUB_OUTPUT`;
}

/** The first job of each release workflow, which runs these rules over the tagged commit. */
export const RELEASE_GATE_JOB = "workflow-rules";

/**
 * Rule 14 (#794 review, round 3): in sdk-publish.yml and cli-release.yml,
 * RELEASE_GATE_JOB exists, waits on nothing and cannot be skipped, and every
 * other job transitively `needs` it, so no job of a tag whose workflows break
 * these rules runs at all. Separate from `findings` for the same reason as
 * rule 13.
 */
export function releaseGateFindings(workflows) {
  const out = [];
  for (const file of [PUBLISH_WORKFLOW, CLI_WORKFLOW]) {
    const jobs = workflows[file]?.jobs ?? {};
    const add = (job, why) => out.push({ file, job, why });
    const gate = jobs[RELEASE_GATE_JOB];
    if (gate === undefined) {
      add("-", `has no ${RELEASE_GATE_JOB} job`);
      continue;
    }
    for (const k of ["needs", "if", "continue-on-error"])
      if (gate[k] !== undefined) add(RELEASE_GATE_JOB, `sets ${k}:, so the rules can be skipped`);
    for (const s of Array.isArray(gate.steps) ? gate.steps : [])
      for (const k of ["if", "continue-on-error"])
        if (s?.[k] !== undefined)
          add(RELEASE_GATE_JOB, `step ${s.name ?? "?"} sets ${k}:, so the rules can be skipped`);
    // Whether a job runs only when workflow-rules succeeded. Without a status
    // function, GitHub requires every need to succeed; with always(),
    // failure() or cancelled() it requires nothing, so the condition itself
    // must name a need that implies the gate: `needs.<id>.result == 'success'`
    // as a top-level conjunct (round 4).
    const memo = new Map();
    const implies = (id) => {
      if (id === RELEASE_GATE_JOB) return true;
      if (memo.has(id)) return memo.get(id);
      memo.set(id, false);
      const cond = typeof jobs[id]?.if === "string" ? jobs[id].if : "";
      const ds = needsOf(id);
      const ok = !STATUS_FN.test(cond)
        ? ds.some(implies)
        : topConjuncts(cond).some((c) => {
            const m = /^needs\.([\w-]+)\.result\s*==\s*'success'$/.exec(c);
            return m !== null && ds.includes(m[1]) && implies(m[1]);
          });
      memo.set(id, ok);
      return ok;
    };
    const needsOf = (id) => {
      const n = jobs[id]?.needs;
      return Array.isArray(n) ? n : n === undefined ? [] : [n];
    };
    for (const id of Object.keys(jobs)) {
      if (id === RELEASE_GATE_JOB) continue;
      const seen = new Set();
      const stack = [...needsOf(id)];
      while (stack.length > 0) {
        const n = stack.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...needsOf(n));
      }
      if (!seen.has(RELEASE_GATE_JOB)) add(id, `does not wait on ${RELEASE_GATE_JOB}`);
      else if (!implies(id) && !reportsGateFailure(file, id, jobs[id]))
        add(
          id,
          `can run when ${RELEASE_GATE_JOB} did not succeed: its if: uses always()/failure()/cancelled() without needs.<id>.result == 'success' for a need that implies it`,
        );
    }
  }
  return out;
}

/** The outputs each OUTPUT_SCRIPTS script emits, read from the repository at `root`. */
export function readScriptOutputs(root) {
  const out = {};
  for (const f of OUTPUT_SCRIPTS) out[f] = scriptOutputKeys(readFileSync(join(root, f), "utf8"));
  return out;
}

/** Read the repository at `root` and return the findings. Throws on unreadable input. */
export function verifyWorkflows(root) {
  const settings = JSON.parse(readFileSync(join(root, SETTINGS), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const workflows = {};
  for (const f of readdirSync(join(root, WORKFLOWS)).filter((n) => /\.ya?ml$/.test(n)))
    workflows[f] = parseYaml(readFileSync(join(root, WORKFLOWS, f), "utf8"));
  return [
    ...findings({ settings, manifest, workflows }),
    ...publicGateFindings(workflows),
    ...releaseGateFindings(workflows),
    ...referenceFindings(workflows, readScriptOutputs(root)),
  ];
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
