// SPDX-License-Identifier: MIT

/**
 * engine-pin (#865, #868): every CI job that runs Dagger pins, derives and
 * verifies. It pins `dagger/dagger-for-github` to a commit SHA, derives the
 * engine version from `dagger/dagger.json` instead of writing it out, runs
 * only a CLI verified against `dagger/cli-checksums.txt`, the copy committed in
 * this repository, never one the action or `install.sh` fetched unverified,
 * and runs the engine image by the digest `dagger/engine-digest.txt` records
 * for that version, never by a tag the registry can move.
 *
 * The setup has one home, a composite action under `.github/actions/`: a
 * workflow step that fetches Dagger, reads engineVersion or names the runner
 * host is refused, so the setup cannot drift back into copies. A local
 * `uses: ./…` is followed into its action.yml and its steps checked in place,
 * so the guard does not go blind on the move: the action's step answering its
 * `version` output takes the calling step's id.
 *
 * A job "runs Dagger" when a step uses the action or has a shell line whose
 * command is `dagger`; a step "fetches Dagger" when it names dl.dagger.io, the
 * Dagger `install.sh`, the Homebrew tap, or `cli-checksums.txt`. Every fetch
 * must be the verified install, and every run must follow a pin step, a
 * verified install and a step exporting the digest-pinned runner host. No file
 * under `.github/` names the engine image without a digest. Workflows are
 * found by CONTENT, not by name: any `.github/workflows/*.y{a,}ml` or
 * `.github/actions/**` file that does either, or uses a local action. A step
 * the parser cannot see is caught by the count parity between raw `uses:`
 * lines and parsed steps, and a repository where nothing runs Dagger fails
 * too. This test is the single home of the fact that CI pins, derives and
 * verifies; it must not be restated as a second check inside a workflow (plan
 * 687 §5).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ACTION = /^dagger\/dagger-for-github(?:@|$)/i;
const PINNED_ACTION = /^dagger\/dagger-for-github@[0-9a-f]{40}$/;
const RAW_USES = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?dagger\/dagger-for-github\b/gim;
/** A raw `uses:` of a local action. */
const RAW_LOCAL_USES = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?\.\//m;
/** A shell line whose command is the dagger CLI, raw (in YAML) or parsed (in a run block). */
const RUNS_DAGGER =
  /^[ \t]*(?:-[ \t]+)?(?:run:[ \t]*)?(?:sudo[ \t]+)?(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:[^\s"'$=]*\/)?dagger(?:[ \t]|$)/m;
/** Any way to fetch a Dagger CLI. */
const FETCHES_DAGGER = /dl\.dagger\.io|dagger\/install\.sh|dagger\/tap|cli-checksums\.txt/i;
const PIN_EXPR = "${{ steps.pin.outputs.version }}";
const TARBALL = "dagger_${DAGGER_VERSION}_linux_amd64";
const SEMVER = /^v\d+\.\d+\.\d+$/;
/** The CLI's runner host (Dagger v0.21 cmd/dagger/engine.go RunnerHostEnv). */
const HOST_VAR = "_EXPERIMENTAL_DAGGER_RUNNER_HOST";
const ENGINE_IMAGE = "registry.dagger.io/engine";
/** The engine image named anywhere without `@`: by tag, or by nothing (latest). */
const ENGINE_BY_TAG = /registry\.dagger\.io\/engine(?!@)/i;
const DIGEST_FILE = "dagger/engine-digest.txt";
/** The one export a runner-host step makes: the CLI's own `image://` scheme, by digest. */
const HOST_EXPORT = `echo "${HOST_VAR}=image://${ENGINE_IMAGE}@\${digest}" >> "$GITHUB_ENV"`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (s, needle) => s.split(needle).length - 1;
const text = (v) =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
const isStep = (s) => s !== null && typeof s === "object" && !Array.isArray(s);
const usesAction = (s) => isStep(s) && typeof s.uses === "string" && ACTION.test(s.uses.trim());
const usesLocal = (s) => isStep(s) && typeof s.uses === "string" && s.uses.trim().startsWith("./");
const fetchesDagger = (s) => isStep(s) && FETCHES_DAGGER.test(text(s.run));
const namesHost = (s) => isStep(s) && (text(s.run) + text(s.env)).includes(HOST_VAR);
const readsEngineVersion = (s) => isStep(s) && /engineVersion/.test(text(s.run));

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const isWorkflowFile = (root, file) =>
  relative(join(root, ".github", "workflows"), file).split(/[\\/]/)[0] !== "..";

/** Every workflow or action file that runs or fetches Dagger, names its engine, or uses a local action. */
function candidates(root) {
  const wf = join(root, ".github", "workflows");
  const workflows = existsSync(wf)
    ? readdirSync(wf)
        .filter((n) => /\.ya?ml$/.test(n))
        .map((n) => join(wf, n))
        .filter((p) => statSync(p).isFile())
    : [];
  return [...workflows, ...filesUnder(join(root, ".github", "actions"))].filter((p) => {
    const raw = readFileSync(p, "utf-8");
    return (
      raw.toLowerCase().includes("dagger/dagger-for-github") ||
      FETCHES_DAGGER.test(raw) ||
      RUNS_DAGGER.test(raw) ||
      raw.includes(HOST_VAR) ||
      raw.toLowerCase().includes(ENGINE_IMAGE) ||
      RAW_LOCAL_USES.test(raw)
    );
  });
}

/** Every parsed list holding a step that runs, fetches or sets up Dagger: a job's (or a composite's) steps. */
function daggerJobs(node, out = []) {
  if (Array.isArray(node)) {
    if (
      node.some(
        (s) =>
          usesAction(s) ||
          usesLocal(s) ||
          fetchesDagger(s) ||
          namesHost(s) ||
          RUNS_DAGGER.test(text(s?.run)),
      )
    ) {
      out.push(node);
    }
    for (const el of node) daggerJobs(el, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) daggerJobs(v, out);
  }
  return out;
}

/**
 * A job's steps with each local `uses: ./…` replaced by its composite action's
 * steps (#868), recursively. Each expanded step records its action file in
 * `from`; the step answering the action's `version` output takes the calling
 * step's id, and every other expanded step loses its id (an action's ids are
 * its own). A local action that is missing, outside the repository, not
 * composite or recursive is a violation, and contributes no step.
 */
function expand(root, rel, steps, violations, seen = []) {
  const out = [];
  steps.forEach((s, i) => {
    if (!usesLocal(s)) {
      out.push(s);
      return;
    }
    const ref = s.uses.trim();
    const where = `${rel}: step "${s.name ?? i}"`;
    const dir = resolve(root, ref);
    if (relative(root, dir).split(/[\\/]/)[0] === "..") {
      violations.push(`${where}: uses ${ref}, outside the repository`);
      return;
    }
    const file = ["action.yml", "action.yaml"].map((n) => join(dir, n)).find(existsSync);
    if (file === undefined) {
      violations.push(`${where}: uses ${ref}, which has no action.yml`);
      return;
    }
    const arel = relative(root, file);
    if (seen.includes(arel)) {
      violations.push(`${where}: uses ${ref}, which uses itself`);
      return;
    }
    let doc;
    try {
      doc = parse(readFileSync(file, "utf-8"));
    } catch (e) {
      violations.push(`${arel}: does not parse as YAML (${e.message.split("\n")[0]})`);
      return;
    }
    if (doc?.runs?.using !== "composite" || !Array.isArray(doc.runs.steps)) {
      violations.push(`${where}: uses ${ref}, which is not a composite action`);
      return;
    }
    const answers = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.version\s*\}\}$/.exec(
      text(doc.outputs?.version?.value).trim(),
    );
    for (const t of expand(root, arel, doc.runs.steps, violations, [...seen, arel])) {
      if (!isStep(t)) {
        out.push(t);
        continue;
      }
      const { id, ...rest } = t;
      const keep = answers !== null && id === answers[1] && s.id !== undefined;
      out.push({ ...rest, ...(keep ? { id: s.id } : {}), from: t.from ?? arel });
    }
  });
  return out;
}

