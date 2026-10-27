#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Which SDKs a change is judged by (#793), and through which job kind of
 * `.github/workflows/sdk-gates.yml` each one runs.
 *
 *   EVENT_NAME=push node tools/repo-gates/select-sdks.mjs
 *   EVENT_NAME=pull_request BASE_SHA=<sha> HEAD_SHA=<sha> node tools/repo-gates/select-sdks.mjs
 *
 * Run from the checkout's root. The one place the selection is decided (plan
 * 867 §5): no workflow filters by path, and the aggregate re-derives nothing.
 *
 * The selection:
 *   - a `push` or a `schedule` selects EVERY SDK of dagger/sdk-manifest.json,
 *     whatever the diff: main is always judged in full;
 *   - a `pull_request` reads `git diff --no-renames --name-only -z
 *     <base>...<head>`, so a rename is a deletion plus an addition and both
 *     sides count. A path under `apps/sdk-<x>/`, `x` a manifest name, selects
 *     `x`; `apps/cli/**` selects nothing (verify.yml gates the CLI); every
 *     other path, the gate's own files and an unknown `apps/sdk-<y>/`
 *     included, selects every SDK. The selection is then closed over the
 *     workspace dependents read from each SDK's package.json (`workspace:`
 *     ranges), never from a map written here. A Gradle, Cargo or mix path
 *     dependency between SDKs is not seen; the push run judges it (FR-004).
 *
 * The routing, from the manifest's `ci` (its `$comment` documents it): an SDK
 * with a daggerFn goes to `gate`, or to `known_red` when its `ci.knownRed` is the BASE
 * commit's on a pull request (the judged commit's own on a push), so a pull
 * request cannot waive its own red; one with `ci.native` goes to `swift`
 * (`macos`) or `smoke`. A Dagger leg is `{ name, daggerFn, live }`: `live` is
 * true exactly when the SDK has a `liveSuite.runner` (#918), and the leg then
 * runs `live-suite --sdk <name>` as a second step, after its suite. A macOS
 * leg is `{ name, live }` (#924): its job runs the same runner natively, after
 * its suite, through run-live-suite.mjs. A smoke leg is the bare name: that
 * job runs no live suite.
 *
 * Output: one `key=value` line per OUTPUT_KEYS entry, appended to
 * $GITHUB_OUTPUT when it is set, else printed. Every selection value is
 * compact JSON built only from manifest names (NAME), daggerFns (DAGGER_FN)
 * and tickets (TICKET); no path reaches them. `gate_files` lists the gate
 * files a pull request changes, plain names only (the rest are counted), for
 * the aggregate's first summary line.
 *
 * Fails closed: a git error, an empty pull-request diff, an unknown event or
 * a manifest it cannot route is exit 2 with nothing written, never an empty
 * selection.
 *
 * Zero dependencies on purpose: the select job runs it without an install.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";

export const MANIFEST = "dagger/sdk-manifest.json";

/** An SDK name: the only text from the manifest that reaches a job name or an output. */
export const NAME = /^[a-z][a-z0-9-]*$/;
/**
 * One Dagger function name, kebab-case as the Dagger CLI takes it: the
 * workflows pass it as `args: <daggerFn> --source=.`, so anything else (a
 * space, `;`, `$( )`) would reach the CLI's command line. The one spelling of
 * the rule: verify-workflows.mjs's daggerFnFindings reads it from here.
 */
export const DAGGER_FN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A ticket reference, `#<issue>`, as ci.knownRed carries it. */
export const TICKET = /^#[1-9]\d*$/;
/** The runners ci.native names: Swift natively on macOS, Unreal's labelled smoke. */
export const NATIVE = ["macos", "smoke"];
// `ci.pending` (an SDK with no leg yet, always red) existed only while the
// families of #793 landed one by one; T10 removed the last one and the key
// with it, so an SDK can never again sit in the matrix with no leg.
const CI_KEYS = ["native", "knownRed"];

/**
 * The job kinds of sdk-gates.yml: each matrix job's id, the output that feeds
 * it, the ci.native it runs (none for the Dagger legs), whether the
 * aggregate counts its result, and whether its job runs an SDK's live suite
 * after its suite (`live`: the Dagger legs since #918, the macOS job since
 * #924; the smoke job never). verify-workflows.mjs rule 19 and
 * conclude-sdk-gates.mjs read this table; neither carries its own.
 */
export const KINDS = [
  { job: "gate", output: "gate", counted: true, live: true },
  { job: "gate-known-red", output: "known_red", counted: false, live: true },
  { job: "swift", output: "swift", native: "macos", counted: true, live: true },
  { job: "smoke", output: "smoke", native: "smoke", counted: true, live: false },
];
/** The select job's own id, whose outputs every other job reads. */
export const SELECT_JOB = "select";

/** Every output, in the order it is written: one per KINDS entry, then the two others (#927 B5). */
export const OUTPUT_KEYS = [...KINDS.map((k) => k.output), "gate_files", "summary"];

/** The events the workflow runs on: pushes and the schedule judge every SDK. */
const ALL_EVENTS = ["push", "schedule"];

/**
 * The paths whose change edits the gate itself (plan 867 S3): a pull request
 * runs its own copy of them, so its green is self-attested, and the
 * aggregate says so on its first line. The manifest is under dagger/.
 */
export const GATE_PREFIXES = [
  ".github/",
  "tools/repo-gates/",
  "dagger/",
  // What the workflow's steps run, beyond the three above (#793 review): the
  // entry-point helper, the Dagger wrapper, the live wrapper whose exit code
  // is a live leg's verdict, the Swift precheck, and the Unreal smoke.
  "tools/lib/",
  "tools/dagger-call/",
  "tools/test-harness-live-contract/",
  "scripts/swift-precheck.sh",
  "apps/sdk-unreal/scripts/",
  // What `pnpm install` reads before any gate step runs (#793 re-review F7).
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
];
/**
 * How every liveSuite.runner starts (#783): the harness wrapper boots the
 * harness and hands the suite `CONFEATURE_LIVE`. A bare runner skips every
 * case and exits 0, so its leg would pass having checked nothing.
 */
export const LIVE_WRAPPER =
  "node tools/test-harness-live-contract/dist/cli.js --corpus-seed --exec -- ";
/**
 * The shell operators and substitutions in `text` that bash would act on, in
 * the order they appear, read with bash's quoting: nothing inside single
 * quotes, only `$(` and backticks inside double quotes, nothing a backslash
 * escapes. `unterminated` is true when a quote never closes.
 *
 * Why (#926 A4): every liveSuite.runner is run as `bash -euo pipefail -c
 * "<runner>"`, so an operator after the wrapped command runs OUTSIDE the
 * harness wrapper, and its exit code, not the wrapper's, is the leg's:
 * `<wrapper> -- cmd || true` is green whatever the suite did. A `bash -c
 * '… && …'` argument is the wrapped command itself, quoted, so it is never
 * read here. A substitution is refused too: it runs a command bash starts
 * before the wrapper, which no check sees. This reads the text, it runs
 * nothing; anything it cannot judge (an open quote) is reported, never passed.
 */
export function shellOperatorsOutsideQuotes(text) {
  const operators = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return { operators, unterminated: true };
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 2;
        else {
          if (text[i] === "`") operators.push("`");
          else if (text.startsWith("$(", i)) operators.push("$(");
          i++;
        }
      }
      if (i >= text.length) return { operators, unterminated: true };
      i++;
    } else if (text.startsWith("$'", i)) {
      // ANSI-C quoting: a backslash escapes any character, `'` closes.
      i += 2;
      while (i < text.length && text[i] !== "'") i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return { operators, unterminated: true };
      i++;
    } else if (text.startsWith("$(", i) || c === "`") {
      operators.push(c === "`" ? "`" : "$(");
      i += c === "`" ? 1 : 2;
    } else if ("|&;<>()\n".includes(c)) {
      const two = text.slice(i, i + 2);
      const op = ["||", "&&", ";;", ">>", "<<", "&>", ">&", "<&", "|&"].includes(two) ? two : c;
      operators.push(op === "\n" ? "newline" : op);
      i += op.length;
    } else i++;
  }
  return { operators, unterminated: false };
}

