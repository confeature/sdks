#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Every quality gate has exactly one declared set of homes; every declared home
 * still RUNS its gate in a way that can fail the job; every gate is named in
 * the "Quality gates" table of `CONTRIBUTING.md`, this repository's contract for
 * where each gate runs.
 *
 * An unrun check silently stops being true, and nothing in a repository can
 * tell you it has happened: a gate can be written, work, assert a real
 * threshold, and be wired to nothing. This guard is what notices.
 *
 * Its first version could itself be defeated seven ways, all confirmed by
 * execution in review: `homes: []`, duplicate homes, `if: false`,
 * `continue-on-error: true`, a `#`-commented line inside a `run: |` block,
 * `echo "skipping <gate>"` substituted for the invocation, and stripping the
 * table rows while this file's own prose satisfied the check. Every one of them
 * reported green while a real gate was unenforced. Each is now a named test in
 * `verify-declarations.test.mjs`. The lesson is written down rather than merely
 * fixed: proving a gate is MENTIONED is not proving it RUNS.
 *
 * ## What this guard is, and what it is not
 *
 * It detects ACCIDENTAL DRIFT: a gate commented out while debugging, stubbed to
 * `echo`, reordered below the publish it guards, made error-tolerant by an
 * `if:` or a `set +ex`, or left with its tests in a directory no runner
 * collects.
 *
 * **It does not resist an author deliberately detaching a gate.** It is written
 * in the same files it inspects, by the same hand, and its declaration IS its
 * specification — so every check on that declaration is the guard grading its
 * own homework. Four review rounds found twenty-six bypasses; three of round
 * four's lived in code round four itself had just added. That is a saturated
 * accident space and an unbounded adversarial one, and the honest response is
 * to state the bound rather than chase a fifth round. The enforcer an author
 * cannot edit is branch protection and `CODEOWNERS`; this file catches the
 * accidents that reach them.
 *
 * Exit codes:
 *   0 — every gate declared, every home live and able to fail, every gate in
 *       the table.
 *   1 — at least one violation, each printed with the edit that fixes it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..", "..");

/**
 * The declaration itself. `script` is the executable the gate ultimately runs —
 * it is what the orphan sweep matches against, so a gate whose script moves must
 * be updated here or the move is reported as a new orphan.
 *
 * A home is where the gate is INVOKED, never where it is defined. For a
 * `package.json` home the `script` field names the npm script whose body must
 * invoke the gate; checking the file as a whole would let a gate's own one-line
 * definition satisfy its own home. For a workflow home, `before` names the step
 * the gate must precede — without it, a gate can be moved below the deploy it
 * was placed to block and still be "present".
 */
/**
 * A gate's script paths, always as an array.
 *
 * `script` may be a single path or a list. The list form exists for one gate
 * with several subjects — one `scripts/check-bundle-size.mjs` per publishable
 * SDK package — which is one decision, so one row in the table, not five.
 */
const scriptsOf = (decl) =>
  typeof decl.script === "string" ? [decl.script] : Array.isArray(decl.script) ? decl.script : [];

/**
 * The public gates. `verify` (the fast gate, no containers) and `ready` (the
 * whole local gate: `verify`, then every containerised SDK suite and the
 * native Swift one) are the two root pipelines; `sdk-publish.yml` is the
 * release tier, where a gate runs before the step that cannot be undone.
 */