function engineVersionOf(root, violations) {
  let ev;
  try {
    ev = JSON.parse(readFileSync(join(root, "dagger", "dagger.json"), "utf-8")).engineVersion;
  } catch (e) {
    violations.push(`dagger/dagger.json: unreadable (${e.message})`);
    return null;
  }
  if (typeof ev !== "string" || !SEMVER.test(ev)) {
    violations.push(
      `dagger/dagger.json: engineVersion ${JSON.stringify(ev)} is missing or not vMAJOR.MINOR.PATCH`,
    );
    return null;
  }
  return ev;
}

function checkChecksums(root, ev, violations) {
  const file = join(root, "dagger", "cli-checksums.txt");
  const body = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const line = new RegExp(`^[0-9a-f]{64}  dagger_${escape(ev)}_linux_amd64\\.tar\\.gz$`, "gm");
  const n = (body.match(line) ?? []).length;
  if (n !== 1) {
    violations.push(
      `dagger/cli-checksums.txt: ${n} entries for dagger_${ev}_linux_amd64.tar.gz, expected exactly 1`,
    );
  }
}

/** dagger/engine-digest.txt (#868): one `<engineVersion>  sha256:<64 hex>` line, for dagger.json's version. */
function checkDigest(root, ev, violations) {
  const file = join(root, DIGEST_FILE);
  if (!existsSync(file)) {
    violations.push(`${DIGEST_FILE}: missing; CI would run the engine image by its tag`);
    return;
  }
  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"));
  if (lines.length !== 1) {
    violations.push(`${DIGEST_FILE}: ${lines.length} entries, expected exactly 1`);
    return;
  }
  const m = /^(v\d+\.\d+\.\d+)  (sha256:[0-9a-f]{64})$/.exec(lines[0]);
  if (m === null) {
    violations.push(
      `${DIGEST_FILE}: ${JSON.stringify(lines[0])} is not "<vMAJOR.MINOR.PATCH>  sha256:<64 hex>"`,
    );
  } else if (m[1] !== ev) {
    violations.push(`${DIGEST_FILE}: pins ${m[1]}, but dagger/dagger.json engineVersion is ${ev}`);
  }
}

