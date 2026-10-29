// SPDX-License-Identifier: MIT

// The SDK selector (select-sdks.mjs). Three halves:
// - the selection over the REAL manifest and the REAL workspace dependencies:
//   pushes judge everything, a pull request judges what it touches plus its
//   dependents, and every path outside one SDK's directory judges everything;
// - the routing of a selection into the job kinds, over fixture manifests,
//   with the known-red waiver read from the base commit only;
// - the CLI against a throwaway git repository: renames, deletions, git
//   errors, empty diffs and hostile file names.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  GATE_PREFIXES,
  KINDS,
  LIVE_WRAPPER,
  MANIFEST,
  NAME,
  OUTPUT_KEYS,
  legProblem,
  SelectError,
  classifyPath,
  gateFiles,
  manifestProblems,
  routeSelection,
  selectNames,
  shellOperatorsOutsideQuotes,
  workspaceDependents,
} from "./select-sdks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/repo-gates/select-sdks.mjs");
const REAL = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const NAMES = REAL.sdks.map((s) => s.name);
const DEPENDENTS = workspaceDependents(ROOT, NAMES);
const pr = (changed) =>
  selectNames({ event: "pull_request", names: NAMES, changed, dependents: DEPENDENTS });

describe("the selection over the real manifest", () => {
  it.each(["push", "schedule"])("a %s selects every SDK, in manifest order", (event) => {
    expect(selectNames({ event, names: NAMES, changed: null, dependents: DEPENDENTS })).toEqual({
      names: NAMES,
      reason: "all",
    });
  });

  it("a push ignores whatever diff it is handed", () =>
    expect(
      selectNames({
        event: "push",
        names: NAMES,
        changed: ["apps/cli/x"],
        dependents: DEPENDENTS,
      }).names,
    ).toEqual(NAMES));

  it("a change to one native SDK selects that SDK alone", () =>
    expect(pr(["apps/sdk-rust/src/lib.rs"]).names).toEqual(["rust"]));

  it("browser-js selects react, angular and cloudflare-worker, read from their package.json", () =>
    expect(new Set(pr(["apps/sdk-browser-js/src/index.ts"]).names)).toEqual(
      new Set(["browser-js", "angular", "react", "cloudflare-worker"]),
    ));

  it("the closure is transitive and keeps manifest order", () => {
    const names = ["a", "b", "c", "d"];
    const dependents = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
    ]);
    expect(
      selectNames({ event: "pull_request", names, changed: ["apps/sdk-a/x"], dependents }).names,
    ).toEqual(["a", "b", "c"]);
  });

  it("apps/cli selects none", () => {
    expect(pr(["apps/cli/src/main.ts", "apps/cli/deno.json"])).toEqual({
      names: [],
      reason: "none",
    });
  });

  it("an unknown apps/sdk-foo/ selects every SDK", () =>
    expect(pr(["apps/sdk-foo/x.ts"]).names).toEqual(NAMES));

  it("a delete-only change selects the SDK it deletes from", () =>
    // `--no-renames --name-only` names a deleted file like any other.
    expect(pr(["apps/sdk-go/client.go"]).names).toEqual(["go"]));

  it("a rename out of rust into apps/cli selects rust (both sides are listed)", () =>
    expect(pr(["apps/cli/lib.rs", "apps/sdk-rust/src/lib.rs"]).names).toEqual(["rust"]));

  it("a rename between two SDKs selects both", () =>
    expect(pr(["apps/sdk-go/x.go", "apps/sdk-rust/x.go"]).names).toEqual(["go", "rust"]));

  // The plan's "Decided without asking": any change to a shared input selects
  // the manifest's full set, which replaces #910's grep-derived consumer list.
  it.each([
    ["sdk-shared", "packages/sdk-shared/src/index.ts"],
    ["a fixture", "packages/test-fixtures-sdk-parity/fixtures/wire-cases.json"],
    ["the contract", "packages/contract/openapi.yaml"],
    ["the harness", "tools/test-harness-live-contract/src/cli.ts"],
    ["dagger/", "dagger/src/index.ts"],
    ["the manifest", "dagger/sdk-manifest.json"],
    ["a workflow", ".github/workflows/sdk-gates.yml"],
    ["the selector itself", "tools/repo-gates/select-sdks.mjs"],
    ["a root file", "package.json"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["apps/ itself", "apps/README.md"],
    ["a path that only looks like an SDK", "apps/sdk-node"],
    ["a sibling of apps/cli", "apps/cli-x/y"],
  ])("%s selects exactly the manifest's full set", (_name, path) => {
    const got = pr(["apps/sdk-node/x.ts", path]);
    expect(got.reason).toBe("all");
    expect(got.names).toEqual(NAMES);
  });

  it("classifies by manifest name, never by a directory listing", () => {
    const names = new Set(NAMES);
    expect(classifyPath("apps/sdk-kotlin-mp/build.gradle.kts", names)).toBe("kotlin-mp");
    expect(classifyPath("apps/cli/x", names)).toBe(null);
    expect(classifyPath("apps/sdk-Node/x", names)).toBe("all");
  });

  it("an empty pull-request diff is an error, never an empty selection", () => {
    expect(() => pr([])).toThrow(SelectError);
    expect(() => pr(null)).toThrow(SelectError);
  });

  it("an event it does not know is an error", () =>
    expect(() =>
      selectNames({
        event: "workflow_dispatch",
        names: NAMES,
        changed: null,
        dependents: DEPENDENTS,
      }),
    ).toThrow(/event/));
});