export const DECLARED_GATES = {
  "check-bundle-size": {
    // One copy per publishable bundle: each SDK asserts its own gzip budget in
    // its own `postbuild`, so a regression fails the build that produced it.
    // A DIRECT home: the script body runs the executable itself. The homes are
    // reached by `sdk-publish.yml`, which builds the package before it
    // publishes it.
    script: [
      "apps/sdk-browser-js/scripts/check-bundle-size.mjs",
      "apps/sdk-bun/scripts/check-bundle-size.mjs",
      "apps/sdk-cloudflare-worker/scripts/check-bundle-size.mjs",
      "apps/sdk-deno/scripts/check-bundle-size.mjs",
      "apps/sdk-react/scripts/check-bundle-size.mjs",
    ],
    homes: [
      { file: "apps/sdk-browser-js/package.json", script: "postbuild", direct: true },
      { file: "apps/sdk-bun/package.json", script: "postbuild", direct: true },
      { file: "apps/sdk-cloudflare-worker/package.json", script: "postbuild", direct: true },
      { file: "apps/sdk-deno/package.json", script: "postbuild", direct: true },
      { file: "apps/sdk-react/package.json", script: "postbuild", direct: true },
    ],
  },
  "check:npm-tarball": {
    // The npm tarball is the unit the resolver accepted, carries no workspace
    // range and a LICENSE, and contains every entry point its manifest names
    // (#899: sdk-angular packed a manifest with none). It runs in the pack job,
    // before the dry run and long before the upload that cannot be undone.
    script: "tools/sdk-pack/check-npm-tarball.mjs",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "npm publish --dry-run (no credentials)",
      },
    ],
  },
  "check:maven-release": {
    // The JVM SDKs go to a static Maven repository on R2 (#902), which stores
    // whatever it is given, so the checks a registry would make run here: the
    // release is exactly the unit's, at the resolved version, with matching
    // checksums, sources and javadoc jars, and complete POMs that carry no
    // address; and its metadata keeps every live version. It runs in the Maven
    // pack job, before the probe of the live repository and the upload.
    script: "tools/sdk-pack/check-maven-release.mjs",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Probe maven.confeature.io for the new version (no credentials)",
      },
    ],
  },
  "split-mirror": {
    // The PHP and Swift SDKs are published as mirror repositories whose
    // history is this split of the unit's directory, and a pushed history
    // cannot be taken back: the split is refused when any commit in it carries
    // an author, committer or message address that is not a noreply one
    // (#901). Each mirror's pack job runs it, before its dry run.
    script: "tools/sdk-pack/split-mirror.sh",
    homes: [
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "composer validate --strict (no credentials)",
        perJob: true,
      },
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "swift build against the mirror (no credentials)",
        perJob: true,
      },
    ],
  },
  "dagger-precheck": {
    // The precondition in front of every containerised suite: it fails fast
    // when the Dagger CLI is missing or the Docker daemon is unreachable, so a
    // run reports a real cause instead of a container error.
    script: "scripts/dagger-precheck.sh",
    homes: [{ file: "package.json", script: "dagger:all", direct: true }],
  },
  "dagger:all": {
    // Every covered SDK's containerised suite (`prepushAll`). Its executable
    // is the wrapper that hands Dagger git's view of the working tree and owns
    // the ceiling: a run past it exits 124, never green.
    script: "tools/dagger-call/dagger-call.sh",
    homes: [{ file: "package.json", script: "ready" }],
  },
  "swift-precheck": {
    // Swift cannot run in the Dagger Linux module, so the Swift SDK is gated
    // natively on macOS.
    script: "scripts/swift-precheck.sh",
    homes: [{ file: "package.json", script: "swift:check", direct: true }],
  },
  "verify:fmt-lint": {
    script: "tools/repo-gates/verify-fmt-lint.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:json-keys": {
    script: "tools/repo-gates/verify-no-dup-json-keys.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:gate-declarations": {
    script: "tools/repo-gates/verify-declarations.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:workflows": {
    // The release-pipeline rules over every workflow: declared environments,
    // no credential outside one, no install or cache in a credentialed job,
    // no untrusted trigger, no expression in a shell, pinned actions and
    // tools, and tag patterns that agree across trigger, ruleset and policy
    // (#794). Its data is tools/repo-gates/release-settings.json.
    script: "tools/repo-gates/verify-workflows.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:codeowners": {
    // CODEOWNERS names org teams only, never a person (verify-codeowners.mjs).
    script: "tools/repo-gates/verify-codeowners.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:manifest-author": {
    // Every manifest names MakerLabs as its author, with no address. Two
    // homes, the second being the one that matters: a publish cannot be
    // undone — a registry keeps what it is given. Every pack job of
    // sdk-publish.yml (one per registry) runs it before it packs what its
    // publish job uploads, so it is declared per job (#794).
    script: "tools/manifest-author.mjs",
    homes: [
      { file: "package.json", script: "verify" },
      {
        file: ".github/workflows/sdk-publish.yml",
        before: "Pack the release artifact",
        perJob: true,
      },
    ],
  },
  "verify:sdk-extraction": {
    // The engine extracted into packages/sdk-shared stays extracted: what moved
    // into it, what moved into the fixtures package, and what stays in
    // sdk-node still match the filesystem.
    script: "tools/verify-sdk-extraction-manifest.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:seed-schema": {
    // The live-contract harness's seed JSON Schema is GENERATED from
    // `src/seed-schema.ts`, and it is the published description of the seed
    // format. The check runs build, emit and format — every step that produces
    // the committed file — before it compares bytes, so a stale dist cannot
    // pass it.
    script: "tools/test-harness-live-contract/tools/check-seed-schema-drift.mjs",
    homes: [{ file: "package.json", script: "verify" }],
  },
  "verify:wire-cases": {
    // The wire-case corpus is replayed by every SDK, and its schema carries the
    // invariants no single consumer re-derives — `hasConfig` tied to
    // `outcome`, the required `expected` fields.
    script: "packages/test-fixtures-sdk-parity/scripts/validate-wire-cases.ts",
    homes: [{ file: "package.json", script: "verify" }],
  },
};

/**
 * A gate script with no home, accepted on purpose. `issue` is mandatory: an
 * entry with no filed ticket is indistinguishable from one nobody has looked
 * at.
 */
export const UNGATED_ALLOW = [];

/**
 * How a gate script is DISCOVERED — by content and name, across every tracked
 * file, never by a path allow-list.
 *
 * The list this replaces was four hardcoded, non-recursive directories, and the
 * asymmetry was the defect: a listed directory that MOVED failed closed, while
 * a gate added under any unlisted directory was silently missed. Finding
 * orphans is this guard's entire purpose, and an anti-orphan sweep that only
 * looks where it was told to look does not detect orphans — it detects moves.
 * Those are different problems, and it was solving the easier one.
 *
 * The failure was self-concealing: a gate in a new directory produced a green
 * run asserting the gate surface was fully declared, with nothing in the output
 * distinguishing "no orphans" from "did not look".
 *
 * The predicate, stated so a reader can disagree with it: a tracked `.mjs` or
 * `.sh` file, not a test, whose BASENAME carries one of the gate words below as
 * a whole hyphen/dot-delimited part, and whose text can make the process fail.
 * Name plus content, so it needs no marker a new gate could forget to add and
 * no registry that drifts. It is stricter than "any file that can throw", which
 * repo-wide would match most of `apps/`, and looser than the four paths, which
 * matched almost nothing.
 *
 * Its bound, stated on purpose: a gate named something else entirely —
 * `enforce-x.mjs`, `assert-y.sh` — is still invisible. That is a smaller hole
 * than a path list and it is a NAMING convention, which a reviewer can see in a
 * diff; a path list is invisible in one.
 */
const GATE_WORDS = /(^|[-.])(verify|check|gate|precheck|guard)([-.]|$)/;
const GATE_EXTENSIONS = [".mjs", ".sh"];

/**
 * Trees excluded from discovery, each with a written reason. A deny-list, not
 * an allow-list: the difference is that a new directory is scanned by DEFAULT
 * here, and only stops being scanned when someone writes down why.
 */
export const EXCLUDED_TREES = [];

/**
 * The root pipelines: `verify`, the fast gate every contribution runs, and
 * `ready`, which runs `verify` and then every containerised SDK suite. A
 * per-package lifecycle home counts as reached when one of them runs its task
 * on the package, and a gate's tests count as collected when one of them
 * filters for the package that holds them.
 */
export const PIPELINES = ["verify", "ready"];

/** The file, and its section, that this repository designates as the placement contract. */
const TABLE_FILE = "CONTRIBUTING.md";
const TABLE_HEADING = "## Quality gates";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every file this repository tracks, repo-relative.
 *
 * `git ls-files` rather than a recursive `readdirSync`: it is the definition of
 * "files we own", it already honours `.gitignore`, and it excludes nested
 * worktrees that a hand-rolled walk would descend into and double-count. A
 * failure here is LOUD — a sweep that silently enumerates nothing reads as "no
 * orphans".
 */
export function trackedFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0) return r.stdout.split("\0").filter((l) => l !== "");
  // Not a git checkout — a release tarball, or a test fixture. Walk the tree
  // instead. This is a FALLBACK, not a relaxation: both forms enumerate, and a
  // sweep that ends up with zero candidates is failed by the empty-sweep guard
  // below whichever enumerator produced it. Returning `[]` here is the one
  // thing that must never happen, because that reads as "no orphans".
  const out = [];
  const skip = new Set(["node_modules", ".git", "dist", "worktrees"]);
  const walkDir = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir === "" ? "." : dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walkDir(rel, rel);
      else out.push(rel);
    }
  };
  walkDir("", "");
  return out;
}

/**
 * Separators that do NOT carry a failure to the caller. `&&` is the only one
 * that does. `||` swallows it, `;` ignores it, a trailing `&` backgrounds the
 * command, and a single `|` hands the caller the exit status of the LAST stage
 * of the pipe — the default `run:` shell is `bash -e {0}` with no `pipefail`,
 * so `pnpm run <gate> | tee x.log` reports tee's success. That last one is the
 * dangerous member of the set: it reads as a logging improvement.
 */
const SWALLOWS_FAILURE = /\|\|?|;|&(?!&)/;

/**
 * Any `set` that turns errexit OFF, in every spelling. The first version
 * matched only the literal two-token `set +e`, so `set +ex`, `set +eu`,
 * `set +eo pipefail`, `set +o errexit` and `set -x +e` all sailed past — and
 * `set +ex` is the likeliest of them, because `-x` is what you add when you are
 * debugging a release and then forget to remove.
 */
const SET_PLUS_E = /(?:^|\s)set\s+(?:[-+][a-zA-Z]*\s+)*(?:\+[a-zA-Z]*e|\+o\s+errexit)/;

/**
 * Redirections that LOOK like the separators above and are not. `2>&1`, `&>`
 * and `>&` leave the exit status untouched; rejecting them made the guard fail
 * on wiring that was plainly correct, inside the gate every contribution runs.
 * The quoted-string cases (`echo "a|b"`) stay
 * rejected: telling them apart needs a real shell lexer, and over-rejecting is
 * the safe direction.
 */
const REDIRECTION = /\d*>&\d*|&>/g;

/**
 * Does this shell command actually RUN the gate, in a way that can fail?
 *
 * Mentioning the name is not running it, and running it is not enough if the
 * failure is swallowed. Segments are split on `&&` only: a segment guarded by
 * `||` or chained with `;` cannot guarantee the command's exit status reaches
 * the caller, so it does not count as a home. `echo "skipping <gate>"` fails
 * the leading-command test, which is how review defeated the substring version.
 */
export function invokesGate(command, gate) {
  if (typeof command !== "string") return false;
  // Strip comments HERE, not only in the workflow reader: a `package.json`
  // script body reaches this function directly, and a comment carrying `&&`
  // followed by the gate name fakes an invocation on either host.
  const raw = command;
  command = stripShellComments(command);
  // Newlines separate commands in a `run: |` block exactly as `&&` does in a
  // one-liner, and splitting only on `&&` REFUSED a legitimate two-line block —
  // a false failure, but a real one.
  // The disqualifiers are tested on the RAW text, before comment stripping.
  // Stripping first let a quoted `#` erase a trailing `|| true`, so a gate that
  // swallowed its own exit status scored as a valid home:
  //   pnpm run verify:x " # " || true   ->  counted as running
  // The per-segment copy of this test that used to live in the loop below was
  // provably dead — a 1056-command differential fuzz in review found zero
  // behavioural differences when it was deleted — and it made four assertions
  // vacuous, because each half rejected the fixtures the other was named for.
  const bare = raw.replace(REDIRECTION, " ");
  if (bare.split("&&").some((seg) => SWALLOWS_FAILURE.test(seg))) return false;
  if (SET_PLUS_E.test(raw)) return false;
  return command.split(/&&|\n/).some((seg0) => {
    const seg = seg0.trim();
    return new RegExp(`^(?:pnpm|npm|yarn|npx)\\s+(?:run\\s+)?${escapeRe(gate)}(?![\\w:.-])`).test(
      seg,
    );
  });
}

/** Drop what a shell would not execute: whole-line and trailing `#` comments. */
export function stripShellComments(body) {
  return body
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

/**
 * The steps of a GitHub Actions workflow, with the job each belongs to and the
 * keys that decide whether it can fail.
 *
 * This was a line-oriented approximation of YAML until review defeated it
 * twice: first by a `#`-commented invocation inside a `run: |` block, then by
 * moving the gate step into a SEPARATE JOB carrying `if: false` — which the
 * flat, job-blind version could not see, so the `before:` ordering check
 * compared indices across unrelated jobs and passed. A hand-rolled parser
 * answering an execution-semantics question will keep yielding a new bypass
 * every round; this reads the document with a real parser instead.
 */
export function parseSteps(yamlText) {
  const doc = parseYaml(yamlText);
  const out = [];
  out.needs = new Map();
  const jobs = doc?.jobs;
  if (jobs === undefined || jobs === null || typeof jobs !== "object") return out;
  for (const [job, spec] of Object.entries(jobs)) {
    const steps = Array.isArray(spec?.steps) ? spec.steps : [];
    // A job-level `if:` disables every step inside it, so it is inherited.
    const jobDisabled = spec?.if !== undefined;
    // Inherited exactly as `if:` is. A job-level continue-on-error makes every
    // step inside it unable to fail the workflow, and the `needs:` relaxation
    // is what made that newly reachable for a gate sitting in its own job.
    const jobTolerant = spec?.["continue-on-error"] !== undefined;
    const needs = spec?.needs;
    out.needs.set(job, Array.isArray(needs) ? needs : needs === undefined ? [] : [needs]);
    for (const step of steps) {
      out.push({
        job,
        name: typeof step?.name === "string" ? step.name : null,
        run: typeof step?.run === "string" ? step.run : null,
        // A newline only propagates a failure under the default `bash -e {0}`.
        // `shell: bash {0}` drops the -e, so the block runs on past a failed
        // gate while the invocation still matches.
        shell: typeof step?.shell === "string" ? step.shell : null,
        hasIf: step?.if !== undefined || jobDisabled,
        // The step's OWN condition, apart from its job's: a job-level `if:`
        // gates a build and the publish after it alike.
        stepIf: step?.if !== undefined,
        continueOnError: step?.["continue-on-error"] !== undefined || jobTolerant,
      });
    }
  }
  return out;
}

/**
 * Every job that must succeed before `job` starts, transitively.
 *
 * A gate does not have to sit in the same job as the thing it blocks: a failing
 * `needs:` dependency stops the dependent job just as hard as a failing earlier
 * step. Requiring the same job was over-strict, and worse than merely strict —
 * it FORBADE the least-privilege layout, pushing every gate into the job that
 * holds the deploy credentials. That is a constraint that hardens as more gates
 * declare workflow homes, so it is fixed before any of them do.
 */
export function dependsOn(needsByJob, job, seen = new Set()) {
  for (const dep of needsByJob.get(job) ?? []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    dependsOn(needsByJob, dep, seen);
  }
  return seen;
}

/**
 * Where a workspace package lives, by its declared name. Used to follow the one
 * `pnpm --filter <pkg> <script>` hop a root gate script is allowed to take.
 */
function packageDirs(root) {
  const dirs = new Map();
  for (const glob of ["apps", "packages", "tools"]) {
    let names;
    try {
      names = readdirSync(join(root, glob));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, glob, name, "package.json"), "utf8"));
        if (typeof pkg.name === "string") dirs.set(pkg.name, { dir: `${glob}/${name}`, pkg });
      } catch {
        /* not a package */
      }
    }
  }
  return dirs;
}