/** A path printed as it is: no newline, no `$`, no backtick, no `:`, no segment led by a dash. */
export const PLAIN_PATH = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;
/** At most this many gate files are named; the rest are counted. */
const MAX_NAMED = 100;

/** A selection that cannot be computed: exit 2, nothing written. */
export class SelectError extends Error {}

/** The SHAs git is handed: full object names only, so none can be read as an option. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Why each manifest entry cannot be routed, as `{ sdk, why }`. An SDK runs
 * through exactly one of a Dagger function (`daggerFn`) or a native runner
 * (`ci.native`); a known-red waiver needs a Dagger leg to run red in; every
 * ticket is `#<issue>`. A `liveSuite` has a runner and needs a job that runs
 * it: a Dagger leg (#918) or a native kind whose KINDS entry is `live`, the
 * macOS job (#924), and runs through LIVE_WRAPPER with no shell operator after
 * it (shellOperatorsOutsideQuotes, #926 A4); an SDK has a liveSuite or a
 * `liveExempt` reason, never both.
 * The daggerFn's own shape is DAGGER_FN, checked where it is used. verify-workflows.mjs rule 19 reports these on every verify.
 */
export function manifestProblems(manifest) {
  const sdks = manifest?.sdks;
  if (!Array.isArray(sdks) || sdks.length === 0)
    return [{ sdk: "-", why: "the manifest has no sdks[]" }];
  const out = [];
  const seen = new Set();
  for (const s of sdks) {
    const sdk = typeof s?.name === "string" ? s.name : "?";
    const add = (why) => out.push({ sdk, why });
    if (typeof s?.name !== "string" || !NAME.test(s.name))
      add(`name ${JSON.stringify(s?.name)} is not an SDK name (${NAME.source})`);
    else if (seen.has(s.name)) add("is listed twice");
    seen.add(s?.name);
    const ci = s?.ci;
    if (ci !== undefined && (ci === null || typeof ci !== "object" || Array.isArray(ci))) {
      add("ci is not an object");
      continue;
    }
    for (const k of Object.keys(ci ?? {}))
      if (!CI_KEYS.includes(k))
        add(`ci.${k} is not one of ${CI_KEYS.map((x) => `ci.${x}`).join(", ")}`);
    const dagger = s?.daggerFn !== undefined && s?.daggerFn !== null;
    const native = ci?.native !== undefined;
    if (dagger === native)
      add(
        `has ${dagger ? "both" : "neither of"} daggerFn and ci.native: it needs exactly one of daggerFn or ci.native`,
      );
    if (native && !NATIVE.includes(ci.native))
      add(`ci.native ${JSON.stringify(ci.native)} is not one of ${NATIVE.join(", ")}`);
    const live = s?.liveSuite;
    if (live !== undefined) {
      if (typeof live?.runner !== "string" || live.runner.trim() === "")
        add("liveSuite.runner is not a command (a liveSuite with no runner runs nothing)");
      else if (
        !live.runner.startsWith(LIVE_WRAPPER) ||
        live.runner.slice(LIVE_WRAPPER.length).trim() === ""
      )
        add(
          `liveSuite.runner does not run a command through the harness wrapper (${LIVE_WRAPPER.trim()}): without it the suite skips every case and passes`,
        );
      else {
        const { operators, unterminated } = shellOperatorsOutsideQuotes(
          live.runner.slice(LIVE_WRAPPER.length),
        );
        if (unterminated)
          add(
            "liveSuite.runner has an unterminated quote: what bash runs after the wrapper cannot be judged",
          );
        if (operators.length > 0)
          add(
            `liveSuite.runner has a shell operator or substitution outside the wrapped command (${[...new Set(operators)].join(" ")}): bash runs it outside the harness wrapper, so its exit code, not the wrapper's, would be the leg's (quote it inside the command, e.g. bash -c '…')`,
          );
      }
      const runsLive = dagger || KINDS.some((k) => k.native === ci?.native && k.live);
      if (!runsLive)
        add(
          "liveSuite on an SDK whose job runs no live suite (neither a Dagger leg nor the macOS job): no leg runs it, so it would never run",
        );
      if (s?.liveExempt !== undefined)
        add("has both a liveSuite and a liveExempt: an SDK has a live suite or a reason, not both");
    }
    if (
      s?.liveExempt !== undefined &&
      (typeof s.liveExempt !== "string" || s.liveExempt.trim() === "")
    )
      add("liveExempt is not a reason (a non-empty string)");
    if (ci?.knownRed !== undefined) {
      if (!TICKET.test(String(ci.knownRed)) || typeof ci.knownRed !== "string")
        add(`ci.knownRed ${JSON.stringify(ci.knownRed)} is not a ticket (#<issue>)`);
      if (!dagger) add("ci.knownRed: only a daggerFn SDK has a leg to run red in");
    }
  }
  return out;
}