describe("the workspace dependents", () => {
  it("are read from each SDK's package.json workspace: ranges", () => {
    expect([...(DEPENDENTS.get("browser-js") ?? [])].sort((a, b) => a.localeCompare(b))).toEqual([
      "angular",
      "cloudflare-worker",
      "react",
    ]);
  });

  it("a package.json that does not parse is an error", () => {
    const root = mkdtempSync(join(tmpdir(), "select-sdks-deps-"));
    try {
      mkdirSync(join(root, "apps/sdk-a"), { recursive: true });
      writeFileSync(join(root, "apps/sdk-a/package.json"), "{");
      expect(() => workspaceDependents(root, ["a"])).toThrow(SelectError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A fixture manifest: one SDK per routing case. */
const fixture = () => ({
  sdks: [
    { name: "a", daggerFn: "a-test" },
    { name: "b", daggerFn: "b-test" },
    {
      name: "live",
      daggerFn: "live-test",
      liveSuite: { runner: `${LIVE_WRAPPER}node run`, toolchain: "js" },
    },
    { name: "mac", daggerFn: null, ci: { native: "macos" } },
    { name: "ue", daggerFn: null, ci: { native: "smoke" } },
    {
      name: "maclive",
      daggerFn: null,
      ci: { native: "macos" },
      liveSuite: { runner: `${LIVE_WRAPPER}node run` },
    },
  ],
});
const route = (names, { event = "push", manifest = fixture(), base = manifest } = {}) =>
  routeSelection({ event, names, manifest, baseManifest: base });

describe("the routing into job kinds", () => {
  it("each SDK lands in exactly one kind", () => {
    expect(route(["a", "b", "mac", "ue"])).toEqual({
      gate: [
        { name: "a", daggerFn: "a-test", live: false },
        { name: "b", daggerFn: "b-test", live: false },
      ],
      known_red: [],
      swift: [{ name: "mac", live: false }],
      smoke: ["ue"],
    });
  });

  // #924: the macOS job runs a swift SDK's liveSuite.runner natively, after
  // its suite, so its leg says whether it has one exactly as a Dagger leg does.
  // MUTATION: route a macos SDK as a bare name again and the job's live step
  // has nothing to read.
  it("a macOS leg carries live: true exactly when its SDK has a liveSuite.runner", () => {
    expect(route(["mac", "maclive"]).swift).toEqual([
      { name: "mac", live: false },
      { name: "maclive", live: true },
    ]);
  });

  // #918: an SDK with a liveSuite.runner runs `live-suite --sdk <name>` as a
  // second Dagger step of its leg; the leg says so, always as a boolean.
  it("a leg carries live: true exactly when its SDK has a liveSuite.runner", () => {
    expect(route(["a", "live"]).gate).toEqual([
      { name: "a", daggerFn: "a-test", live: false },
      { name: "live", daggerFn: "live-test", live: true },
    ]);
    const base = fixture();
    base.sdks[2].ci = { knownRed: "#1" };
    expect(route(["live"], { event: "pull_request", base }).known_red).toEqual([
      { name: "live", daggerFn: "live-test", live: true, ticket: "#1" },
    ]);
  });

  it("a base knownRed moves the SDK to known_red, with its ticket", () => {
    const base = fixture();
    base.sdks[1].ci = { knownRed: "#806" };
    const got = route(["a", "b"], { event: "pull_request", base });
    expect(got.gate).toEqual([{ name: "a", daggerFn: "a-test", live: false }]);
    expect(got.known_red).toEqual([{ name: "b", daggerFn: "b-test", live: false, ticket: "#806" }]);
  });

  it("a knownRed the pull request adds itself is ignored", () => {
    const head = fixture();
    head.sdks[1].ci = { knownRed: "#806" };
    const got = route(["b"], { event: "pull_request", manifest: head, base: fixture() });
    expect(got.gate).toEqual([{ name: "b", daggerFn: "b-test", live: false }]);
    expect(got.known_red).toEqual([]);
  });

  it("on a push the waiver is the judged commit's own", () => {
    const head = fixture();
    head.sdks[1].ci = { knownRed: "#806" };
    expect(route(["b"], { manifest: head, base: fixture() }).known_red).toEqual([
      { name: "b", daggerFn: "b-test", live: false, ticket: "#806" },
    ]);
  });

  it("a malformed base waiver is no waiver", () => {
    const base = fixture();
    base.sdks[1].ci = { knownRed: "soon" };
    expect(route(["b"], { event: "pull_request", base }).known_red).toEqual([]);
  });

  it("a daggerFn that is not one function name is an error", () => {
    const m = fixture();
    m.sdks[0].daggerFn = "a-test --x; id";
    expect(() => route(["a"], { manifest: m })).toThrow(SelectError);
  });

  it("the kinds are the outputs the workflow's matrices read", () => {
    expect(KINDS.map((k) => k.output)).toEqual(["gate", "known_red", "swift", "smoke"]);
    for (const k of KINDS) expect(OUTPUT_KEYS).toContain(k.output);
  });
});

describe("the manifest's CI shape", () => {
  // #924: the macOS job runs it natively (MUTATION: refuse every liveSuite
  // without a daggerFn again, the T11 deviation, and this goes red).
  it("accepts a liveSuite on a macOS SDK, whose job runs it", () =>
    expect(manifestProblems(fixture())).toEqual([]));
  it("the real manifest has none of these problems", () =>
    expect(manifestProblems(REAL)).toEqual([]));

  const withEntry = (entry) => ({ sdks: [{ name: "a", daggerFn: "a-test" }, entry] });
  it.each([
    ["neither daggerFn nor ci.native", { name: "x", daggerFn: null }, /exactly one of daggerFn/],
    [
      "both daggerFn and ci.native",
      { name: "x", daggerFn: "x-test", ci: { native: "macos" } },
      /exactly one of daggerFn/,
    ],
    ["an unknown ci.native", { name: "x", daggerFn: null, ci: { native: "linux" } }, /ci\.native/],
    [
      "a knownRed without a ticket",
      { name: "x", daggerFn: "x-test", ci: { knownRed: "yes" } },
      /ci\.knownRed/,
    ],
    [
      "a knownRed on a native SDK",
      { name: "x", daggerFn: null, ci: { native: "macos", knownRed: "#1" } },
      /only a daggerFn SDK/,
    ],
    [
      // T10 removed the transitional key: an SDK never again sits in the
      // matrix with no leg (MUTATION: put "pending" back in CI_KEYS).
      "a ci.pending, retired with the last family of #793",
      { name: "x", daggerFn: "x-test", ci: { pending: "#917" } },
      /ci\.pending is not one of ci\.native, ci\.knownRed/,
    ],
    [
      "an unknown ci key",
      { name: "x", daggerFn: "x-test", ci: { runner: "dagger" } },
      /ci\.runner/,
    ],
    [
      "a ci that is not an object",
      { name: "x", daggerFn: "x-test", ci: "macos" },
      /ci is not an object/,
    ],
    [
      "a liveSuite with no runner",
      { name: "x", daggerFn: "x-test", liveSuite: { path: "t.py" } },
      /liveSuite\.runner/,
    ],
    [
      "a liveSuite whose runner is empty",
      { name: "x", daggerFn: "x-test", liveSuite: { runner: " " } },
      /liveSuite\.runner/,
    ],
    [
      // #793 review: the wrapper rule ran only in the harness's own tests,
      // which no CI job ran. MUTATION: drop it and these two pass.
      "a liveSuite whose runner skips the harness wrapper",
      { name: "x", daggerFn: "x-test", liveSuite: { runner: "vp test run t.live.test.ts" } },
      /harness wrapper/,
    ],
    [
      "a liveSuite whose runner is the wrapper alone",
      { name: "x", daggerFn: "x-test", liveSuite: { runner: LIVE_WRAPPER } },
      /harness wrapper/,
    ],
    [
      // The smoke job runs no live suite (#924: only the Dagger legs and the
      // macOS job do), so a liveSuite there would never run.
      "a liveSuite on a smoke SDK",
      {
        name: "x",
        daggerFn: null,
        ci: { native: "smoke" },
        liveSuite: { runner: `${LIVE_WRAPPER}r` },
      },
      /no leg runs it/,
    ],
    [
      "both a liveSuite and a liveExempt",
      {
        name: "x",
        daggerFn: "x-test",
        liveSuite: { runner: `${LIVE_WRAPPER}r` },
        liveExempt: "why",
      },
      /both a liveSuite and a liveExempt/,
    ],
    [
      "a liveExempt that is not a reason",
      { name: "x", daggerFn: "x-test", liveExempt: "" },
      /liveExempt/,
    ],
    // M8: a Dagger live suite names the live toolchain recipe that builds its
    // container (liveSuite.toolchain), never defaulted; a native SDK runs on
    // its own job's toolchain, so it never names one.
    [
      "a Dagger live suite with no toolchain",
      { name: "x", daggerFn: "x-test", liveSuite: { runner: `${LIVE_WRAPPER}r` } },
      /has a liveSuite and a daggerFn but no liveSuite\.toolchain/,
    ],
    [
      "a toolchain on a macOS SDK",
      {
        name: "x",
        daggerFn: null,
        ci: { native: "macos" },
        liveSuite: { runner: `${LIVE_WRAPPER}r`, toolchain: "swift" },
      },
      /liveSuite\.toolchain on an SDK with no Dagger leg/,
    ],
    ...[
      ["a toolchain id with a space", "a b"],
      ["a toolchain id that is not a string", 42],
      ["an empty toolchain id", ""],
    ].map(([name, id]) => [
      name,
      { name: "x", daggerFn: "x-test", liveSuite: { runner: `${LIVE_WRAPPER}r`, toolchain: id } },
      /liveSuite\.toolchain .* is not a toolchain id/,
    ]),
    [
      // NAME-shaped, so only the Object.prototype check refuses it: a lookup
      // of it in a plain object would find Object itself, not a recipe.
      "the toolchain id constructor, an Object.prototype key",
      {
        name: "x",
        daggerFn: "x-test",
        liveSuite: { runner: `${LIVE_WRAPPER}r`, toolchain: "constructor" },
      },
      /liveSuite\.toolchain "constructor" is a key every object has/,
    ],
    ["a name with a capital", { name: "X", daggerFn: "x-test" }, /name/],
    ["a name with a space", { name: "a b", daggerFn: "x-test" }, /name/],
    ["a duplicate name", { name: "a", daggerFn: "a-test" }, /twice/],
  ])("refuses %s", (_name, entry, re) => {
    expect(manifestProblems(withEntry(entry)).map((p) => p.why)).toContainEqual(
      expect.stringMatching(re),
    );
  });
  it("M8: refuses every Object.prototype key as a toolchain id", () => {
    for (const id of Object.getOwnPropertyNames(Object.prototype)) {
      const live = { runner: `${LIVE_WRAPPER}r`, toolchain: id };
      expect(
        manifestProblems(withEntry({ name: "x", daggerFn: "x-test", liveSuite: live })).map(
          (p) => p.why,
        ),
        id,
      ).toContainEqual(expect.stringMatching(/liveSuite\.toolchain/));
    }
  });
  // M8 on the real manifest: every Linux live SDK names its toolchain, and
  // deleting any one of them is refused for that SDK. An empty set would run
  // no row at all, so it is asserted first.
  const LINUX_LIVE = REAL.sdks.filter((s) => s.daggerFn && s.liveSuite !== undefined);
  it("the real manifest has Linux live SDKs for the next rows to judge", () =>
    expect(LINUX_LIVE.length).toBeGreaterThan(0));
  it.each(LINUX_LIVE.map((s) => s.name))(
    "refuses the real manifest with %s's liveSuite.toolchain deleted",
    (name) => {
      const m = structuredClone(REAL);
      delete m.sdks.find((s) => s.name === name).liveSuite.toolchain;
      expect(manifestProblems(m)).toContainEqual({
        sdk: name,
        why: expect.stringMatching(/no liveSuite\.toolchain/),
      });
    },
  );
  it("refuses a manifest with no sdks[]", () =>
    expect(manifestProblems({}).map((p) => p.why)).toContainEqual(
      expect.stringMatching(/no sdks/),
    ));
});

// #926 A4: a runner is run as one `bash -c "<runner>"` (run-live-suite.mjs's
// runnerArgv, on both paths), so a shell operator after the wrapped
// command runs OUTSIDE the wrapper: `<wrapper> -- cmd || true` is green
// whatever the wrapper says. Only the runner's own unquoted text is refused;
// a `bash -c '… && …'` argument is the wrapped command, and stays legal.
describe("a liveSuite.runner carries no shell operator outside the wrapped command (#926 A4)", () => {
  const runner = (tail) => ({
    sdks: [
      {
        name: "x",
        daggerFn: "x-test",
        liveSuite: { runner: `${LIVE_WRAPPER}${tail}`, toolchain: "x" },
      },
    ],
  });
  const whys = (tail) => manifestProblems(runner(tail)).map((p) => p.why);

  // MUTATION: drop the operator check from manifestProblems and every one of
  // these is accepted again, `|| true` first.
  it.each([
    ["|| true", "cmd || true"],
    ["; true", "cmd; true"],
    ["& (background)", "cmd & true"],
    ["| (pipe)", "cmd | tee log"],
    ["&& true", "cmd && true"],
    ["> (redirect)", "cmd > /dev/null"],
    ["< (redirect)", "cmd < /dev/null"],
    ["( (subshell)", "(cmd)"],
    ["a newline", "cmd\ntrue"],
    ["$( substitution", "cmd $(true)"],
    ["a backtick substitution", "cmd `true`"],
    ["$( inside double quotes", 'cmd "$(true)"'],
    ["|| true after a quoted argument", "bash -c 'a && b' || true"],
  ])("refuses %s", (_label, tail) => {
    expect(whys(tail)).toContainEqual(expect.stringMatching(/shell (operator|substitution)/));
  });

  it("refuses an unterminated quote: what bash would read cannot be judged", () => {
    expect(whys("bash -c 'cmd")).toContainEqual(expect.stringMatching(/unterminated/));
    expect(whys('bash -c "cmd')).toContainEqual(expect.stringMatching(/unterminated/));
  });

  it.each([
    [
      "a bash -c argument with && and || inside its single quotes",
      "bash -c 'cd a && t || exit 1; done'",
    ],
    ["operators inside double quotes", 'node -e "a|b;c&d>e"'],
    ["escaped operators", "echo \\|\\;\\&"],
    ["a plain command", "pnpm --filter @confeature/sdk-node exec vp test run t.live.test.ts"],
    ["a variable", "cmd $HOME"],
  ])("accepts %s", (_label, tail) => {
    expect(whys(tail)).toEqual([]);
  });

  it("names the operators it found, outside quotes only", () => {
    expect(shellOperatorsOutsideQuotes("bash -c 'a || b' || true; x")).toEqual({
      operators: ["||", ";"],
      unterminated: false,
    });
    expect(shellOperatorsOutsideQuotes("a 'b")).toEqual({ operators: [], unterminated: true });
  });

  it("every real runner passes", () => {
    for (const s of REAL.sdks.filter((x) => x.liveSuite !== undefined))
      expect(
        shellOperatorsOutsideQuotes(s.liveSuite.runner.slice(LIVE_WRAPPER.length)),
        s.name,
      ).toEqual({ operators: [], unterminated: false });
  });
});

describe("the gate files a pull request changes", () => {
  it("lists workflow, repo-gates and dagger paths, and nothing else", () =>
    expect(
      gateFiles([
        ".github/workflows/sdk-gates.yml",
        "tools/repo-gates/conclude-sdk-gates.mjs",
        "dagger/sdk-manifest.json",
        "apps/sdk-node/x.ts",
        ".github/CODEOWNERS",
      ]),
    ).toEqual({
      files: [
        ".github/workflows/sdk-gates.yml",
        "tools/repo-gates/conclude-sdk-gates.mjs",
        "dagger/sdk-manifest.json",
        ".github/CODEOWNERS",
      ],
      unnamed: 0,
    }));
  // #793 review: the list missed scripts the workflow runs, so an edit to one
  // read "Gate files changed: none". MUTATION: drop a prefix and this fails.
  it("covers every script sdk-gates.yml runs", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/sdk-gates.yml"), "utf8");
    const run = [...wf.matchAll(/\b(?:node|bash|sh)\s+((?:tools|scripts|apps)\/[\w./-]+)/g)];
    expect(run.length).toBeGreaterThan(0);
    for (const [, path] of run)
      expect(
        GATE_PREFIXES.some((g) => path.startsWith(g)),
        path,
      ).toBe(true);
  });
  it("counts a gate file whose name is not plain, and never prints it", () => {
    const got = gateFiles([
      "dagger/a\nb",
      "dagger/$(id)",
      "dagger/`x`",
      "dagger/-x",
      "dagger/ok.ts",
    ]);
    expect(got).toEqual({ files: ["dagger/ok.ts"], unnamed: 4 });
  });
});

// ---------------------------------------------------------------------------
// The CLI, against a throwaway repository.

const SPAWNS = { timeout: 60_000 };
const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];
const cleanEnv = (extra = {}) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: "6215184+someone@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: "6215184+someone@users.noreply.github.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
  for (const k of [...GIT_LOCATION_ENV, "GITHUB_OUTPUT", "EVENT_NAME", "BASE_SHA", "HEAD_SHA"])
    if (!Object.hasOwn(extra, k)) delete env[k];
  return env;
};
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repository with three SDKs (b depends on a) and a CLI, committed as the base. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "select-sdks-"));
  dirs.push(root);
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const manifest = (edit = (m) => m) =>
    write(
      MANIFEST,
      JSON.stringify(
        edit({
          sdks: [
            { name: "a", daggerFn: "a-test" },
            { name: "b", daggerFn: "b-test" },
            { name: "rust", daggerFn: "rust-test" },
          ],
        }),
      ),
    );
  git("init", "-q", "-b", "main");
  manifest();
  write("apps/sdk-a/package.json", JSON.stringify({ name: "@x/sdk-a" }));
  write(
    "apps/sdk-b/package.json",
    JSON.stringify({ name: "@x/sdk-b", dependencies: { "@x/sdk-a": "workspace:*" } }),
  );
  write("apps/sdk-rust/src/lib.rs", "fn main() {}\n");
  write("apps/cli/main.ts", "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const commit = (msg = "change") => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { root, git, write, manifest, base, commit };
}

/** Run the CLI in `root`; returns its exit status, stderr and the outputs it wrote. */
function select(root, env) {
  const out = join(root, "..", `${root.split("/").pop()}.out`);
  dirs.push(out);
  writeFileSync(out, "");
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({ GITHUB_OUTPUT: out, ...env }),
  });
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    status: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    outputs,
    raw: readFileSync(out, "utf8"),
  };
}
const prEnv = (base, head) => ({ EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head });
const names = (outputs, key) =>
  JSON.parse(outputs[key]).map((x) => (typeof x === "string" ? x : x.name));

