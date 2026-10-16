// SPDX-License-Identifier: MIT

// The credentialed jobs' run: blocks, executed VERBATIM (#794 review, rounds
// 4–5). Each block is read out of sdk-publish.yml or cli-release.yml with
// `yaml` and run under the shell GitHub uses (`bash --noprofile --norc -eo
// pipefail`), in a scratch workspace holding only what the job would have,
// with the env its step, job and workflow declare and nothing else of ours:
// no git identity or config is layered under it, HOME is an empty directory.
// Every `${{ … }}` is replaced from an explicit table; an expression the table
// does not know, or a table key that names nothing in the job (rule 16), fails.
//
// Nothing reaches the network or a real credential:
//   - every step runs with GIT_ALLOW_PROTOCOL=file and fail-closed `curl` and
//     `ssh` stubs first on PATH (a test that expects curl allows one URL);
//   - a git step's literal github.com URL is rewritten to a scratch bare repo
//     through GIT_CONFIG_COUNT (url.<dir>.insteadOf), so the line stays
//     byte-exact, after the test asserts the step's own env carries the git
//     isolation and GIT_ALLOW_PROTOCOL=ssh that the rewrite overrides;
//   - each registry client (npm, gem, dotnet, cargo, rustup, dart, aws, and
//     `bash` for publish-r2.sh) is an argv-recording stub; the test asserts the
//     full argv, and that the file it names exists.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ENVIRONMENT_COMMANDS, declaredSecrets, referenceProblem } from "./verify-workflows.mjs";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flow = (f) => parseYaml(readFileSync(join(ROOT, ".github/workflows", f), "utf8"));
const PUBLISH = flow("sdk-publish.yml");
const CLI = flow("cli-release.yml");
const BASH = "/bin/bash";
/** The secrets release-settings.json declares, so a test table cannot name another. */
const SECRETS = declaredSecrets(
  JSON.parse(readFileSync(join(ROOT, "tools/repo-gates/release-settings.json"), "utf8")),
);

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "publish-blocks-"));
  dirs.push(d);
  return d;
};

/** The test's own git, for fixtures only: never the env a block runs with. */
const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "6215184+someone@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "6215184+someone@users.noreply.github.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...FIXTURE_GIT_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The step named `name` of `job` in `doc`, with the env its scopes declare. */
function step(doc, jobId, name) {
  const job = doc.jobs[jobId];
  const s = job.steps.find((x) => x.name === name);
  if (s === undefined) throw new Error(`${jobId} has no step "${name}"`);
  return { run: s.run, env: { ...doc.env, ...job.env, ...s.env }, doc, jobId };
}

/**
 * Replace every `${{ expr }}` of the step's env from `table`. An unknown
 * expression fails the test, and so does a table key that names nothing in
 * the workflow (rule 16's check): a renamed output cannot pass on test values.
 */
function resolveEnv({ env, doc, jobId }, table) {
  // One table serves a job's steps, so each key is checked at job scope.
  for (const key of Object.keys(table)) {
    const why = referenceProblem(key, { doc, jobId, secretsOf: SECRETS });
    if (why !== null) throw new Error(`test value for \${{ ${key} }} names nothing: ${why}`);
  }
  const out = {};
  for (const [k, v] of Object.entries(env))
    out[k] = String(v).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
      if (!Object.hasOwn(table, expr)) throw new Error(`no test value for \${{ ${expr} }} (${k})`);
      return table[expr];
    });
  return out;
}