/** Why a step that fetches Dagger is not the verified install; empty when it is. */
function installProblems(step) {
  const run = text(step.run);
  const problems = [];
  if (
    !run.includes("dagger/cli-checksums.txt") ||
    !/\bsha256sum\s+-c\b/.test(run) ||
    !run.includes("GITHUB_PATH")
  ) {
    problems.push(
      "does not install a CLI verified with sha256sum -c against dagger/cli-checksums.txt onto $GITHUB_PATH",
    );
  }
  if (!run.includes(TARBALL)) problems.push(`does not fetch the tarball ${TARBALL}`);
  if (!/dagger\s+--silent\s+version\b/.test(run) || !run.includes('!= "${DAGGER_VERSION}"')) {
    problems.push("does not check that the installed CLI reports ${DAGGER_VERSION}");
  }
  if (!(text(step.env) + run).includes("steps.pin.outputs.version")) {
    problems.push("does not take its version from steps.pin");
  }
  if (/(?<!cli-)checksums\.txt/.test(run)) {
    problems.push("fetches a checksum at run time; trust dagger/cli-checksums.txt only");
  }
  if (/install\.sh/.test(run)) {
    problems.push("runs install.sh, which trusts the download host's checksum");
  }
  if (/dagger\/tap|brew\s+install/.test(run)) problems.push("installs from Homebrew, unverified");
  return problems;
}

/** Why a step naming the runner host is not the digest-pinned export (#868); empty when it is. */
function hostProblems(step) {
  const run = text(step.run);
  const problems = [];
  if (!run.includes(DIGEST_FILE)) problems.push(`does not read the digest from ${DIGEST_FILE}`);
  if (
    !run.includes("${DAGGER_VERSION}") ||
    !(text(step.env) + run).includes("steps.pin.outputs.version")
  ) {
    problems.push("does not select the digest for steps.pin's version");
  }
  if (!run.includes("sha256:[0-9a-f]{64}")) {
    problems.push("does not refuse a digest that is not sha256:<64 hex>");
  }
  if (!run.includes(HOST_EXPORT)) problems.push(`does not run exactly ${HOST_EXPORT}`);
  if (count(run, HOST_VAR) !== 1 || text(step.env).includes(HOST_VAR)) {
    problems.push(`names ${HOST_VAR} other than in that one export`);
  }
  return problems;
}

function checkAction(where, step, violations) {
  if (!PINNED_ACTION.test(step.uses.trim())) {
    violations.push(
      `${where}: uses "${step.uses}" does not pin dagger/dagger-for-github to a 40-hex commit SHA`,
    );
  }
  const w = step.with && typeof step.with === "object" ? step.with : {};
  if (!("version" in w)) {
    violations.push(`${where}: no version: (the action would install the latest engine)`);
  } else if (/latest/i.test(text(w.version))) {
    violations.push(`${where}: version: latest`);
  } else if (w.version !== PIN_EXPR) {
    violations.push(`${where}: literal version: ${JSON.stringify(w.version)}; use ${PIN_EXPR}`);
  }
  if ("commit" in w) violations.push(`${where}: commit: overrides the pinned engine`);
}

/**
 * One job's steps, local actions expanded: in a workflow nothing sets Dagger
 * up inline; every fetch is the verified install; every runner host the
 * digest-pinned export; every run follows pin, install and runner host.
 */
function checkJob(root, rel, rawSteps, violations, workflow) {
  const steps = expand(root, rel, rawSteps, violations);
  const named = (s, i) => `${s.from ?? rel}: step "${s.name ?? i}"`;
  if (workflow) {
    for (const s of steps) {
      if (s?.from === undefined && (fetchesDagger(s) || readsEngineVersion(s) || namesHost(s))) {
        violations.push(
          `${named(s, steps.indexOf(s))}: sets Dagger up inline; use the composite action under .github/actions/ (#868)`,
        );
      }
    }
  }
  const installs = steps.filter(fetchesDagger);
  for (const s of installs) {
    for (const p of installProblems(s)) violations.push(`${named(s, steps.indexOf(s))}: ${p}`);
  }
  const verified = (s) => installs.includes(s) && installProblems(s).length === 0;
  const hosts = steps.filter(namesHost);
  for (const s of hosts) {
    for (const p of hostProblems(s)) violations.push(`${named(s, steps.indexOf(s))}: ${p}`);
  }
  const pinned = (s) => hosts.includes(s) && hostProblems(s).length === 0;

  let runs = 0;
  steps.forEach((step, index) => {
    const isAction = usesAction(step);
    const runsDagger = isStep(step) && !installs.includes(step) && RUNS_DAGGER.test(text(step.run));
    if (!isAction && !runsDagger) return;
    runs += 1;
    const where = named(step, index);
    if (isAction) checkAction(where, step, violations);

    const before = steps.slice(0, index);
    const pinAt = before.findIndex((s) => isStep(s) && s.id === "pin");
    if (pinAt < 0) {
      violations.push(`${where}: no earlier step with id: pin`);
      return;
    }
    const pinRun = text(before[pinAt].run);
    if (
      !pinRun.includes("dagger/dagger.json") ||
      !pinRun.includes("engineVersion") ||
      !pinRun.includes("GITHUB_OUTPUT")
    ) {
      violations.push(
        `${where}: the pin step does not read engineVersion from dagger/dagger.json into $GITHUB_OUTPUT`,
      );
    }
    if (!before.slice(pinAt + 1).some(verified)) {
      violations.push(
        `${where}: no step between pin and the action installs a CLI verified with sha256sum -c against dagger/cli-checksums.txt onto $GITHUB_PATH`,
      );
    }
    if (!before.slice(pinAt + 1).some(pinned)) {
      violations.push(
        `${where}: no step between pin and the action exports the engine image by the digest in ${DIGEST_FILE} (${HOST_VAR})`,
      );
    }
  });

  if (runs > 0) {
    for (const s of steps) {
      if (isStep(s) && typeof s.uses === "string" && /^actions\/checkout@/i.test(s.uses.trim())) {
        const pc = s.with && s.with["persist-credentials"];
        if (pc !== false && pc !== "false") {
          violations.push(
            `${rel}: a job that runs Dagger checks out with GITHUB_TOKEN kept; set persist-credentials: false`,
          );
        }
      }
    }
  }
  return runs;
}