/**
 * Does the npm script named by this gate actually reach the executable the
 * declaration names?
 *
 * Without this, `"verify:x": "echo ok"` detaches the real script
 * at EVERY home at once while every home assertion still passes — the gate is
 * "run" everywhere and does nothing anywhere. Review proved it by execution.
 * One `pnpm --filter <pkg> <script>` hop is followed, because that is the shape
 * the repo actually uses to reach a script inside a workspace package.
 */
/**
 * Does this shell command RUN `needle` as a program, in a way that can fail?
 *
 * Module-level because the DIRECT home form needs exactly this
 * discipline and a second copy would drift. Everything it rejects was defeated
 * in review first: `echo <path>`, a trailing `|| true`, a `#`-commented line,
 * `node --check <path>`, `sh -c true <path>`, and the path merely mentioned in
 * a message.
 */
export function runsExecutable(text, needle) {
  if (typeof text !== "string") return false;
  const clean = stripShellComments(text);
  if (
    text
      .replace(REDIRECTION, " ")
      .split("&&")
      .some((seg) => SWALLOWS_FAILURE.test(seg))
  )
    return false;
  if (SET_PLUS_E.test(text)) return false;
  // The needle must be RUN, not merely mentioned. Without the leading-runner
  // anchor, `echo neutralised <path>` and `echo "see <path> for why"` both
  // counted as reaching the executable — the same mistake the home bodies
  // were already protected from, repeated one function along.
  return clean.split(/&&|\n/).some((seg0) => {
    const seg = seg0.trim();
    const parts = seg.split(/\s+/);
    if (!/^(?:node|tsx|deno|bash|sh|pnpm|npm|yarn|npx)$/.test(parts[0])) return false;
    // The needle must be the runner's FIRST NON-FLAG OPERAND, not merely
    // present somewhere on the line. Testing "starts with a runner" and
    // "contains the path" as independent conjuncts let `node --check <path>`,
    // `node --version <path>`, `node -e '' <path>` and `sh -c true <path>`
    // all reach the executable without executing it — and `node --check` is
    // something a person writes on purpose, which is what makes this the
    // accident-shaped half of what round 4 found.
    // A needle that IS a flag (`--filter <pkg>`, when following the hop) is a
    // presence question, not an executable question — the executable check is
    // the recursive call on the inner script.
    if (needle.startsWith("-")) {
      return new RegExp(`(?:^|\\s)${escapeRe(needle)}(?![\\w/@.-])`).test(seg);
    }
    const operand = parts.slice(1).find((a) => !a.startsWith("-"));
    if (operand === undefined) return false;
    return operand.replace(/^['"]|['"]$/g, "") === needle;
  });
}

export function scriptReachesExecutable(root, pkg, gate, executable) {
  const body = pkg.scripts?.[gate];
  if (typeof body !== "string" || typeof executable !== "string") return false;
  // The SAME discipline a home body gets. This used to be a bare includes(),
  // so `echo <path>`, a trailing `|| true`, a `#`-commented line, or the path
  // merely named in a message all counted as reaching the executable — and
  // that detaches the gate at EVERY home at once, which is the exact harm the
  // reachability check exists to prevent. Six variants were confirmed green in
  // review before this.
  const runs = runsExecutable;
  if (runs(body, executable)) return true;
  const dirs = packageDirs(root);
  for (const m of stripShellComments(body).matchAll(/--filter\s+(\S+)\s+(?:run\s+)?([\w:.-]+)/g)) {
    const target = dirs.get(m[1]);
    if (target === undefined) continue;
    // The outer body must itself reach that filter without swallowing failure.
    if (!runs(body, `--filter ${m[1]}`)) continue;
    const inner = target.pkg.scripts?.[m[2]];
    // The inner script's paths are relative to its own package directory.
    const rel = executable.startsWith(`${target.dir}/`)
      ? executable.slice(target.dir.length + 1)
      : executable;
    if (runs(inner, rel)) return true;
  }
  return false;
}

/**
 * The whole check, as a pure function of the tree, so it can be tested without
 * a process exit. The executable wrapper is at the bottom.
 */
/**
 * Whether pnpm/vp still run `pre<task>`/`post<task>` hooks. One line —
 * `enablePrePostScripts: false` in the root vite.config.ts, or the same switch
 * in `.npmrc` / `pnpm-workspace.yaml` — would detach every `postbuild` home at
 * once while each still read as reached. An unreadable config is unprovable.
 */
export function prePostScriptsEnabled(root) {
  const checks = [
    ["vite.config.ts", /enablePrePostScripts\s*:\s*false/],
    [".npmrc", /^\s*enable-pre-post-scripts\s*=\s*false\s*$/m],
    ["pnpm-workspace.yaml", /^\s*enablePrePostScripts\s*:\s*false\s*$/m],
  ];
  for (const [file, disabled] of checks) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue; // absent: the default (on) applies
      return false;
    }
    if (disabled.test(text)) return false;
  }
  return true;
}