/** Write `tools` (name → bash body) into a fresh bin directory (`dir`, or a test's scratch). */
function bin(tools, dir = scratch()) {
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!${BASH}\n${String(body)}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
/** Logs `<tool> <argv…>`, one line per call, to $ARGV_LOG. */
const RECORD = (name) =>
  `printf '%s' ${name} >> "$ARGV_LOG"; printf ' %s' "$@" >> "$ARGV_LOG"; echo >> "$ARGV_LOG"`;
const argvLog = (log) =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

/**
 * Every program that can reach a network or a registry. A block never gets
 * the real one: each is a fail-closed stub unless the test stubs it to
 * record. curl's default stub also lets through the one URL in $CURL_ALLOW.
 */
const NETWORK = [
  "curl",
  "ssh",
  "wget",
  "nc",
  "npm",
  "gh",
  "aws",
  "node",
  "python3",
  "gem",
  "dotnet",
  "cargo",
  "rustup",
  "dart",
  "deno",
];
const FAIL_CLOSED = (name) => `echo "${name} stub: no network in this test ($*)" >&2; exit 97`;
const CURL = `${RECORD("curl")}
for a in "$@"; do case "$a" in http*) [ -n "$CURL_ALLOW" ] && [ "$a" = "$CURL_ALLOW" ] && exit 0 ;; esac; done
echo "curl stub: no network in this test ($*)" >&2; exit 97`;
/** bash's builtins, which need no file on PATH. */
const BUILTINS = new Set(["[", "test", "echo", "printf", "exit", "umask", "cd", "true", "false"]);
const which = (tool) =>
  spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();

/**
 * PATH for one block: a scratch bin holding exactly `tools` (the job's
 * ENVIRONMENT_COMMANDS plus the extras a test names for an exception script)
 * as links to the real programs, every NETWORK program as a stub, and nothing
 * of the process PATH. The runner is Ubuntu, whose sha256sum is GNU's; on
 * macOS only, `shasum -a 256` (same --check, --strict, --quiet) stands in.
 */
function toolPath(tools, stubs = {}) {
  const dir = scratch();
  for (const t of new Set(tools)) {
    if (BUILTINS.has(t) || NETWORK.includes(t) || Object.hasOwn(stubs, t)) continue;
    if (t === "sha256sum" && process.platform === "darwin") {
      writeFileSync(join(dir, t), `#!${BASH}\nexec ${which("shasum")} -a 256 "$@"\n`);
      chmodSync(join(dir, t), 0o755);
      continue;
    }
    const real = which(t);
    if (real === "") throw new Error(`no ${String(t)} on this machine`);
    symlinkSync(real, join(dir, t));
  }
  const all = Object.fromEntries(NETWORK.map((n) => [n, n === "curl" ? CURL : FAIL_CLOSED(n)]));
  bin({ ...all, ...stubs }, dir);
  return dir;
}

/**
 * Run one block as GitHub does, in `cwd`, with exactly `env` (the step's
 * resolved env), `test` (the named test overrides) and the toolPath of its
 * job (plus `tools`, with `stubs`). GIT_ALLOW_PROTOCOL=file on every step.
 */
function runBlock({ run, doc, jobId }, cwd, env, { test = {}, stubs = {}, tools = [] } = {}) {
  const job = doc.jobs[jobId];
  const environment = typeof job.environment === "string" ? job.environment : job.environment?.name;
  const PATH = toolPath([...(ENVIRONMENT_COMMANDS[environment] ?? []), ...tools], stubs);
  const file = join(scratch(), "step.sh");
  writeFileSync(file, run);
  return spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    // LC_ALL=C: the runner's messages, not this machine's locale.
    env: { PATH, HOME: scratch(), LC_ALL: "C", ...env, GIT_ALLOW_PROTOCOL: "file", ...test },
  });
}

/** The test override that sends the literal `url` to a scratch bare repository. */
function redirect(url) {
  const bare = join(scratch(), "remote.git");
  git(ROOT, "init", "--quiet", "--bare", bare);
  return {
    bare,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
    },
  };
}

/** The git step's own env must carry what the redirect then overrides. */
function expectGitIsolation(env, { push }) {
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  if (push) expect(env.GIT_ALLOW_PROTOCOL).toBe("ssh");
}