/** Every way the repository at `root` fails to pin, derive and verify. */
function audit(root) {
  const violations = [];
  const ev = engineVersionOf(root, violations);
  if (ev) {
    checkChecksums(root, ev, violations);
    checkDigest(root, ev, violations);
  }

  // No file under .github/ names the engine image by tag (#868).
  for (const file of filesUnder(join(root, ".github"))) {
    if (ENGINE_BY_TAG.test(readFileSync(file, "utf-8"))) {
      violations.push(
        `${relative(root, file)}: names ${ENGINE_IMAGE} without a digest; it runs by ${DIGEST_FILE}`,
      );
    }
  }

  let total = 0;
  for (const file of candidates(root)) {
    const rel = relative(root, file);
    const workflow = isWorkflowFile(root, file);
    const raw = readFileSync(file, "utf-8");
    const rawCount = (raw.match(RAW_USES) ?? []).length;
    let doc;
    try {
      doc = parse(raw);
    } catch (e) {
      violations.push(`${rel}: does not parse as YAML (${e.message.split("\n")[0]})`);
      continue;
    }
    const jobs = daggerJobs(doc);
    const parsedCount = jobs.flat().filter(usesAction).length;
    if (parsedCount !== rawCount) {
      violations.push(
        `${rel}: ${parsedCount} parsed dagger-for-github steps but ${rawCount} raw uses: lines`,
      );
    }
    if (ev && new RegExp(`(?<![\\d.])v?${escape(ev.slice(1))}(?![\\d.])`).test(raw)) {
      violations.push(
        `${rel}: writes the engine version ${ev} out; it lives in dagger/dagger.json only`,
      );
    }
    // The runner host has one home: a workflow never names it (a job or
    // workflow env: would override the action's); an action names it only in
    // its digest-pinned export steps.
    if (workflow && (raw.includes(HOST_VAR) || raw.toLowerCase().includes(ENGINE_IMAGE))) {
      violations.push(
        `${rel}: names ${HOST_VAR} or ${ENGINE_IMAGE}; only the composite action under .github/actions/ sets the engine`,
      );
    }
    if (!workflow) {
      const exports = jobs
        .flat()
        .filter((s) => namesHost(s) && hostProblems(s).length === 0)
        .reduce((n, s) => n + count(text(s.run), HOST_VAR), 0);
      if (count(raw, HOST_VAR) !== exports) {
        violations.push(`${rel}: names ${HOST_VAR} outside its digest-pinned export step`);
      }
    }
    for (const steps of jobs) total += checkJob(root, rel, steps, violations, workflow);
  }
  if (total < 1) violations.push("nothing runs Dagger: the check would be checking nothing");
  return [...new Set(violations)];
}