/**
 * The workspace packages one pnpm filter selects — or null when the filter is
 * not one of the three forms this guard can prove: the exact name, `<name>...`
 * (it and its workspace dependencies) and `...<name>` (it and its dependents).
 * `!`, `^`, globs and directories are unprovable, never guessed.
 */
export function filterSelects(filter, workspace) {
  // Anything but the three forms — `!`, `^`, globs, directories — names no
  // workspace package once its `...` is removed, so the lookups below refuse it.
  const f = filter.replace(/^["']|["']$/g, "");
  const deps = (name) =>
    // pnpm's `<name>...` follows every dependency kind, devDependencies too.
    Object.entries({
      ...workspace.get(name)?.pkg?.dependencies,
      ...workspace.get(name)?.pkg?.devDependencies,
      ...workspace.get(name)?.pkg?.optionalDependencies,
    })
      .filter(([dep, range]) => workspace.has(dep) && String(range).startsWith("workspace:"))
      .map(([dep]) => dep);
  const closure = (start, next) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
      for (const n of next(stack.pop())) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return seen;
  };
  if (f.endsWith("...") && !f.startsWith("...")) {
    const name = f.slice(0, -3);
    return workspace.has(name) ? closure(name, deps) : null;
  }
  if (f.startsWith("...") && !f.endsWith("...")) {
    const name = f.slice(3);
    if (!workspace.has(name)) return null;
    const dependents = (n) => [...workspace.keys()].filter((other) => deps(other).includes(n));
    return closure(name, dependents);
  }
  return workspace.has(f) ? new Set([f]) : null;
}

/**
 * Whether one shell command provably runs `task` on package `name`: split and
 * disqualified exactly as `invokesGate` does (`&&` and newlines; any `||`, `;`,
 * `&` or `set +e` and nothing in it counts), through `vp run` or `pnpm run`
 * with `-F`/`--filter`, never with `--ignore-scripts`.
 */
export function commandRunsTaskOn(command, name, task, workspace) {
  if (typeof command !== "string") return false;
  const raw = command;
  const bare = raw.replace(REDIRECTION, " ");
  if (bare.split("&&").some((seg) => SWALLOWS_FAILURE.test(seg))) return false;
  if (SET_PLUS_E.test(raw)) return false;
  return stripShellComments(command)
    .split(/&&|\n/)
    .some((seg0) => {
      const tokens = seg0.trim().split(/\s+/).filter(Boolean);
      const start =
        tokens[0] === "vp" && tokens[1] === "run"
          ? 2
          : tokens[0] === "pnpm" && tokens[1] === "vp" && tokens[2] === "run"
            ? 3
            : tokens[0] === "pnpm"
              ? 1
              : -1;
      if (start === -1 || tokens.includes("--ignore-scripts")) return false;
      const filters = [];
      const rest = [];
      for (let i = start; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "-F" || t === "--filter") filters.push(tokens[++i] ?? "");
        else if (t.startsWith("--filter=")) filters.push(t.slice("--filter=".length));
        else rest.push(t);
      }
      // `pnpm --filter x run <task>` and `vp run -F x <task>` both end in the task.
      const words = rest.filter((t) => !t.startsWith("-"));
      const ranTask = words[0] === "run" ? words[1] : start === 1 ? undefined : words[0];
      if (ranTask !== task || filters.length === 0) return false;
      const selections = filters.map((f) => filterSelects(f, workspace));
      if (selections.some((sel) => sel === null)) return false; // one unprovable filter taints the segment
      return selections.some((sel) => sel.has(name));
    });
}