/** A repository with one commit per message, on main. */
function history(...messages) {
  const dir = scratch();
  git(dir, "init", "--quiet", "--initial-branch=main");
  for (const m of messages) {
    writeFileSync(join(dir, "f.txt"), `${m}\n`);
    git(dir, "add", "f.txt");
    git(dir, "commit", "--quiet", "--no-verify", "-m", m);
  }
  return dir;
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("a block's PATH is exactly its job's tools and the stubs", () => {
  const fake = (jobId, run) => ({ run, doc: PUBLISH, jobId });
  it("a program outside the job's ENVIRONMENT_COMMANDS is not found (publish-npm has no ls)", () => {
    const r = runBlock(fake("publish-npm", "ls"), scratch(), {});
    expect(r.status).toBe(127);
  });
  it.each(["wget x", "nc -z x 1", "python3 -c 1", "node -e 1", "aws s3 ls", "gh api x"])(
    "%s reaches the fail-closed stub",
    (cmd) => {
      const r = runBlock(fake("publish-maven", cmd), scratch(), {});
      expect(r.status).toBe(97);
      expect(r.stderr).toContain("stub: no network in this test");
    },
  );
});

describe.each([
  ["publish-packagist", "git@github.com:confeature/confeature-php-sdk.git", "pack-packagist"],
  ["publish-swiftpm", "git@github.com:confeature/confeature-swift.git", "pack-swiftpm"],
])("%s pushes the received split, verbatim", (jobId, url, packId) => {
  const CHECK = "Check the artifact against the pack job's digest and split";
  function workspace(src) {
    const ws = scratch();
    mkdirSync(join(ws, "release"));
    git(src, "bundle", "create", "--quiet", join(ws, "release/mirror.bundle"), "main");
    return ws;
  }
  /** Run the job's steps in order; the key removal (if: always()) runs whatever failed. */
  const publish = (src, remote, tag, digest) => {
    const ws = workspace(src);
    const table = {
      [`needs.${packId}.outputs.sha256`]: digest ?? sha256(join(ws, "release/mirror.bundle")),
      [`needs.${packId}.outputs.split`]: git(src, "rev-parse", "main"),
      "needs.setup.outputs.mirrorTag": tag,
      "secrets.MIRROR_DEPLOY_KEY": "not a key",
      "github.workspace": ws,
    };
    let failed = null;
    const errors = [];
    for (const name of [CHECK, "Install the deploy key", "Upload"]) {
      const s = step(PUBLISH, jobId, name);
      const env = resolveEnv(s, table);
      if (name !== "Install the deploy key") expectGitIsolation(env, { push: name === "Upload" });
      const r = runBlock(s, ws, env, { test: name === "Upload" ? remote.env : {} });
      if (r.status !== 0) {
        failed = name;
        errors.push(r.stderr);
        break;
      }
    }
    const rm = step(PUBLISH, jobId, "Remove the deploy key");
    expect(PUBLISH.jobs[jobId].steps.find((x) => x.name === "Remove the deploy key").if).toBe(
      "always()",
    );
    expect(runBlock(rm, ws, resolveEnv(rm, table)).status).toBe(0);
    expect(existsSync(join(ws, "publish-tmp/ssh"))).toBe(false);
    return { failed, errors };
  };

  it("lands main on the split and the tag on it, and removes the key", () => {
    const src = history("one", "two");
    const remote = redirect(url);
    const { failed, errors } = publish(src, remote, "v1.0.0");
    expect(failed, errors.join("\n")).toBeNull();
    const split = git(src, "rev-parse", "main");
    expect(git(remote.bare, "rev-parse", "refs/heads/main")).toBe(split);
    expect(git(remote.bare, "rev-parse", "refs/tags/v1.0.0")).toBe(split);
  });

  it("refuses a tag that already exists, moves nothing (atomic), and removes the key", () => {
    const src = history("one");
    const remote = redirect(url);
    expect(publish(src, remote, "v1.0.0").failed).toBeNull();
    git(src, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "next");
    expect(publish(src, remote, "v1.0.0").failed).toBe("Upload");
    expect(git(remote.bare, "rev-parse", "refs/heads/main")).not.toBe(
      git(src, "rev-parse", "main"),
    );
  });

  it("refuses a main that does not fast-forward, creates no tag, and removes the key", () => {
    const remote = redirect(url);
    expect(publish(history("one"), remote, "v1.0.0").failed).toBeNull();
    expect(publish(history("unrelated"), remote, "v1.0.1").failed).toBe("Upload");
    expect(git(remote.bare, "tag", "--list", "v1.0.1")).toBe("");
  });

  it("refuses a bundle that is not the pack job's digest, before any push", () => {
    const remote = redirect(url);
    expect(publish(history("one"), remote, "v1", "0".repeat(64)).failed).toBe(CHECK);
    expect(git(remote.bare, "for-each-ref")).toBe("");
  });
});

describe("publish-go tags the checkout's HEAD, verbatim", () => {
  const run = (clone, remote, push) => {
    const table = {
      "needs.setup.outputs.releaseTag": "apps/sdk-go/v1.2.3",
      "needs.setup.outputs.version": "1.2.3",
      "secrets.GO_TAG_DEPLOY_KEY": "not a key",
      "github.workspace": clone,
    };
    let status = 0;
    let stderr = "";
    for (const name of ["Install the deploy key", "Upload"]) {
      const s = step(PUBLISH, "publish-go", name);
      const env = resolveEnv(s, table);
      if (name === "Upload") expectGitIsolation(env, { push: true });
      const r = runBlock(s, clone, env, { test: name === "Upload" ? push : {} });
      status = r.status;
      stderr = r.stderr;
      if (status !== 0) break;
    }
    const rm = step(PUBLISH, "publish-go", "Remove the deploy key");
    expect(
      PUBLISH.jobs["publish-go"].steps.find((x) => x.name === "Remove the deploy key").if,
    ).toBe("always()");
    expect(runBlock(rm, clone, resolveEnv(rm, table)).status).toBe(0);
    expect(existsSync(join(clone, "publish-tmp/ssh"))).toBe(false);
    return { status, stderr };
  };
  it("pushes HEAD:refs/tags/<module tag> to confeature/sdks, and removes the key", () => {
    const clone = history("one", "two");
    const remote = redirect("git@github.com:confeature/sdks.git");
    expect(run(clone, remote, remote.env).status).toBe(0);
    expect(git(remote.bare, "rev-parse", "refs/tags/apps/sdk-go/v1.2.3")).toBe(
      git(clone, "rev-parse", "HEAD"),
    );
  });
  it("without the redirect, git refuses the ssh transport, and the key is still removed", () => {
    const { status, stderr } = run(history("one"), null, {});
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/transport 'ssh' not allowed/);
  });
});