/**
 * What one changed path selects: a manifest name, `null` (apps/cli, which
 * selects nothing), or `"all"` (anything outside every SDK's directory, an
 * unknown `apps/sdk-<y>/` included).
 */
export function classifyPath(path, names) {
  if (path.startsWith("apps/cli/")) return null;
  const m = /^apps\/sdk-([^/]+)\/./s.exec(path);
  if (m !== null && names.has(m[1])) return m[1];
  return "all";
}

/**
 * The SDK names a change selects, in manifest order, and why: `all`, `some`
 * or `none`. `changed` is the pull request's diff, ignored on a push or a
 * schedule; `dependents` maps a name to the names that depend on it.
 */
export function selectNames({ event, names, changed, dependents }) {
  if (ALL_EVENTS.includes(event)) return { names: [...names], reason: "all" };
  if (event !== "pull_request")
    throw new SelectError(`event ${JSON.stringify(event)} is not push, schedule or pull_request`);
  if (!Array.isArray(changed) || changed.length === 0)
    throw new SelectError(
      "the pull request's diff is empty: nothing to judge it by is an error, never an empty selection",
    );
  const known = new Set(names);
  const picked = new Set();
  for (const path of changed) {
    const c = classifyPath(path, known);
    if (c === "all") return { names: [...names], reason: "all" };
    if (c !== null) picked.add(c);
  }
  // Close over the dependents: a change to browser-js is a change to react.
  const stack = [...picked];
  while (stack.length > 0)
    for (const d of dependents.get(stack.pop()) ?? [])
      if (known.has(d) && !picked.has(d)) {
        picked.add(d);
        stack.push(d);
      }
  const out = names.filter((n) => picked.has(n));
  return { names: out, reason: out.length === 0 ? "none" : "some" };
}