/**
 * Why a home in a package's own `package.json` is NOT provably reached — or
 * null when it is. A `post<task>` hook is reached when pre/post hooks
 * are on and `<task>` runs on the package; any other script, when that script
 * itself runs on it. It runs when a root pipeline (`PIPELINES`) runs it,
 * or when a workflow job runs `pnpm --filter <f> run <task>` before a step
 * that publishes or packs with the same filter — `<f>` selecting this package,
 * or a tag-resolved value (a `${{ … }}` expression, or a `$VAR` the job sets
 * from one), which counts for an npm unit in `publish[]` of
 * `dagger/sdk-manifest.json` (the packages that workflow publishes). Packing
 * counts because the pack job's tarball is exactly what the publish job uploads.
 */
export function lifecycleHomeUnreached(root, rootPkg, name, script) {
  const lifecycle = script.startsWith("post");
  const task = lifecycle ? script.slice("post".length) : script;
  if (lifecycle && !prePostScriptsEnabled(root)) {
    return "pre/post scripts are turned off (or their config is unreadable)";
  }
  const workspace = packageDirs(root);
  for (const pipeline of PIPELINES) {
    if (commandRunsTaskOn(rootPkg.scripts?.[pipeline], name, task, workspace)) return null;
  }
  let listed = false;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "dagger", "sdk-manifest.json"), "utf8"));
    listed = (manifest.publish ?? []).some((u) => u?.registry === "npm" && u.coordinates === name);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      return `dagger/sdk-manifest.json could not be read (${err?.message ?? err})`;
    }
  }
  let workflows;
  try {
    workflows = readdirSync(join(root, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
  } catch (err) {
    return `.github/workflows could not be listed (${err?.message ?? err})`;
  }
  // The filter may be a quoted expression (`"${{ needs.setup.outputs.package }}"`).
  const FILTER = `("[^"]*"|'[^']*'|\\S+)`;
  const BUILD = new RegExp(`^pnpm\\s+--filter\\s+${FILTER}\\s+run\\s+${escapeRe(task)}$`);
  const PUBLISH = new RegExp(`^pnpm\\s+--filter\\s+${FILTER}\\s+(?:publish|pack)(\\s|$)`);
  // Does this build's filter select the package? A literal filter must resolve
  // to it; a `${{ … }}` expression is resolved by the workflow from its tag, so
  // it counts only for the SDKs that workflow publishes — the manifest.
  // A `$VAR...` build selects the unit AND its workspace dependencies (#899:
  // sdk-react compiles against sdk-browser-js's dist/), so it still builds the
  // unit; `${VAR}` and `$VAR` are one variable.
  const unit = (filter) =>
    filter
      .replace(/^["']|["']$/g, "")
      .replace(/^\$\{([A-Z_][A-Z0-9_]*)\}(?=$|\.\.\.$)/, "$$$1")
      .replace(/^(\$[A-Z_][A-Z0-9_]*)\.\.\.$/, "$1");
  const selects = (filter) => {
    const unquoted = unit(filter);
    if (/\$\{\{[^}]*\}\}/.test(unquoted) || /^\$[A-Z_][A-Z0-9_]*$/.test(unquoted)) return listed;
    return filterSelects(unquoted, workspace)?.has(name) === true;
  };
  for (const file of workflows) {
    let steps;
    try {
      steps = parseSteps(readFileSync(join(root, ".github", "workflows", file), "utf8"));
    } catch (err) {
      return `${file} could not be parsed (${err?.message ?? err})`;
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // A job-level `if:` gates the build and the publish alike, so only the
      // build step's own condition can let a publish run without it.
      if (step.stepIf || step.continueOnError || step.run === null) continue;
      const build = BUILD.exec(step.run.trim());
      if (build === null || !selects(build[1])) continue;
      for (let j = i + 1; j < steps.length && steps[j].job === step.job; j++) {
        // A publish with its own `if:` (`always()`, `failure()`, …) could run
        // after a failed build, shipping a bundle over its budget: refused.
        if (steps[j].stepIf) continue;
        const publish = PUBLISH.exec((steps[j].run ?? "").trim());
        if (publish !== null && unit(publish[1]) === unit(build[1])) return null;
      }
    }
  }
  return "no root pipeline runs it on the package, and no workflow builds the package before publishing it";
}

export function verifyGateDeclarations(
  root = ROOT,
  gates = DECLARED_GATES,
  allow = UNGATED_ALLOW,
  excluded = EXCLUDED_TREES,
) {
  const violations = [];
  // How many candidate scripts the reverse sweep actually inspected. Carried on
  // the result so `main()` can print it — "scanned N, found none" is a claim a
  // reader can audit; a bare success line is not, and the old sweep could only
  // make the second kind.
  let scanned = 0;
  const fail = (what, fix) => violations.push({ what, fix });
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  let pkg;
  try {
    pkg = JSON.parse(read("package.json"));
  } catch {
    return [{ what: "package.json is missing or unparseable", fix: "restore it" }];
  }

  // -------------------------------------------------------------------------
  // 0. The declaration must itself be well-formed. Review defeated the version
  //    that trusted it: `homes: []` deleted a gate from a release workflow, and
  //    declaring the same home twice removed this guard from a pipeline — both
  //    with exit 0. A guard that trusts its own config enforces nothing.
  // -------------------------------------------------------------------------
  for (const [gate, decl] of Object.entries(gates)) {
    if (!Array.isArray(decl.homes) || decl.homes.length === 0) {
      fail(
        `${gate} declares no homes`,
        "an empty homes list makes every other assertion vacuous — declare where it runs, or move it to UNGATED_ALLOW with a filed issue",
      );
      continue;
    }
    // `homes` was validated and `script` was trusted, so deleting the root npm
    // script skipped the reachability check entirely via its `!== undefined`
    // short-circuit while both home assertions still passed on the string alone.
    const paths = scriptsOf(decl);
    // A DIRECT gate is one whose homes run the executable themselves — a
    // per-package lifecycle hook, or a `bash scripts/x.sh && …` prelude. It has
    // no root npm script of its own and should not be made to invent one, so
    // the root-script requirement applies only to the delegating kind.
    const allDirect = decl.homes.every((h) => h.direct === true);
    if (paths.length === 0) {
      fail(`${gate} declares no script`, "name the executable this gate runs");
    } else if (!allDirect && pkg.scripts?.[gate] === undefined) {
      fail(
        `scripts.${gate} does not exist, but homes declare it`,
        "restore the npm script, or remove the gate from DECLARED_GATES — a home that names a script nothing defines is not a home",
      );
    }
    // A direct gate with more than one script must have at least as many homes:
    // six subjects behind one home would mean five of them are unrun while the
    // declaration reads as covering all six.
    if (allDirect && paths.length > decl.homes.length) {
      fail(
        `${gate} declares ${String(paths.length)} scripts but only ${String(decl.homes.length)} homes`,
        "a direct gate needs one home per script — otherwise the extra scripts are orphans wearing a declaration",
      );
    }
    for (const h of decl.homes) {
      if (h.script === undefined && (typeof h.before !== "string" || h.before === "")) {
        fail(
          `${gate}: workflow home ${h.file} declares no \`before\``,
          "name the step it must precede — deleting that one key deleted the entire ordering assertion, which is what makes a workflow home enforcing",
        );
      }
    }
    const keys = decl.homes.map((h) => `${h.file}#${h.script ?? h.before ?? ""}`);
    if (new Set(keys).size !== keys.length) {
      fail(
        `${gate} declares the same home twice`,
        "duplicate homes inflate the count without adding coverage — name distinct hosts",
      );
    }
  }
  const self = gates["verify:gate-declarations"];
  if (self === undefined) {
    fail(
      "verify:gate-declarations does not declare itself",
      "a guard absent from its own registry is unguarded",
    );
  }

  // -------------------------------------------------------------------------
  // 1. Every declared home exists and still RUNS its gate — and the gate's own
  //    npm script still reaches the executable the declaration names, without
  //    which stubbing that one line detaches the gate at every home at once.
  // -------------------------------------------------------------------------
  for (const [gate, decl] of Object.entries(gates)) {
    if (
      pkg.scripts?.[gate] !== undefined &&
      !scriptsOf(decl).some((path) => scriptReachesExecutable(root, pkg, gate, path))
    ) {
      fail(
        `scripts.${gate} no longer reaches ${scriptsOf(decl).join(" / ")}`,
        `restore the invocation — a gate whose own script is stubbed is unwired at EVERY home at once, while every home assertion still passes`,
      );
    }
  }
  for (const [gate, decl] of Object.entries(gates)) {
    const homes = decl.homes;
    if (!Array.isArray(homes)) continue;
    for (const home of homes) {
      if (home.script !== undefined) {
        // A home may live in ANY package.json, not only the root one.
        // The six bundle-size gates each sit in their own package's lifecycle
        // hook, and resolving every home against the root manifest reported
        // them as missing scripts.
        let host = pkg;
        if (home.file !== "package.json") {
          try {
            host = JSON.parse(read(home.file));
          } catch {
            fail(
              `${gate}: declared home ${home.file} could not be read`,
              `restore ${home.file}, or correct this gate's homes`,
            );
            continue;
          }
        }
        const body = host.scripts?.[home.script];
        if (body === undefined) {
          fail(
            `${gate}: declared home ${home.file} → scripts.${home.script} does not exist`,
            `restore the "${home.script}" script, or correct this gate's homes`,
          );
          continue;
        }
        const unreached =
          home.direct === true && home.file !== "package.json"
            ? lifecycleHomeUnreached(root, pkg, host.name, home.script)
            : null;
        if (unreached !== null) {
          fail(
            `${gate}: ${home.file} → scripts.${home.script} is reached by nothing — ${unreached}`,
            `a per-package home counts only as a \`post<task>\` hook whose <task> a root pipeline (${PIPELINES.join(", ")}) runs on ${String(host.name)}, or a workflow builds before publishing it — and only while pre/post scripts are on`,
          );
          continue;
        }
        if (home.direct === true) {
          // The body must RUN one of this gate's executables itself, under the
          // same discipline a delegating home gets: a leading runner, the path
          // as its first non-flag operand, no `||`, no `;`, no `set +e`. The
          // path is relative to the home's own package directory, exactly as
          // the `--filter` hop already resolves it.
          const dir = home.file === "package.json" ? "" : `${dirname(home.file)}/`;
          const ok = scriptsOf(decl).some((path) => {
            const relToHost = dir !== "" && path.startsWith(dir) ? path.slice(dir.length) : path;
            return runsExecutable(body, relToHost) || runsExecutable(body, `./${relToHost}`);
          });
          if (!ok) {
            fail(
              `${gate}: ${home.file} → scripts.${home.script} does not run it in a way that can fail`,
              `run the executable as its own \`&&\` segment — naming it, echoing it, or guarding it with \`||\` does not run it`,
            );
          }
          continue;
        }
        if (!invokesGate(body, gate)) {
          fail(
            `${gate}: scripts.${home.script} does not run it in a way that can fail`,
            `add \`pnpm run ${gate}\` as its own \`&&\` segment — naming it, echoing it, or guarding it with \`||\` does not run it`,
          );
        }
        continue;
      }
      let steps;
      try {
        steps = parseSteps(read(home.file));
      } catch {
        fail(
          `${gate}: declared home ${home.file} could not be read`,
          `restore ${home.file}, or correct this gate's homes`,
        );
        continue;
      }
      if (home.perJob === true) {
        // EVERY job holding a step named `before` runs the gate earlier in that
        // SAME job. The release tier has one pack job per registry (a pack
        // job builds what its publish job uploads), and a single invocation
        // in one of them orders nothing in the others. Within one job only the
        // steps' own `if:` counts, as above: the job's condition gates both.
        const named = steps.filter((s) => s.name === home.before);
        if (named.length === 0) {
          fail(
            `${gate}: ${home.file} has no step named "${home.before}" for it to precede`,
            `restore that step, or correct \`before\` — the ordering is what makes this home enforcing`,
          );
          continue;
        }
        for (const target of named) {
          const guard = steps.find(
            (s) =>
              s.job === target.job &&
              steps.indexOf(s) < steps.indexOf(target) &&
              s.run !== null &&
              invokesGate(s.run, gate),
          );
          if (guard === undefined) {
            fail(
              `${gate}: job "${target.job}" reaches "${home.before}" without running it first`,
              `run \`pnpm run ${gate}\` earlier in job "${target.job}" — every job that packs a release runs it`,
            );
            continue;
          }
          if (guard.shell !== null && !/(?:^|\s)-[a-zA-Z]*e|^(?:bash|sh)$/.test(guard.shell)) {
            fail(
              `${gate}: its step in job "${guard.job}" overrides the shell (\`${guard.shell}\`), which need not stop on failure`,
              "drop the `shell:` key — the default `bash -e {0}` is what makes a multi-line block fail at all",
            );
          }
          for (const s of [guard, target]) {
            if (s.stepIf || s.continueOnError) {
              fail(
                `${gate}: "${s.name ?? "a step"}" in job "${s.job}" can run past a failed gate (${s.stepIf ? "if:" : "continue-on-error:"})`,
                "remove that key — a gate, or the step it guards, that runs regardless enforces nothing",
              );
            }
          }
        }
        continue;
      }
      const at = steps.findIndex((s) => s.run !== null && invokesGate(s.run, gate));
      if (at === -1) {
        fail(
          `${gate}: no step in ${home.file} runs it`,
          `restore the step that runs \`pnpm run ${gate}\` — a step title or a comment naming it is not running it`,
        );
        continue;
      }
      const step = steps[at];
      // A job-level `if:` skips the gate and the step it guards ALIKE when
      // both sit in one job: if the job runs, the gate runs first, and a failed
      // gate stops every later step without an `if:` of its own. So when every
      // step named `before` shares the gate's job, only the steps' OWN
      // conditions count — the same reasoning that applies to a build and its
      // publish in lifecycleHomeUnreached. Without it, no gate could ever be
      // declared before "Publish to npm" in sdk-publish.yml, whose job carries
      // `if: always() && …`. Across jobs the inherited `if:` stands.
      const sameJob =
        home.before !== undefined &&
        steps.some((s) => s.name === home.before) &&
        steps.filter((s) => s.name === home.before).every((s) => s.job === step.job);
      const condIf = (s) => (sameJob ? s.stepIf : s.hasIf);
      if (step.shell !== null && !/(?:^|\s)-[a-zA-Z]*e|^(?:bash|sh)$/.test(step.shell)) {
        fail(
          `${gate}: its step overrides the shell (\`${step.shell}\`), which need not stop on failure`,
          "drop the `shell:` key — the default `bash -e {0}` is what makes a multi-line block fail at all",
        );
      }
      if (condIf(step) || step.continueOnError) {
        fail(
          `${gate}: its step in ${home.file} cannot fail the job (${condIf(step) ? "if:" : "continue-on-error:"})`,
          "a conditional or error-tolerant gate is a report, not a gate — remove the key",
        );
      }
      if (home.before !== undefined) {
        // Same job, or the comparison is meaningless: two steps in different
        // jobs have no ordering, and review detached the release tier by moving
        // the gate into a job of its own carrying `if: false`.
        // Resolved among steps that could ACTUALLY be ordered after this one:
        // the same job, or a job that transitively waits on it. A flat
        // first-match let a decoy step of the same name in the gate's own job
        // satisfy the ordering while the real one sat in a job nothing needed.
        // EVERY step of that name must be ordered after the gate, not just the
        // first one that happens to be. A decoy step named `Deploy app` in the
        // gate's own job satisfied a first-match search while the real deploy
        // sat in a job that did not wait for the gate at all.
        const named = steps.filter((s) => s.name === home.before);
        const unordered = named.filter((s) =>
          s.job === step.job
            ? steps.indexOf(step) >= steps.indexOf(s)
            : !dependsOn(steps.needs, s.job).has(step.job),
        );
        const target = unordered[0] ?? named[0];
        const blocked = named.length === 0 ? -1 : unordered.length === 0 ? 0 : 1;
        // EVERY step of that name, not just the one the ordering resolved to.
        // A second `Deploy app` after the first — a retry, a versions-deploy
        // follow-up — carrying `if: always()` sat outside this check entirely,
        // because `named[0]` was always the clean one once ordering passed.
        const escaping = named.find((s) => condIf(s) || s.continueOnError);
        if (escaping !== undefined) {
          // A gate is only enforcing if the thing it guards actually stops.
          // `if: always()` on the deploy runs it after a failed gate, so the
          // ordering holds and enforces nothing.
          fail(
            `${gate}: "${home.before}" in job "${escaping.job}" runs even when its gate fails (${condIf(escaping) ? "if:" : "continue-on-error:"})`,
            `remove that key from "${home.before}" — a step that runs regardless is blocked by nothing`,
          );
        }
        if (blocked === 1) {
          fail(
            `${gate}: nothing orders its step in job "${step.job}" before "${home.before}" in job "${target.job}"`,
            `put it earlier in the same job, or make "${target.job}" declare \`needs: ${step.job}\` — a gate the deploy does not wait for is a report, not a gate`,
          );
        } else if (blocked === -1) {
          fail(
            `${gate}: ${home.file} has no step named "${home.before}" for it to precede`,
            `restore that step, or correct \`before\` — the ordering is what makes this home enforcing`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. The reverse: no gate exists without a declaration. This is the half that
  //    catches the NEXT orphan on the day it is written.
  // -------------------------------------------------------------------------
  const declaredScripts = new Set(Object.values(gates).flatMap((g) => scriptsOf(g)));
  const allowedScripts = new Map(allow.map((e) => [e.script, e]));

  for (const entry of allow) {
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      fail(
        `UNGATED_ALLOW entry for ${entry.script} has no filed issue`,
        "file a ticket and put its number in the entry — an allowance with no ticket is a hole with a comment on it",
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
      fail(
        `UNGATED_ALLOW entry for ${entry.script} has no stated reason`,
        "state why it has no home, in enough detail that a reader can disagree with you",
      );
    }
    if (declaredScripts.has(entry.script)) {
      fail(
        `${entry.script} is both declared and allowed to be ungated`,
        "remove it from UNGATED_ALLOW — it has a home",
      );
    }
  }

  // The reverse sweep. `git ls-files` is the enumerator on purpose: it is the
  // set of files this repository OWNS, so `node_modules`, `dist` and the agent
  // nested worktrees are excluded by construction rather
  // than by a pattern that has to be maintained alongside `.gitignore`.
  const candidates = [];
  for (const rel of trackedFiles(root)) {
    if (!GATE_EXTENSIONS.some((e) => rel.endsWith(e))) continue;
    if (rel.endsWith(".test.mjs")) continue;
    if (excluded.some((t) => rel.startsWith(t.prefix))) continue;
    const base = rel.split("/").pop();
    if (!GATE_WORDS.test(base)) continue;
    let body;
    try {
      body = read(rel);
    } catch {
      // Tracked but absent: a delete that has not been committed. Loud, because
      // a declared gate that has vanished is exactly what this file is for.
      fail(
        `${rel} is tracked but could not be read`,
        "restore it, or commit its deletion — a gate that has vanished must stop the run",
      );
      continue;
    }
    // A gate is a script that can FAIL. A module that only exports helpers has
    // nothing to wire and is not an orphan. `.sh` scripts fail through `exit 1`
    // or `set -e` rather than `process.exit`, so both spellings count.
    if (!/process\.exit|throw |exit 1|set -e/.test(body)) continue;
    candidates.push(rel);
    if (declaredScripts.has(rel) || allowedScripts.has(rel)) continue;
    fail(
      `${rel} can fail but has no declared home`,
      "add it to DECLARED_GATES with the host that runs it, or to UNGATED_ALLOW with a filed issue and a reason",
    );
  }
  // The count is what makes a green result auditable: "scanned N, found none"
  // is a different claim from silence, and the old sweep could only make the
  // second one. Returned rather than printed, so `main()` stays the only place
  // that writes to stdout.
  scanned = candidates.length;
  // A sweep that matches NOTHING is the shape of the defect being fixed —
  // a renamed convention, a broken enumerator, a bad exclusion — and it would
  // otherwise report "no orphans" over a run that inspected zero files.
  if (candidates.length === 0) {
    fail(
      "the gate sweep matched no candidate scripts at all",
      "the enumerator or the naming predicate is broken — a sweep over nothing reports no orphans while checking none",
    );
  }

  for (const name of Object.keys(pkg.scripts ?? {})) {
    if (!name.startsWith("verify:")) continue;
    if (gates[name] !== undefined) continue;
    fail(
      `scripts.${name} is a verify:* gate with no entry in DECLARED_GATES`,
      "declare its homes in tools/repo-gates/verify-declarations.mjs",
    );
  }

  // -------------------------------------------------------------------------
  // 2b. A gate's TESTS must be collected by something. A `*.test.mjs` in a
  //     directory that is NOT a workspace package, or in one no pipeline
  //     filters for, runs only when handed its path by hand — never in CI.
  //     This guard once shipped exactly that: its own tests were an orphan, in
  //     the file whose job is finding orphans.
  // -------------------------------------------------------------------------
  for (const [gate, decl] of Object.entries(gates)) {
    const dir = scriptsOf(decl)[0]?.split("/").slice(0, -1).join("/");
    if (dir === undefined || dir === "") continue;
    let sibling;
    try {
      sibling = readdirSync(join(root, dir)).some((n) => n.endsWith(".test.mjs"));
    } catch {
      continue;
    }
    if (!sibling) continue;
    let name;
    try {
      name = JSON.parse(read(`${dir}/package.json`)).name;
    } catch {
      fail(
        `${gate}: ${dir} has tests but is not a workspace package`,
        "give it a package.json with a test script, or its tests run only when someone passes the path by hand",
      );
      continue;
    }
    // The filter must sit in a script something actually RUNS. Searching every
    // script body meant a dead `"notes": "echo we used to run -F <name> here"`
    // satisfied it after the real filter was removed — the guard grading a
    // comment as coverage.
    const RUN_HOSTS = new Set(PIPELINES);
    const collected = Object.entries(pkg.scripts ?? {}).some(
      ([script, body]) =>
        RUN_HOSTS.has(script) && new RegExp(`-F\\s+${escapeRe(name)}(?![\\w/@.-])`).test(body),
    );
    if (!collected) {
      fail(
        `${gate}: ${name}'s tests are not collected by any root script`,
        `add \`-F ${name}\` to the test filter of \`verify\` — an uncollected test file is the orphan this guard exists to find`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. CONTRIBUTING.md declares it — in the TABLE, not merely in the section. Review
  //    stripped both table rows and this check stayed green, satisfied by the
  //    explanatory prose this very change added. A guard that reads its own
  //    documentation as evidence is checking nothing.
  // -------------------------------------------------------------------------
  let agents;
  try {
    agents = read(TABLE_FILE);
  } catch {
    fail(
      `${TABLE_FILE} could not be read`,
      "restore it — it is this repository's placement contract",
    );
    agents = null;
  }
  if (agents !== null) {
    const start = agents.indexOf(TABLE_HEADING);
    if (start === -1) {
      fail(
        `${TABLE_FILE} has no "${TABLE_HEADING}" section`,
        "restore the heading — it anchors the placement contract this guard reads",
      );
    } else {
      const after = agents.indexOf("\n## ", start + TABLE_HEADING.length);
      const rows = agents
        .slice(start, after === -1 ? undefined : after)
        .split("\n")
        .filter((l) => l.trimStart().startsWith("|"))
        .join("\n");
      for (const gate of Object.keys(gates)) {
        if (rows.includes(gate)) continue;
        fail(
          `${gate} is not named in a ROW of ${TABLE_FILE}'s "${TABLE_HEADING.slice(3)}" table`,
          "add it to the row of the host that runs it — prose about the table is not the table",
        );
      }
    }
  }

  // NON-enumerable on purpose: the return value IS the violation list, and five
  // existing tests assert `toEqual([])` on a clean tree. An own enumerable
  // property would make an empty result stop comparing equal to an empty array
  // — changing what every caller observes in order to carry a diagnostic.
  Object.defineProperty(violations, "scanned", { value: scanned, enumerable: false });
  return violations;
}

function main() {
  const violations = verifyGateDeclarations();
  if (violations.length === 0) {
    const gates = Object.keys(DECLARED_GATES).length;
    const allowed = UNGATED_ALLOW.length;
    console.log(
      `Gate declarations OK: ${String(gates)} gates, every declared home runs its gate and can fail, every gate in the ${TABLE_FILE} table` +
        (allowed > 0 ? `; ${String(allowed)} ungated with a filed issue` : "") +
        `; swept ${String(violations.scanned)} candidate scripts repo-wide, no orphans`,
    );
    return 0;
  }
  console.error(`\n${String(violations.length)} gate-declaration violation(s):\n`);
  for (const { what, fix } of violations) {
    console.error(`  ✗ ${what}`);
    console.error(`    → ${fix}\n`);
  }
  console.error(
    "A gate that reports green while enforcing nothing is worse than no gate;\n" +
      "an undeclared one is how that happens.\n",
  );
  return 1;
}

// The entry check lives in tools/lib/is-entry.mjs, shared by every gate: this
// file's copy was the only correct one, and three gates beside it exited 0
// through a symlinked path having checked nothing (#794 review).
if (isEntry(process.argv[1], HERE)) {
  process.exit(main());
}