describe("the uploads hand each client exactly the resolved artifact", () => {
  /** release/ holding `files`, plus whatever `copies` names from the repository. */
  function workspace(files, copies = []) {
    const ws = scratch();
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(ws, f)), { recursive: true });
      writeFileSync(join(ws, f), body);
    }
    for (const f of copies) {
      mkdirSync(dirname(join(ws, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(ws, f));
    }
    return ws;
  }
  /** Run one step with recording `stubs`, the extra real `tools` it needs, and `test` overrides. */
  const upload = ({ doc = PUBLISH, jobId, name, ws, table, stubs, tools = [], test = {} }) => {
    const log = join(scratch(), "argv.log");
    const s = step(doc, jobId, name);
    const r = runBlock(s, ws, resolveEnv(s, table), {
      stubs,
      tools,
      test: { ARGV_LOG: log, ...test },
    });
    return { r, argv: argvLog(log) };
  };
  const NPM_TABLE = {
    "needs.pack-npm.outputs.sha256": "s",
    "needs.pack-npm.outputs.file": "x-1.0.0.tgz",
    "needs.setup.outputs.coordinates": "@confeature/x",
    "needs.setup.outputs.version": "1.0.0",
  };

  it("npm installs itself at the workflow's NPM_VERSION, scripts off", () => {
    const { r, argv } = upload({
      jobId: "publish-npm",
      name: "Install the pinned npm",
      ws: scratch(),
      table: NPM_TABLE,
      stubs: { npm: RECORD("npm") },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(PUBLISH.env.NPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(argv).toEqual([`npm install --global --ignore-scripts npm@${PUBLISH.env.NPM_VERSION}`]);
  });

  it("npm publishes ./release/<the pack job's file>", () => {
    const ws = workspace({ "release/x-1.0.0.tgz": "t" });
    const { r, argv } = upload({
      jobId: "publish-npm",
      name: "Upload",
      ws,
      table: NPM_TABLE,
      stubs: { npm: RECORD("npm") },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(argv).toEqual([
      "npm publish --access public --provenance --ignore-scripts ./release/x-1.0.0.tgz",
    ]);
    expect(existsSync(join(ws, "release/x-1.0.0.tgz"))).toBe(true);
  });

  it("gem pushes ./release/<the pack job's file>", () => {
    const ws = workspace({ "release/x-1.0.0.gem": "g" });
    const { r, argv } = upload({
      jobId: "publish-rubygems",
      name: "Upload",
      ws,
      table: {
        "needs.pack-rubygems.outputs.sha256": "s",
        "needs.pack-rubygems.outputs.file": "x-1.0.0.gem",
        "needs.setup.outputs.coordinates": "x",
        "needs.setup.outputs.version": "1.0.0",
      },
      stubs: { gem: RECORD("gem") },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(argv).toEqual(["gem push ./release/x-1.0.0.gem"]);
    expect(existsSync(join(ws, "release/x-1.0.0.gem"))).toBe(true);
  });

  it("dotnet pushes ./release/<coordinates>.<version>.nupkg to nuget.org with the exchanged key", () => {
    const ws = workspace({ "release/Confeature.Client.1.2.3.nupkg": "n" });
    const { r, argv } = upload({
      jobId: "publish-nuget",
      name: "Upload",
      ws,
      table: {
        "needs.pack-nuget.outputs.sums": "s",
        "needs.setup.outputs.coordinates": "Confeature.Client",
        "needs.setup.outputs.version": "1.2.3",
        "steps.login.outputs.NUGET_API_KEY": "oidc-key",
      },
      stubs: { dotnet: RECORD("dotnet") },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(argv).toEqual([
      "dotnet nuget push ./release/Confeature.Client.1.2.3.nupkg --api-key oidc-key --source https://api.nuget.org/v3/index.json",
    ]);
    expect(existsSync(join(ws, "release/Confeature.Client.1.2.3.nupkg"))).toBe(true);
  });

  it("the Go job asks the proxy for exactly the module's version info", () => {
    const { r, argv } = upload({
      jobId: "publish-go",
      name: "Ask the Go proxy for the release",
      ws: scratch(),
      table: {
        "needs.setup.outputs.releaseTag": "apps/sdk-go/v1.2.3",
        "needs.setup.outputs.version": "1.2.3",
        "secrets.GO_TAG_DEPLOY_KEY": "k",
      },
      test: {
        CURL_ALLOW:
          "https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/v1.2.3.info",
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(argv).toEqual([
      "curl -fsS --proto =https --retry 5 --retry-delay 15 --retry-all-errors https://proxy.golang.org/github.com/confeature/sdks/apps/sdk-go/@v/v1.2.3.info",
    ]);
  });

  // The Maven tools maven-r2-upload.sh runs (its exception), and the aws stub's own.
  const MAVEN_TOOLS = [
    "bash",
    "mktemp",
    "rm",
    "grep",
    "sed",
    "find",
    "sort",
    "sha256sum",
    "mkdir",
    "cp",
    "dirname",
    "cat",
  ];
  const AWS = `${RECORD("aws")}
key=""; body=""; out=""; verb="$4"; shift 4
while [ $# -gt 0 ]; do case "$1" in --key) key="$2"; shift 2;; --body) body="$2"; shift 2;; --bucket|--content-type|--cache-control|--if-none-match) shift 2;; *) out="$1"; shift;; esac; done
if [ "$verb" = put-object ]; then [ -f "$body" ] || exit 9; mkdir -p "$STORE/$(dirname "$key")"; cp "$body" "$STORE/$key"; exit 0; fi
[ -f "$STORE/$key" ] || { echo "An error occurred (NoSuchKey)" >&2; exit 254; }; cp "$STORE/$key" "$out"`;

  // The java and android units' live root module names no target (round 6:
  // that stopped the upload with exit 1); x has no module at all.
  it.each([
    ["x", "1.0.0", null],
    ["confeature-java-client", "0.1.0", "confeature-java-client-0.1.0.module"],
    ["confeature-android-client", "0.1.0", "confeature-android-client-0.1.0.module"],
  ])(
    "the Maven upload of %s@%s runs maven-r2-upload.sh on release/, through the R2 endpoint, and reads the POM back",
    (root, version, live) => {
      const v = `release/io/confeature/${root}/${version}/${root}-${version}`;
      const files = {
        [`${v}.jar`]: "j",
        [`${v}.pom`]: "p",
        [`release/io/confeature/${root}/maven-metadata.xml`]: `<metadata><version>${version}</version></metadata>`,
      };
      if (live !== null)
        files[`${v}.module`] = readFileSync(
          join(ROOT, "tools/repo-gates/fixtures/maven-live", live),
          "utf8",
        );
      const ws = workspace(files, ["tools/sdk-pack/maven-r2-upload.sh"]);
      const store = scratch();
      const pom = `https://maven.confeature.io/io/confeature/${root}/${version}/${root}-${version}.pom`;
      const { r, argv } = upload({
        jobId: "publish-maven",
        name: "Upload",
        ws,
        table: {
          "needs.pack-maven.outputs.sums": "s",
          "needs.setup.outputs.coordinates": `io.confeature:${root}`,
          "needs.setup.outputs.version": version,
          "secrets.MAVEN_R2_ACCESS_KEY_ID": "kid",
          "secrets.MAVEN_R2_SECRET_ACCESS_KEY": "secret",
          "secrets.CLOUDFLARE_ACCOUNT_ID": "acct",
        },
        stubs: { aws: AWS },
        tools: MAVEN_TOOLS,
        test: { STORE: store, CURL_ALLOW: pom },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const puts = argv.filter((a) => a.includes(" put-object "));
      expect(puts.length).toBe(Object.keys(files).length);
      for (const p of puts)
        expect(p).toMatch(
          new RegExp(
            `^aws s3api --endpoint-url https://acct\\.r2\\.cloudflarestorage\\.com put-object --bucket confeature-maven --key io/confeature/${root}/`,
          ),
        );
      expect(argv.at(-1)).toBe(
        `curl --proto =https --tlsv1.2 -fsSI --retry 5 --retry-delay 15 --retry-all-errors ${pom}`,
      );
      expect(
        readFileSync(
          join(store, `io/confeature/${root}/${version}/${root}-${version}.jar`),
          "utf8",
        ),
      ).toBe("j");
    },
  );

  it.each([
    ["upload", "Upload v<ver>/ to R2", "bash apps/cli/scripts/publish-r2.sh upload 1.2.3 dist"],
    ["promote", "Promote", "bash apps/cli/scripts/publish-r2.sh promote 1.2.3"],
  ])("cli-release %s runs publish-r2.sh with the tag's version", (jobId, name, want) => {
    const ws = workspace({ "dist/SHA256SUMS": "x" }, ["apps/cli/scripts/publish-r2.sh"]);
    const { r, argv } = upload({
      doc: CLI,
      jobId,
      name,
      ws,
      table: {
        "secrets.R2_ACCESS_KEY_ID": "kid",
        "secrets.R2_SECRET_ACCESS_KEY": "secret",
        "secrets.CLOUDFLARE_ACCOUNT_ID": "acct",
        "github.ref_name": "cli-v1.2.3",
        ...(jobId === "upload" ? { "needs.release.outputs.sums-digest": "d" } : {}),
      },
      // The inner `bash`, never the runner's (/bin/bash, by absolute path).
      stubs: {
        bash: `${RECORD("bash")}
[ -f "$1" ] || { echo "no such script: $1" >&2; exit 127; }
[ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || exit 8`,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(argv).toEqual([want]);
  });

  describe("cli-release's GitHub mirror (the release job, GH_TOKEN)", () => {
    // gh release view <tag> exits 1 until $GH_EXISTS is set; --json … prints $GH_ASSETS.
    const GH = `${RECORD("gh")}
[ -n "$GH_TOKEN" ] || { echo "no GH_TOKEN" >&2; exit 4; }
if [ "$1 $2" = "release view" ]; then
  [ -n "$GH_EXISTS" ] || exit 1
  [ "$4" = "--json" ] && echo "\${GH_ASSETS:-0}"
fi
exit 0`;
    const TABLE = { "github.token": "t", "github.ref_name": "cli-v1.2.3" };
    const ws = () =>
      workspace({ "apps/cli/dist/confeature-x86_64": "b", "apps/cli/dist/SHA256SUMS": "s" });
    const gh = (name, test, dir = ws()) =>
      upload({ doc: CLI, jobId: "release", name, ws: dir, table: TABLE, stubs: { gh: GH }, test });

    it("creates the release from the tag when it does not exist", () => {
      const { r, argv } = gh("Create the GitHub release if it does not exist", {});
      expect(r.status, r.stderr).toBe(0);
      expect(argv).toEqual([
        "gh release view cli-v1.2.3",
        "gh release create cli-v1.2.3 --title Confeature CLI 1.2.3 --generate-notes --verify-tag",
      ]);
    });
    it("creates nothing when it exists", () => {
      const { r, argv } = gh("Create the GitHub release if it does not exist", { GH_EXISTS: "1" });
      expect(r.status, r.stderr).toBe(0);
      expect(argv).toEqual(["gh release view cli-v1.2.3"]);
    });
    it("uploads the binaries and SHA256SUMS to a release with no assets", () => {
      const { r, argv } = gh("Upload assets to the GitHub release (mirror)", {
        GH_EXISTS: "1",
        GH_ASSETS: "0",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(argv).toEqual([
        "gh release view cli-v1.2.3 --json assets --jq .assets | length",
        "gh release upload cli-v1.2.3 apps/cli/dist/confeature-x86_64 apps/cli/dist/SHA256SUMS",
      ]);
    });
    it("replaces nothing on a release that already has assets", () => {
      const { r, argv } = gh("Upload assets to the GitHub release (mirror)", {
        GH_EXISTS: "1",
        GH_ASSETS: "3",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(argv).toEqual(["gh release view cli-v1.2.3 --json assets --jq .assets | length"]);
      expect(r.stdout).toContain("already carries 3 assets");
    });
  });
});

describe("the source-only uploads name the unit's own manifest (round 4: UNIT_PATH was undefined)", () => {
  // cargo +<toolchain> publish --no-verify --manifest-path <path>, with the token
  const CARGO = `${RECORD("cargo")}
[ -n "$CARGO_REGISTRY_TOKEN" ] || { echo "no token" >&2; exit 7; }
m=""; while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && m="$2"; shift; done
[ -f "$m" ] || { echo "error: manifest path \\\`$m\\\` does not exist" >&2; exit 101; }`;
  // dart pub publish --force --directory <dir>
  const DART = `${RECORD("dart")}
d=""; while [ $# -gt 0 ]; do [ "$1" = --directory ] && d="$2"; shift; done
[ -f "$d/pubspec.yaml" ] || { echo "no pubspec.yaml in $d" >&2; exit 66; }`;
  /** A workspace holding only the unit's manifest, never the repository root. */
  function workspace(manifestFile) {
    const ws = scratch();
    mkdirSync(dirname(join(ws, manifestFile)), { recursive: true });
    copyFileSync(join(ROOT, manifestFile), join(ws, manifestFile));
    return ws;
  }
  const exec = (jobId, names, table, manifestFile) => {
    const ws = workspace(manifestFile);
    const log = join(scratch(), "argv.log");
    const stubs = { rustup: RECORD("rustup"), cargo: CARGO, dart: DART };
    for (const name of names) {
      const s = step(PUBLISH, jobId, name);
      const r = runBlock(s, ws, resolveEnv(s, table), { stubs, test: { ARGV_LOG: log } });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
    return argvLog(log);
  };

  it("publish-crates installs the pinned toolchain, then publishes the unit's Cargo.toml with the token", () => {
    const rust = PUBLISH.env.RUST_VERSION;
    expect(rust).toMatch(/^\d+\.\d+\.\d+$/);
    const argv = exec(
      "publish-crates",
      ["Install the pinned Rust toolchain", "Upload"],
      { "needs.setup.outputs.path": "apps/sdk-rust", "steps.auth.outputs.token": "oidc-token" },
      "apps/sdk-rust/Cargo.toml",
    );
    expect(argv).toEqual([
      `rustup toolchain install --profile minimal -- ${rust}`,
      `cargo +${rust} publish --no-verify --manifest-path apps/sdk-rust/Cargo.toml`,
    ]);
  });

  it("publish-pubdev publishes the unit's directory, forced", () => {
    const argv = exec(
      "publish-pubdev",
      ["Upload"],
      { "needs.setup.outputs.path": "apps/sdk-dart" },
      "apps/sdk-dart/pubspec.yaml",
    );
    expect(argv).toEqual(["dart pub publish --force --directory apps/sdk-dart"]);
  });
});

describe("the digest checks accept the pack job's artifact and refuse any other", () => {
  function artifact(files) {
    const ws = scratch();
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(ws, "release", f)), { recursive: true });
      writeFileSync(join(ws, "release", f), body);
    }
    const sums = Object.keys(files)
      .map((f) => `${sha256(join(ws, "release", f))}  ${f}`)
      .join("\n");
    return { ws, sums };
  }
  const tamper = (ws, f) => writeFileSync(join(ws, "release", f), "other bytes");

  it.each([
    ["publish-npm", "pack-npm", "x-1.0.0.tgz"],
    ["publish-rubygems", "pack-rubygems", "x-1.0.0.gem"],
  ])("%s: one file against the pack job's sha256", (jobId, packId, file) => {
    const s = step(PUBLISH, jobId, "Check the artifact against the pack job's digest");
    const good = artifact({ [file]: "bytes" });
    const env = resolveEnv(s, {
      [`needs.${packId}.outputs.sha256`]: sha256(join(good.ws, "release", file)),
      [`needs.${packId}.outputs.file`]: file,
      "needs.setup.outputs.coordinates": "x",
      "needs.setup.outputs.version": "1.0.0",
    });
    expect(runBlock(s, good.ws, env).status).toBe(0);
    tamper(good.ws, file);
    expect(runBlock(s, good.ws, env).status).not.toBe(0);
  });

  it.each([
    ["publish-pypi", "pack-pypi", { "x-1.0.0.tar.gz": "a", "x-1.0.0-py3-none-any.whl": "b" }],
    ["publish-nuget", "pack-nuget", { "x.1.0.0.nupkg": "a", "x.1.0.0.snupkg": "b" }],
    [
      "publish-maven",
      "pack-maven",
      { "io/x/1.0.0/x-1.0.0.jar": "a", "io/x/maven-metadata.xml": "b" },
    ],
  ])("%s: the file set and every digest", (jobId, packId, files) => {
    const s = step(PUBLISH, jobId, "Check the artifact against the pack job's digests");
    const env = (sums) =>
      resolveEnv(s, {
        [`needs.${packId}.outputs.sums`]: sums,
        "needs.setup.outputs.coordinates": "x",
        "needs.setup.outputs.version": "1.0.0",
      });
    const good = artifact(files);
    expect(runBlock(s, good.ws, env(good.sums)).status).toBe(0);
    const extra = artifact(files);
    writeFileSync(join(extra.ws, "release", "stray.txt"), "x");
    expect(runBlock(s, extra.ws, env(extra.sums)).status).not.toBe(0);
    const bad = artifact(files);
    tamper(bad.ws, Object.keys(files)[0]);
    expect(runBlock(s, bad.ws, env(bad.sums)).status).not.toBe(0);
  });

  it("cli-release upload: SHA256SUMS against the release job's digest", () => {
    const s = step(CLI, "upload", "Check the build against the release job's digest");
    const ws = scratch();
    mkdirSync(join(ws, "dist"));
    writeFileSync(join(ws, "dist/SHA256SUMS"), "abc  confeature-x\n");
    const env = (digest) =>
      resolveEnv(s, {
        "needs.release.outputs.sums-digest": digest,
        "github.ref_name": "cli-v1.0.0",
      });
    expect(runBlock(s, ws, env(sha256(join(ws, "dist/SHA256SUMS")))).status).toBe(0);
    expect(runBlock(s, ws, env("0".repeat(64))).status).not.toBe(0);
    expect(runBlock(s, ws, env("")).status).not.toBe(0);
  });
});