describe("the repository", () => {
  it("pins, derives and verifies every job that runs Dagger", () => {
    expect(audit(ROOT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Each way the audit fails, against a fixture tree. A good fixture passes, and
// every mutation of it trips exactly the branch it targets.

const SHA = "27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77";
const HASH = "f".repeat(64);
const DIGEST = `sha256:${"a".repeat(64)}`;
const SETUP_PATH = "dagger-setup/action.yml";
const PIN_STEP = `      - name: Read the engine version
        id: pin
        run: |
          version=$(jq -r '.engineVersion // empty' dagger/dagger.json)
          echo "version=\${version}" >> "$GITHUB_OUTPUT"
`;
const INSTALL_STEP = `      - name: Install the verified CLI
        env:
          DAGGER_VERSION: \${{ steps.pin.outputs.version }}
        run: |
          tarball="dagger_\${DAGGER_VERSION}_linux_amd64.tar.gz"
          curl -fsSL -o "\${tarball}" "https://dl.dagger.io/dagger/releases/\${DAGGER_VERSION#v}/\${tarball}"
          awk -v f="\${tarball}" '$2 == f' "$GITHUB_WORKSPACE/dagger/cli-checksums.txt" > e.sha256
          sha256sum -c --strict e.sha256
          tar -xzf "\${tarball}" -C bin dagger
          got="$(bin/dagger --silent version | cut -d ' ' -f 2)"
          if [ "\${got}" != "\${DAGGER_VERSION}" ]; then exit 1; fi
          echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"
`;
const HOST_LINE = `echo "_EXPERIMENTAL_DAGGER_RUNNER_HOST=image://registry.dagger.io/engine@\${digest}" >> "$GITHUB_ENV"`;
const HOST_STEP = `      - name: Pin the engine by digest
        env:
          DAGGER_VERSION: \${{ steps.pin.outputs.version }}
        run: |
          awk -v v="\${DAGGER_VERSION}" '$1 == v { print $2 }' "$GITHUB_WORKSPACE/dagger/engine-digest.txt" > d
          digest="$(cat d)"
          printf '%s\\n' "\${digest}" | grep -Eqx 'sha256:[0-9a-f]{64}'
          ${HOST_LINE}
`;
/** The composite action: pin, verified install, runner host. */
const SETUP = `name: setup
outputs:
  version:
    value: \${{ steps.pin.outputs.version }}
runs:
  using: composite
  steps:
${PIN_STEP}${INSTALL_STEP}${HOST_STEP}`;
const SETUP_STEP = `      - name: Set up Dagger
        id: pin
        uses: ./.github/actions/dagger-setup
`;
const CHECKOUT = `      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          persist-credentials: false
`;
const RUN_ACTION = `      - name: Run (Dagger)
        uses: dagger/dagger-for-github@${SHA} # v8.4.1
        with:
          version: \${{ steps.pin.outputs.version }}
          verb: call
`;
const GOOD = `name: gate
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${CHECKOUT}${SETUP_STEP}${RUN_ACTION}      - name: Run the CLI directly
        run: dagger call js-test --source=.
`;

let fixtures = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f, { recursive: true, force: true });
  fixtures = [];
});

/** A fixture repository; `actions` entries merge over the setup action, `null` deletes one. */
function tree(opts = {}) {
  const {
    workflows = { "gate.yml": GOOD },
    checksums = `${HASH}  dagger_v0.21.10_linux_amd64.tar.gz\n`,
    digest = `# comment\nv0.21.10  ${DIGEST}\n`,
  } = opts;
  const actions = { [SETUP_PATH]: SETUP, ...opts.actions };
  // An explicit `engineVersion: undefined` means "no key", not the default.
  const engineVersion = Object.hasOwn(opts, "engineVersion") ? opts.engineVersion : "v0.21.10";
  const root = mkdtempSync(join(tmpdir(), "engine-pin-"));
  fixtures.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "dagger"));
  for (const [n, body] of Object.entries(workflows))
    writeFileSync(join(root, ".github", "workflows", n), body);
  for (const [n, body] of Object.entries(actions)) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, ".github", "actions", n)), { recursive: true });
    writeFileSync(join(root, ".github", "actions", n), body);
  }
  const json = engineVersion === undefined ? {} : { engineVersion };
  writeFileSync(
    join(root, "dagger", "dagger.json"),
    opts.daggerJson ?? JSON.stringify({ name: "x", ...json }),
  );
  if (checksums !== null) writeFileSync(join(root, "dagger", "cli-checksums.txt"), checksums);
  if (digest !== null) writeFileSync(join(root, "dagger", "engine-digest.txt"), digest);
  return root;
}