/**
 * Who depends on whom among the SDKs, read from each `apps/sdk-<name>/
 * package.json`'s `workspace:` ranges (every dependency kind): a map from a
 * name to the set of names whose package depends on it. An SDK without a
 * package.json has no workspace dependency; one that does not parse is an
 * error.
 */
export function workspaceDependents(root, names) {
  const pkgs = new Map();
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(root, "apps", `sdk-${name}`, "package.json"), "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      throw new SelectError(`apps/sdk-${name}/package.json: ${e?.message ?? e}`, { cause: e });
    }
    try {
      pkgs.set(name, JSON.parse(text));
    } catch (e) {
      throw new SelectError(`apps/sdk-${name}/package.json does not parse (${e.message})`, {
        cause: e,
      });
    }
  }
  const byPackage = new Map([...pkgs].map(([name, p]) => [p?.name, name]));
  const out = new Map();
  for (const [name, p] of pkgs)
    for (const kind of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const [dep, range] of Object.entries(p?.[kind] ?? {})) {
        const target = byPackage.get(dep);
        if (target === undefined || target === name || !String(range).startsWith("workspace:"))
          continue;
        if (!out.has(target)) out.set(target, new Set());
        out.get(target).add(name);
      }
  return out;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether `x` is NOT a leg `routeSelection` could have written for `kind`
 * (#927 B4): a bare name for a kind with no live suite, `{ name, live }` for a
 * native live kind, and `{ name, daggerFn, live }` for a Dagger leg, which
 * carries its waiver's `ticket` on the known-red output. The one statement of
 * the leg shape, read back by conclude-sdk-gates.mjs.
 */
export function legProblem(kind, x) {
  const leg =
    isObject(x) && typeof x.name === "string" && NAME.test(x.name) && typeof x.live === "boolean";
  if (!kind.live) return typeof x !== "string" || !NAME.test(x);
  if (kind.native !== undefined) return !leg;
  return (
    !leg ||
    typeof x.daggerFn !== "string" ||
    !DAGGER_FN.test(x.daggerFn) ||
    (kind.output === "known_red" && (typeof x.ticket !== "string" || !TICKET.test(x.ticket)))
  );
}

/**
 * Route selected names into the job kinds. `baseManifest` is where the
 * known-red waiver is read on a pull request (the base commit's), and the
 * judged commit's own manifest otherwise; a waiver that is not a ticket is
 * no waiver.
 */
export function routeSelection({ event, names, manifest, baseManifest }) {
  const byName = new Map(manifest.sdks.map((s) => [s.name, s]));
  const waivers = event === "pull_request" ? baseManifest : manifest;
  const waiver = (name) => {
    const w = (waivers?.sdks ?? []).find((s) => s?.name === name)?.ci?.knownRed;
    return typeof w === "string" && TICKET.test(w) ? w : null;
  };
  const out = Object.fromEntries(KINDS.map((k) => [k.output, []]));
  for (const name of names) {
    const s = byName.get(name);
    if (s?.ci?.native !== undefined) {
      const kind = KINDS.find((k) => k.native === s.ci.native);
      out[kind.output].push(
        kind.live ? { name, live: typeof s.liveSuite?.runner === "string" } : name,
      );
      continue;
    }
    if (typeof s?.daggerFn !== "string" || !DAGGER_FN.test(s.daggerFn))
      throw new SelectError(
        `${name}: daggerFn ${JSON.stringify(s?.daggerFn)} is not one Dagger function name (${DAGGER_FN.source})`,
      );
    const ticket = waiver(name);
    const leg = { name, daggerFn: s.daggerFn, live: typeof s.liveSuite?.runner === "string" };
    if (ticket === null) out.gate.push(leg);
    else out.known_red.push({ ...leg, ticket });
  }
  return out;
}

/**
 * The gate files among a pull request's changed paths: plain names listed,
 * at most MAX_NAMED, and every other one counted in `unnamed`, so a hostile
 * file name is reported without being printed.
 */
export function gateFiles(changed) {
  const gate = (changed ?? []).filter((p) => GATE_PREFIXES.some((g) => p.startsWith(g)));
  const plain = gate.filter((p) => PLAIN_PATH.test(p));
  const files = plain.slice(0, MAX_NAMED);
  return { files, unnamed: gate.length - files.length };
}

/** One human line, built from names and counts only. */
function summaryOf(event, selection, total) {
  if (selection.reason === "none") return `${event}: no SDK selected (only apps/cli changed)`;
  if (selection.reason === "all")
    return event === "pull_request"
      ? `${event}: every SDK selected (${total}): a change outside one SDK's directory`
      : `${event}: every SDK selected (${total})`;
  return `${event}: ${selection.names.length} of ${total} SDKs selected: ${selection.names.join(", ")}`;
}

/** Run git in `root`; its stdout, or a SelectError naming the command. */
function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0)
    throw new SelectError(
      `git ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`}`,
    );
  return r.stdout;
}

const parseManifest = (text, where) => {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new SelectError(`${where} does not parse (${e.message})`, { cause: e });
  }
  return m;
};

/** The whole selection for one run: every output, from the tree at `root` and git. */
export function selectionFor({ root, env }) {
  const event = env.EVENT_NAME;
  const manifest = parseManifest(readManifest(root), MANIFEST);
  const problems = manifestProblems(manifest);
  if (problems.length > 0)
    throw new SelectError(problems.map((p) => `${MANIFEST}: ${p.sdk}: ${p.why}`).join("\n"));
  const names = manifest.sdks.map((s) => s.name);
  let changed = null;
  let baseManifest = manifest;
  if (event === "pull_request") {
    for (const k of ["BASE_SHA", "HEAD_SHA"])
      if (!SHA.test(env[k] ?? ""))
        throw new SelectError(`${k} ${JSON.stringify(env[k] ?? "")} is not a full commit SHA`);
    changed = git(root, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${env.BASE_SHA}...${env.HEAD_SHA}`,
      "--",
    ])
      .split("\0")
      .filter((p) => p !== "");
    baseManifest = parseManifest(
      git(root, ["show", `${env.BASE_SHA}:${MANIFEST}`]),
      `${MANIFEST} at the base`,
    );
  }
  const selection = selectNames({
    event,
    names,
    changed,
    dependents: workspaceDependents(root, names),
  });
  const routed = routeSelection({ event, names: selection.names, manifest, baseManifest });
  const out = {
    ...Object.fromEntries(Object.entries(routed).map(([k, v]) => [k, JSON.stringify(v)])),
    gate_files: JSON.stringify(gateFiles(event === "pull_request" ? changed : [])),
    summary: summaryOf(event, selection, names.length),
  };
  // Belt and braces: one line per output, whatever went before.
  for (const [k, v] of Object.entries(out))
    if (/[\r\n]/.test(v)) throw new SelectError(`output ${k} would span lines`);
  return Object.fromEntries(OUTPUT_KEYS.map((k) => [k, out[k]]));
}

function readManifest(root) {
  try {
    return readFileSync(join(root, MANIFEST), "utf8");
  } catch (e) {
    throw new SelectError(`${MANIFEST}: ${e?.message ?? e}`, { cause: e });
  }
}

function main() {
  let out;
  try {
    out = selectionFor({ root: process.cwd(), env: process.env });
  } catch (e) {
    console.error(`select-sdks: ${e?.message ?? e}`);
    return 2;
  }
  const lines = Object.entries(out)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  console.error(`select-sdks: ${out.summary}`);
  return 0;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
