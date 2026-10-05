// SPDX-License-Identifier: MIT

/**
 * engine-pin (#865): every CI job that runs Dagger pins, derives and verifies.
 * It pins `dagger/dagger-for-github` to a commit SHA, derives the engine version
 * from `dagger/dagger.json` instead of writing it out, and runs only a CLI
 * verified against `dagger/cli-checksums.txt`, the copy committed in this
 * repository, never one the action or `install.sh` fetched unverified.
 *
 * A job "runs Dagger" when a step uses the action or has a shell line whose
 * command is `dagger`; a step "fetches Dagger" when it names dl.dagger.io, the
 * Dagger `install.sh`, the Homebrew tap, or `cli-checksums.txt`. Every fetch
 * must be the verified install, and every run must follow a pin step and a
 * verified install. Workflows are found by CONTENT, not by name: any
 * `.github/workflows/*.y{a,}ml` or `.github/actions/**` file that does either.
 * A step the parser cannot see is caught by the count parity between raw
 * `uses:` lines and parsed steps, and a repository where nothing runs Dagger
 * fails too. This test is the single home of the fact that CI pins, derives and
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
/** A shell line whose command is the dagger CLI, raw (in YAML) or parsed (in a run block). */
const RUNS_DAGGER =
  /^[ \t]*(?:-[ \t]+)?(?:run:[ \t]*)?(?:sudo[ \t]+)?(?:[A-Za-z_]\w*=\S*[ \t]+)*(?:[^\s"'$=]*\/)?dagger(?:[ \t]|$)/m;
/** Any way to fetch a Dagger CLI. */
const FETCHES_DAGGER = /dl\.dagger\.io|dagger\/install\.sh|dagger\/tap|cli-checksums\.txt/i;
const PIN_EXPR = "${{ steps.pin.outputs.version }}";
const TARBALL = "dagger_${DAGGER_VERSION}_linux_amd64";
const SEMVER = /^v\d+\.\d+\.\d+$/;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (v) =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
const isStep = (s) => s !== null && typeof s === "object" && !Array.isArray(s);
const usesAction = (s) => isStep(s) && typeof s.uses === "string" && ACTION.test(s.uses.trim());
const fetchesDagger = (s) => isStep(s) && FETCHES_DAGGER.test(text(s.run));

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** Every workflow or action file that runs or fetches Dagger, in any case. */
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
      RUNS_DAGGER.test(raw)
    );
  });
}

/** Every parsed list holding a step that runs or fetches Dagger: a job's (or a composite's) steps. */
function daggerJobs(node, out = []) {
  if (Array.isArray(node)) {
    if (node.some((s) => usesAction(s) || fetchesDagger(s) || RUNS_DAGGER.test(text(s?.run)))) {
      out.push(node);
    }
    for (const el of node) daggerJobs(el, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) daggerJobs(v, out);
  }
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

/** One job's steps: every fetch is the verified install; every run follows pin + install. */
function checkJob(rel, steps, violations) {
  const named = (s, i) => `${rel}: step "${s.name ?? i}"`;
  const installs = steps.filter(fetchesDagger);
  for (const s of installs) {
    for (const p of installProblems(s)) violations.push(`${named(s, steps.indexOf(s))}: ${p}`);
  }
  const verified = (s) => installs.includes(s) && installProblems(s).length === 0;

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
  if (ev) checkChecksums(root, ev, violations);

  let total = 0;
  for (const file of candidates(root)) {
    const rel = relative(root, file);
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
    for (const steps of jobs) total += checkJob(rel, steps, violations);
  }
  if (total < 1) violations.push("nothing runs Dagger: the check would be checking nothing");
  return violations;
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
const GOOD = `name: gate
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          persist-credentials: false
${PIN_STEP}${INSTALL_STEP}      - name: Run (Dagger)
        uses: dagger/dagger-for-github@${SHA} # v8.4.1
        with:
          version: \${{ steps.pin.outputs.version }}
          verb: call
      - name: Run the CLI directly
        run: dagger call js-test --source=.
`;

let fixtures = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f, { recursive: true, force: true });
  fixtures = [];
});