describe("the CLI", SPAWNS, () => {
  it("a push writes one line per output, every SDK in gate", () => {
    const { root } = repo();
    const got = select(root, { EVENT_NAME: "push" });
    expect(got.status, got.stderr).toBe(0);
    expect(Object.keys(got.outputs)).toEqual(OUTPUT_KEYS);
    expect(names(got.outputs, "gate")).toEqual(["a", "b", "rust"]);
    expect(JSON.parse(got.outputs.gate_files)).toEqual({ files: [], unnamed: 0 });
  });

  it("with no GITHUB_OUTPUT it prints the same lines on stdout", () => {
    const { root } = repo();
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv({ EVENT_NAME: "schedule" }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^gate=\[\{"name":"a","daggerFn":"a-test","live":false\}/m);
  });

  it("a pull request touching a selects a and its dependent b", () => {
    const { root, write, base, commit } = repo();
    write("apps/sdk-a/src.ts", "y\n");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    expect(names(got.outputs, "gate")).toEqual(["a", "b"]);
  });

  it("a pull request touching only apps/cli selects none", () => {
    const { root, write, base, commit } = repo();
    write("apps/cli/main.ts", "z\n");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    for (const k of ["gate", "known_red", "swift", "smoke"])
      expect(JSON.parse(got.outputs[k])).toEqual([]);
    expect(got.outputs.summary).toMatch(/no SDK selected/);
  });

  it("a rename out of rust into apps/cli selects rust", () => {
    const { root, git, base, commit } = repo();
    git("mv", "apps/sdk-rust/src/lib.rs", "apps/cli/lib.rs");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    expect(names(got.outputs, "gate")).toEqual(["rust"]);
  });

  it("a rename between two SDKs selects both", () => {
    const { root, git, base, commit } = repo();
    git("mv", "apps/sdk-rust/src/lib.rs", "apps/sdk-a/lib.rs");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    expect(names(got.outputs, "gate")).toEqual(["a", "b", "rust"]);
  });

  it("a delete-only change selects the SDK it deletes from", () => {
    const { root, git, base, commit } = repo();
    git("rm", "-q", "apps/sdk-rust/src/lib.rs");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    expect(names(got.outputs, "gate")).toEqual(["rust"]);
  });

  it("an empty pull-request diff is red, and writes nothing", () => {
    const { root, base, commit } = repo();
    const got = select(root, prEnv(base, commit("empty")));
    expect(got.status).not.toBe(0);
    expect(got.stderr).toMatch(/empty/);
    expect(got.raw).toBe("");
  });

  it("a git error is red, and writes nothing", () => {
    const { root, base } = repo();
    const got = select(root, prEnv(base, "f".repeat(40)));
    expect(got.status).not.toBe(0);
    expect(got.stderr).toMatch(/git/);
    expect(got.raw).toBe("");
  });

  it.each([
    ["a SHA that is an option", "--output=/tmp/x"],
    ["no SHA", ""],
  ])("%s is refused before git runs", (_name, sha) => {
    const { root, base } = repo();
    const got = select(root, prEnv(base, sha));
    expect(got.status).not.toBe(0);
    expect(got.stderr).toMatch(/HEAD_SHA/);
  });
  // #793 review: the same refusal on the other end of the range.
  it.each([
    ["a BASE_SHA that is an option", "--output=/tmp/x"],
    ["no BASE_SHA", ""],
  ])("%s is refused before git runs", (_name, sha) => {
    const { root, base } = repo();
    const got = select(root, prEnv(sha, base));
    expect(got.status).not.toBe(0);
    expect(got.stderr).toMatch(/BASE_SHA/);
  });

  it("an event it does not know is red", () => {
    const { root } = repo();
    expect(select(root, { EVENT_NAME: "workflow_dispatch" }).status).not.toBe(0);
  });

  it("a manifest that does not parse is red", () => {
    const { root, write } = repo();
    write(MANIFEST, "{");
    const got = select(root, { EVENT_NAME: "push" });
    expect(got.status).not.toBe(0);
    expect(got.raw).toBe("");
  });

  it("a manifest entry with neither daggerFn nor ci.native is red", () => {
    const { root, manifest } = repo();
    manifest((m) => ({ sdks: [...m.sdks, { name: "z", daggerFn: null }] }));
    const got = select(root, { EVENT_NAME: "push" });
    expect(got.status).not.toBe(0);
    expect(got.stderr).toMatch(/exactly one of daggerFn/);
  });

  it("a knownRed the pull request adds is ignored; the base's is honoured", () => {
    const { root, manifest, write, base, commit } = repo();
    manifest((m) => {
      m.sdks[2].ci = { knownRed: "#806" };
      return m;
    });
    write("apps/sdk-rust/src/lib.rs", "fn main() { 1; }\n");
    const head = commit("waive rust");
    const self = select(root, prEnv(base, head));
    expect(self.status, self.stderr).toBe(0);
    expect(names(self.outputs, "gate")).toEqual(["a", "b", "rust"]);
    expect(JSON.parse(self.outputs.known_red)).toEqual([]);
    // The waiver is now on the base: a later pull request is judged by it.
    write("apps/sdk-rust/src/lib.rs", "fn main() { 2; }\n");
    const later = select(root, prEnv(head, commit("touch rust")));
    expect(later.status, later.stderr).toBe(0);
    expect(JSON.parse(later.outputs.gate)).toEqual([]);
    expect(JSON.parse(later.outputs.known_red)).toEqual([
      { name: "rust", daggerFn: "rust-test", live: false, ticket: "#806" },
    ]);
  });

  it("lists the gate files a pull request changes", () => {
    const { root, write, base, commit } = repo();
    write("apps/sdk-a/x.ts", "1\n");
    write(".github/workflows/sdk-gates.yml", "on: push\n");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    expect(JSON.parse(got.outputs.gate_files)).toEqual({
      files: [".github/workflows/sdk-gates.yml"],
      unnamed: 0,
    });
  });

  it.each([
    ["a newline", "apps/sdk-a/x\n::set-output name=gate::[]"],
    ["a command substitution", "apps/sdk-a/$(touch pwned)"],
    ["a workflow command", "apps/sdk-a/::error::boom"],
  ])("a file name with %s never reaches an output", (_name, file) => {
    const { root, write, base, commit } = repo();
    write(file, "x\n");
    write(`dagger/${file.split("/").pop()}`, "x\n");
    const got = select(root, prEnv(base, commit()));
    expect(got.status, got.stderr).toBe(0);
    // The outside path selects every SDK; only manifest names are written.
    expect(names(got.outputs, "gate")).toEqual(["a", "b", "rust"]);
    expect(got.raw).not.toContain("pwned");
    expect(got.raw).not.toContain("::");
    expect(got.raw.split("\n").filter((l) => l !== "")).toHaveLength(OUTPUT_KEYS.length);
    expect(JSON.parse(got.outputs.gate_files)).toEqual({ files: [], unnamed: 1 });
    for (const k of ["gate", "known_red", "swift", "smoke"])
      for (const n of names(got.outputs, k)) expect(n).toMatch(NAME);
  });
});

describe("legProblem — the one statement of a leg's shape (#927 B4)", () => {
  const kind = (output) => KINDS.find((k) => k.output === output);
  it("accepts exactly the shape routeSelection writes for each kind", () => {
    expect(legProblem(kind("smoke"), "node")).toBe(false);
    expect(legProblem(kind("swift"), { name: "swift", live: true })).toBe(false);
    expect(legProblem(kind("gate"), { name: "go", daggerFn: "go-test", live: false })).toBe(false);
    expect(
      legProblem(kind("known_red"), { name: "go", daggerFn: "go-test", live: false, ticket: "#1" }),
    ).toBe(false);
  });
  it("refuses another kind's shape, a bad name, a missing live flag or a missing waiver", () => {
    expect(legProblem(kind("smoke"), { name: "node", live: false })).toBe(true);
    expect(legProblem(kind("swift"), "swift")).toBe(true);
    expect(legProblem(kind("gate"), { name: "Go", daggerFn: "go-test", live: false })).toBe(true);
    expect(legProblem(kind("gate"), { name: "go", daggerFn: "go-test" })).toBe(true);
    expect(legProblem(kind("gate"), { name: "go", live: false })).toBe(true);
    expect(legProblem(kind("known_red"), { name: "go", daggerFn: "go-test", live: false })).toBe(
      true,
    );
  });
  // M14: the Dagger leg's one summary step says "known red, not counted"
  // exactly when the leg carries a ticket, so only a known-red leg may.
  const GO = { name: "go", daggerFn: "go-test", live: false };
  it.each([
    ["a gate leg", "gate", { ...GO, ticket: "#1" }],
    ["a gate leg, even an empty one", "gate", { ...GO, ticket: "" }],
    ["a gate leg, even a null one", "gate", { ...GO, ticket: null }],
    ["a macOS leg", "swift", { name: "swift", live: true, ticket: "#1" }],
  ])("refuses a ticket on %s", (_, output, leg) =>
    expect(legProblem(kind(output), leg)).toBe(true),
  );
  it("every kind but known_red is refused a ticket, and known_red alone is refused none", () => {
    const shape = {
      gate: GO,
      known_red: { ...GO, ticket: "#1" },
      swift: { name: "swift", live: true },
    };
    const liveKinds = KINDS.filter((x) => x.live);
    // A loop over no kind asserts nothing: the live kinds are exactly the fixtures.
    expect(liveKinds.map((k) => k.output).sort()).toEqual(Object.keys(shape).sort());
    for (const k of liveKinds) {
      const leg = shape[k.output];
      expect(leg, `a fixture leg for ${k.output}`).toBeDefined();
      expect(legProblem(k, leg), k.output).toBe(false);
      const { ticket: _, ...bare } = leg;
      expect(legProblem(k, { ...bare, ticket: "#1" }), k.output).toBe(k.output !== "known_red");
    }
  });
});