const swap = (from, to) => {
  if (!GOOD.includes(from)) throw new Error(`fixture mutation does not apply: ${from}`);
  return { workflows: { "gate.yml": GOOD.replace(from, to) } };
};
/** The same, in the setup action. */
const swapSetup = (from, to) => {
  if (!SETUP.includes(from)) throw new Error(`setup mutation does not apply: ${from}`);
  return { actions: { [SETUP_PATH]: SETUP.replace(from, to) } };
};
/** A second workflow: one job with these steps, checked out without credentials. */
const job = (steps) => ({
  workflows: {
    "gate.yml": GOOD,
    "other.yml": `on: [push]\njobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
  },
});

describe("the good fixture", () => {
  it("passes", () => {
    expect(audit(tree())).toEqual([]);
  });
});

describe("each way it fails closed", () => {
  it.each([
    [
      "a literal version",
      swap(`version: ${PIN_EXPR}`, "version: v0.21.10"),
      /literal version: "v0\.21\.10"/,
    ],
    [
      "the version number in a comment",
      swap("# v8.4.1", "# v8.4.1, engine 0.21.10"),
      /writes the engine version v0\.21\.10 out/,
    ],
    [
      "the version number in the setup action",
      swapSetup("name: setup", "name: setup 0.21.10"),
      /dagger-setup\/action\.yml: writes the engine version v0\.21\.10 out/,
    ],
    ["version: latest", swap(`version: ${PIN_EXPR}`, "version: latest"), /version: latest/],
    [
      "no version:",
      swap(`          version: ${PIN_EXPR}\n`, ""),
      /no version: \(the action would install the latest engine\)/,
    ],
    [
      "a commit:",
      swap("          verb: call\n", "          verb: call\n          commit: abc\n"),
      /commit: overrides/,
    ],
    [
      "an action tag, not a SHA",
      swap(`@${SHA}`, "@v8.4.1"),
      /does not pin dagger\/dagger-for-github to a 40-hex/,
    ],
    ["a short SHA", swap(`@${SHA}`, `@${SHA.slice(0, 39)}`), /40-hex/],
    [
      "a differently cased owner",
      swap(`dagger/dagger-for-github@${SHA}`, `Dagger/Dagger-For-GitHub@${SHA}`),
      /40-hex/,
    ],
    ["no pin step", swap("id: pin", "id: read"), /no earlier step with id: pin/],
    ["the setup step without an id", swap("        id: pin\n", ""), /no earlier step with id: pin/],
    [
      "an action whose version output is another step's",
      swapSetup(
        "value: ${{ steps.pin.outputs.version }}",
        "value: ${{ steps.other.outputs.version }}",
      ),
      /no earlier step with id: pin/,
    ],
    [
      "a pin step that writes the number",
      swapSetup("$(jq -r '.engineVersion // empty' dagger/dagger.json)", "v0.21.10"),
      /the pin step does not read engineVersion/,
    ],
    [
      "no sha256sum -c",
      swapSetup("sha256sum -c --strict e.sha256", "true"),
      /no step between pin and the action installs a CLI verified/,
    ],
    [
      "no GITHUB_PATH",
      swapSetup('>> "$GITHUB_PATH"', ">> /dev/null"),
      /no step between pin and the action installs a CLI verified/,
    ],
    [
      "a tarball other than dagger_${DAGGER_VERSION}_linux_amd64",
      swapSetup('tarball="dagger_${DAGGER_VERSION}_linux_amd64.tar.gz"', 'tarball="dagger.tar.gz"'),
      /does not fetch the tarball dagger_\$\{DAGGER_VERSION\}_linux_amd64/,
    ],
    [
      "no check of the installed CLI's version",
      swapSetup('          if [ "${got}" != "${DAGGER_VERSION}" ]; then exit 1; fi\n', ""),
      /does not check that the installed CLI reports/,
    ],
    [
      "a checksum fetched at run time",
      swapSetup(
        "awk -v f=\"${tarball}\" '$2 == f'",
        "curl -fsSL https://dl.dagger.io/dagger/releases/0.0.0/checksums.txt | cat",
      ),
      /fetches a checksum at run time/,
    ],
    [
      "install.sh",
      swapSetup(
        "sha256sum -c --strict e.sha256",
        "sha256sum -c --strict e.sha256; curl https://dl.dagger.io/dagger/install.sh | sh",
      ),
      /runs install\.sh/,
    ],
    [
      "an install step with its own version",
      swapSetup(
        "${{ steps.pin.outputs.version }}\n        run: |\n          tarball",
        "v0.0.1\n        run: |\n          tarball",
      ),
      /does not take its version from steps\.pin/,
    ],
    [
      "a checkout that keeps credentials",
      swap("          persist-credentials: false\n", "          fetch-depth: 1\n"),
      /persist-credentials: false/,
    ],
    // #868: the engine image by digest, through the action.
    [
      "the engine image by tag in the action",
      swapSetup(HOST_LINE, HOST_LINE.replace("@${digest}", ":${DAGGER_VERSION}")),
      /dagger-setup\/action\.yml: names registry\.dagger\.io\/engine without a digest/,
    ],
    [
      "a tag-only runner host also fails the run",
      swapSetup(HOST_LINE, HOST_LINE.replace("@${digest}", ":${DAGGER_VERSION}")),
      /no step between pin and the action exports the engine image by the digest/,
    ],
    [
      "no runner-host step",
      swapSetup(HOST_STEP, ""),
      /no step between pin and the action exports the engine image by the digest/,
    ],
    [
      "a runner host not read from engine-digest.txt",
      swapSetup('"$GITHUB_WORKSPACE/dagger/engine-digest.txt"', "digests.txt"),
      /does not read the digest from dagger\/engine-digest\.txt/,
    ],
    [
      "a runner host for no particular version",
      swapSetup('awk -v v="${DAGGER_VERSION}"', 'awk -v v="v0"'),
      /does not select the digest for steps\.pin's version/,
    ],
    [
      "a digest whose shape is not checked",
      swapSetup("          printf '%s\\n' \"${digest}\" | grep -Eqx 'sha256:[0-9a-f]{64}'\n", ""),
      /does not refuse a digest that is not sha256/,
    ],
    [
      "a runner host not exported to GITHUB_ENV",
      swapSetup('>> "$GITHUB_ENV"', ">> /dev/null"),
      /does not run exactly echo "_EXPERIMENTAL_DAGGER_RUNNER_HOST=image:/,
    ],
    [
      "a second runner host after the pinned one",
      swapSetup(
        `          ${HOST_LINE}\n`,
        `          ${HOST_LINE}\n      - run: echo "_EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://x:1" >> "$GITHUB_ENV"\n`,
      ),
      /dagger-setup\/action\.yml: step "3": does not read the digest/,
    ],
    [
      "the runner host named in a comment of the action",
      swapSetup("name: setup", "# _EXPERIMENTAL_DAGGER_RUNNER_HOST\nname: setup"),
      /action\.yml: names _EXPERIMENTAL_DAGGER_RUNNER_HOST outside its digest-pinned export step/,
    ],
    [
      "a job env: overriding the runner host",
      swap(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    env:\n      _EXPERIMENTAL_DAGGER_RUNNER_HOST: tcp://x:1\n",
      ),
      /gate\.yml: names _EXPERIMENTAL_DAGGER_RUNNER_HOST or registry\.dagger\.io\/engine; only the composite action/,
    ],
    [
      "a step env: overriding the runner host",
      swap(
        "          verb: call\n",
        "          verb: call\n        env:\n          _EXPERIMENTAL_DAGGER_RUNNER_HOST: tcp://x:1\n",
      ),
      /gate\.yml: step "Run \(Dagger\)": sets Dagger up inline/,
    ],
    [
      "a workflow inlining the old steps without the action",
      job(`${CHECKOUT}${PIN_STEP}${INSTALL_STEP}${RUN_ACTION}`),
      /other\.yml: step "Read the engine version": sets Dagger up inline; use the composite action/,
    ],
    [
      "a workflow inlining the old steps never gets the runner host",
      job(`${CHECKOUT}${PIN_STEP}${INSTALL_STEP}${RUN_ACTION}`),
      /other\.yml: step "Run \(Dagger\)": no step between pin and the action exports the engine image/,
    ],
    [
      "a workflow inlining every step, runner host included",
      job(`${CHECKOUT}${PIN_STEP}${INSTALL_STEP}${HOST_STEP}${RUN_ACTION}`),
      /other\.yml: step "Pin the engine by digest": sets Dagger up inline/,
    ],
    [
      "a local action with no action.yml",
      { actions: { [SETUP_PATH]: null } },
      /gate\.yml: step "Set up Dagger": uses \.\/\.github\/actions\/dagger-setup, which has no action\.yml/,
    ],
    [
      "a local action that is not composite",
      swapSetup("using: composite", "using: node20"),
      /which is not a composite action/,
    ],
    [
      "a local action outside the repository",
      swap("uses: ./.github/actions/dagger-setup", "uses: ./../elsewhere"),
      /uses \.\/\.\.\/elsewhere, outside the repository/,
    ],
    [
      "a local action that uses itself",
      swapSetup(PIN_STEP, `      - uses: ./.github/actions/dagger-setup\n${PIN_STEP}`),
      /which uses itself/,
    ],
    [
      "a job that runs the CLI with no pin and no verified install",
      job("      - run: |\n          cd x\n          dagger call js-test\n"),
      /other\.yml: step "0": no earlier step with id: pin/,
    ],
    [
      "a job that runs the CLI after a pin but no verified install",
      job(`${PIN_STEP}      - run: ./bin/dagger call js-test\n`),
      /other\.yml: step "1": no step between pin and the action installs a CLI verified/,
    ],
    [
      "a job that installs with install.sh",
      job("      - run: curl -fsSL https://dl.dagger.io/dagger/install.sh | sh\n"),
      /other\.yml: step "0": runs install\.sh/,
    ],
    [
      "a job that installs from Homebrew",
      job("      - run: brew install dagger/tap/dagger\n"),
      /other\.yml: step "0": installs from Homebrew/,
    ],
    [
      "a job that runs the CLI and keeps credentials",
      job(
        `      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n${SETUP_STEP}      - run: dagger call js-test\n`,
      ),
      /other\.yml: a job that runs Dagger checks out with GITHUB_TOKEN kept/,
    ],
  ])("%s", (_name, opts, message) => {
    const v = audit(tree(opts));
    expect(
      v.some((m) => message.test(m)),
      JSON.stringify(v),
    ).toBe(true);
  });

  it("a job that runs the CLI after the setup action passes", () => {
    expect(audit(tree(job(`${SETUP_STEP}      - run: dagger call js-test\n`)))).toEqual([]);
  });

  it("a setup step after the action", () => {
    const moved = GOOD.replace(SETUP_STEP, "") + SETUP_STEP;
    expect(audit(tree({ workflows: { "gate.yml": moved } }))).toContainEqual(
      expect.stringMatching(/no earlier step with id: pin/),
    );
  });

  it("a uses: line the parser does not see as a step", () => {
    // Inside a `run: |` block: a raw `uses:` line, but not a parsed step.
    const hidden = swapSetup(
      '          echo "version=',
      `          uses: dagger/dagger-for-github@${SHA}\n          echo "version=`,
    );
    expect(audit(tree(hidden))).toContainEqual(
      expect.stringMatching(/action\.yml: 0 parsed dagger-for-github steps but 1 raw uses: lines/),
    );
  });

  it("a flow-style step the raw count does not see", () => {
    const flow = GOOD.replace(
      "      - name: Run (Dagger)",
      `      - { uses: "dagger/dagger-for-github@${SHA}", with: { version: "${PIN_EXPR}" } }\n      - name: Run (Dagger)`,
    );
    expect(audit(tree({ workflows: { "gate.yml": flow } }))).toContainEqual(
      expect.stringMatching(/2 parsed dagger-for-github steps but 1 raw uses: lines/),
    );
  });

  it("nothing runs Dagger", () => {
    expect(audit(tree({ workflows: { "other.yml": "on: [push]\njobs: {}\n" } }))).toContainEqual(
      expect.stringMatching(/checking nothing/),
    );
  });

  it.each([
    [
      "dl.dagger.io",
      "      - run: curl -fsSL -o d.tgz https://dl.dagger.io/dagger/releases/x/d.tgz\n",
    ],
    ["a dagger command", "      - run: dagger call js-test\n"],
    ["the runner host", '      - run: echo "_EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://x:1"\n'],
  ])("a workflow found by %s alone, without the action", (_name, steps) => {
    const v = audit(
      tree({
        workflows: {
          "gate.yml": GOOD,
          "only.yml": `on: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
        },
      }),
    );
    expect(v).toContainEqual(expect.stringMatching(/^\.github\/workflows\/only\.yml: /));
  });

  it("a workflow whose only mention is a differently cased action", () => {
    const only = `on: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Dagger/Dagger-For-GitHub@${SHA}\n`;
    expect(audit(tree({ workflows: { "gate.yml": GOOD, "cased.yml": only } }))).toContainEqual(
      expect.stringMatching(/^\.github\/workflows\/cased\.yml: .*40-hex/),
    );
  });

  it("a .yaml workflow is found", () => {
    expect(
      audit(
        tree({
          workflows: { "gate.yaml": GOOD.replace(`version: ${PIN_EXPR}`, "version: latest") },
        }),
      ),
    ).toContainEqual(expect.stringMatching(/^\.github\/workflows\/gate\.yaml: .*version: latest/));
  });

  it("a composite action under .github/actions is found", () => {
    const composite = `runs:\n  using: composite\n  steps:\n    - uses: dagger/dagger-for-github@${SHA}\n      with:\n        version: v0.21.10\n`;
    const v = audit(tree({ actions: { "dagger/action.yml": composite } }));
    expect(v).toContainEqual(
      expect.stringMatching(/^\.github\/actions\/dagger\/action\.yml: .*literal version/),
    );
  });

  it("the engine image by tag in any file under .github", () => {
    const v = audit(tree({ actions: { "notes.md": "registry.dagger.io/engine:v0\n" } }));
    expect(v).toContainEqual(
      expect.stringMatching(/^\.github\/actions\/notes\.md: names registry\.dagger\.io\/engine/),
    );
  });

  it("a candidate that does not parse", () => {
    const v = audit(
      tree({
        workflows: { "gate.yml": GOOD, "bad.yml": "uses: dagger/dagger-for-github\n  : [\n" },
      }),
    );
    expect(v).toContainEqual(expect.stringMatching(/bad\.yml: does not parse as YAML/));
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["without the v", "0.21.10"],
    ["latest", "latest"],
    ["two components", "v0.21"],
    ["a suffix", "v0.21.10-rc1"],
  ])("an engineVersion that is %s", (_name, engineVersion) => {
    expect(audit(tree({ engineVersion }))).toContainEqual(
      expect.stringMatching(/engineVersion .* is missing or not vMAJOR/),
    );
  });

  it("a dagger.json that does not parse", () => {
    expect(audit(tree({ daggerJson: '{ "engineVersion": v0.21.10' }))).toContainEqual(
      expect.stringMatching(/dagger\/dagger\.json: unreadable/),
    );
  });

  it.each([
    ["no file", null],
    ["another version only", `${HASH}  dagger_v0.21.9_linux_amd64.tar.gz\n`],
    ["another platform only", `${HASH}  dagger_v0.21.10_darwin_arm64.tar.gz\n`],
    ["a short hash", `${HASH.slice(1)}  dagger_v0.21.10_linux_amd64.tar.gz\n`],
    [
      "two entries",
      `${HASH}  dagger_v0.21.10_linux_amd64.tar.gz\n${"e".repeat(64)}  dagger_v0.21.10_linux_amd64.tar.gz\n`,
    ],
  ])("cli-checksums.txt with %s", (_name, checksums) => {
    expect(audit(tree({ checksums }))).toContainEqual(
      expect.stringMatching(/cli-checksums\.txt: \d+ entries/),
    );
  });

  it.each([
    ["no file", null, /engine-digest\.txt: missing/],
    [
      "another version",
      `v0.21.9  ${DIGEST}\n`,
      /pins v0\.21\.9, but .* engineVersion is v0\.21\.10/,
    ],
    ["no entry", "# only a comment\n", /engine-digest\.txt: 0 entries/],
    [
      "two entries",
      `v0.21.10  ${DIGEST}\nv0.21.9  ${DIGEST}\n`,
      /engine-digest\.txt: 2 entries, expected exactly 1/,
    ],
    ["a short digest", `v0.21.10  ${DIGEST.slice(0, -1)}\n`, /is not "<vMAJOR/],
    ["upper-case hex", `v0.21.10  sha256:${"A".repeat(64)}\n`, /is not "<vMAJOR/],
    ["no sha256: prefix", `v0.21.10  ${"a".repeat(64)}\n`, /is not "<vMAJOR/],
    ["a tag in place of the digest", "v0.21.10  v0.21.10\n", /is not "<vMAJOR/],
    ["one space", `v0.21.10 ${DIGEST}\n`, /is not "<vMAJOR/],
  ])("engine-digest.txt with %s", (_name, digest, message) => {
    expect(audit(tree({ digest }))).toContainEqual(expect.stringMatching(message));
  });
});