function tree(opts = {}) {
  const {
    workflows = { "gate.yml": GOOD },
    actions = {},
    checksums = `${HASH}  dagger_v0.21.10_linux_amd64.tar.gz\n`,
  } = opts;
  // An explicit `engineVersion: undefined` means "no key", not the default.
  const engineVersion = Object.hasOwn(opts, "engineVersion") ? opts.engineVersion : "v0.21.10";
  const root = mkdtempSync(join(tmpdir(), "engine-pin-"));
  fixtures.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "dagger"));
  for (const [n, body] of Object.entries(workflows))
    writeFileSync(join(root, ".github", "workflows", n), body);
  for (const [n, body] of Object.entries(actions)) {
    mkdirSync(dirname(join(root, ".github", "actions", n)), { recursive: true });
    writeFileSync(join(root, ".github", "actions", n), body);
  }
  const json = engineVersion === undefined ? {} : { engineVersion };
  writeFileSync(
    join(root, "dagger", "dagger.json"),
    opts.daggerJson ?? JSON.stringify({ name: "x", ...json }),
  );
  if (checksums !== null) writeFileSync(join(root, "dagger", "cli-checksums.txt"), checksums);
  return root;
}

const swap = (from, to) => {
  if (!GOOD.includes(from)) throw new Error(`fixture mutation does not apply: ${from}`);
  return { workflows: { "gate.yml": GOOD.replace(from, to) } };
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
    [
      "a pin step that writes the number",
      swap("$(jq -r '.engineVersion // empty' dagger/dagger.json)", "v0.21.10"),
      /the pin step does not read engineVersion/,
    ],
    [
      "no sha256sum -c",
      swap("sha256sum -c --strict e.sha256", "true"),
      /no step between pin and the action installs a CLI verified/,
    ],
    [
      "no GITHUB_PATH",
      swap('>> "$GITHUB_PATH"', ">> /dev/null"),
      /no step between pin and the action installs a CLI verified/,
    ],
    [
      "a tarball other than dagger_${DAGGER_VERSION}_linux_amd64",
      swap('tarball="dagger_${DAGGER_VERSION}_linux_amd64.tar.gz"', 'tarball="dagger.tar.gz"'),
      /does not fetch the tarball dagger_\$\{DAGGER_VERSION\}_linux_amd64/,
    ],
    [
      "no check of the installed CLI's version",
      swap('          if [ "${got}" != "${DAGGER_VERSION}" ]; then exit 1; fi\n', ""),
      /does not check that the installed CLI reports/,
    ],
    [
      "a checksum fetched at run time",
      swap(
        "awk -v f=\"${tarball}\" '$2 == f'",
        "curl -fsSL https://dl.dagger.io/dagger/releases/0.0.0/checksums.txt | cat",
      ),
      /fetches a checksum at run time/,
    ],
    [
      "install.sh",
      swap(
        "sha256sum -c --strict e.sha256",
        "sha256sum -c --strict e.sha256; curl https://dl.dagger.io/dagger/install.sh | sh",
      ),
      /runs install\.sh/,
    ],
    [
      "an install step with its own version",
      swap("${{ steps.pin.outputs.version }}\n        run:", "v0.0.1\n        run:"),
      /does not take its version from steps\.pin/,
    ],
    [
      "a checkout that keeps credentials",
      swap("          persist-credentials: false\n", "          fetch-depth: 1\n"),
      /persist-credentials: false/,
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
        `      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n${PIN_STEP}${INSTALL_STEP}      - run: dagger call js-test\n`,
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

  it("a job that runs the CLI after its own pin and verified install passes", () => {
    expect(
      audit(tree(job(`${PIN_STEP}${INSTALL_STEP}      - run: dagger call js-test\n`))),
    ).toEqual([]);
  });

  it("a pin step after the action", () => {
    const moved = GOOD.replace(PIN_STEP, "") + PIN_STEP;
    expect(audit(tree({ workflows: { "gate.yml": moved } }))).toContainEqual(
      expect.stringMatching(/no earlier step with id: pin/),
    );
  });

  it("a uses: line the parser does not see as a step", () => {
    // Inside a `run: |` block: a raw `uses:` line, but not a parsed step.
    const hidden = GOOD.replace(
      '          echo "version=',
      `          uses: dagger/dagger-for-github@${SHA}\n          echo "version=`,
    );
    const v = audit(tree({ workflows: { "gate.yml": hidden } }));
    expect(v).toContainEqual(
      expect.stringMatching(/1 parsed dagger-for-github steps but 2 raw uses: lines/),
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
});
