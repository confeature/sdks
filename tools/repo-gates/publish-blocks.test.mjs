// SPDX-License-Identifier: MIT

// The credentialed jobs' run: blocks, executed VERBATIM (#794 review, round 4).
// Each block is read out of sdk-publish.yml or cli-release.yml with `yaml` and
// run under the shell GitHub uses (`bash --noprofile --norc -eo pipefail`), in
// a scratch directory, with the env its step, job and workflow declare. Every
// `${{ … }}` is replaced from an explicit table, and an expression the table
// does not know fails the test, so a new input cannot slip past unexercised.
// Nothing reaches the network or a real credential:
//   - git remotes are literal github.com URLs in the blocks; GIT_CONFIG_COUNT
//     rewrites each to a scratch bare repository (url.<dir>.insteadOf), so the
//     command line stays byte-exact, and GIT_ALLOW_PROTOCOL becomes `file`;
//   - registry clients (cargo, rustup, dart, curl) are argv-recording stubs
//     first on PATH, which fail as the real tool would on a missing manifest.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flow = (f) => parseYaml(readFileSync(join(ROOT, ".github/workflows", f), "utf8"));
const PUBLISH = flow("sdk-publish.yml");
const CLI = flow("cli-release.yml");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "publish-blocks-"));
  dirs.push(d);
  return d;
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "6215184+someone@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "6215184+someone@users.noreply.github.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The step named `name` of `job` in `doc`, with the env its scopes declare. */
function step(doc, jobId, name) {
  const job = doc.jobs[jobId];
  const s = job.steps.find((x) => x.name === name);
  if (s === undefined) throw new Error(`${jobId} has no step "${name}"`);
  return { run: s.run, env: { ...doc.env, ...job.env, ...s.env } };
}

/** Replace every `${{ expr }}` from `table`; an unknown expression is a test failure. */
function resolveEnv(env, table) {
  const out = {};
  for (const [k, v] of Object.entries(env))
    out[k] = String(v).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
      if (!Object.hasOwn(table, expr)) throw new Error(`no test value for \${{ ${expr} }} (${k})`);
      return table[expr];
    });
  return out;
}

/**
 * The runner is Ubuntu, whose sha256sum is GNU's. Where the local one is not
 * (macOS), `shasum -a 256` stands in: it takes the same --check, --strict and
 * --quiet flags. A shim of the coreutil, never of the block under test.
 */
const SHIM = (() => {
  const gnu = spawnSync("sha256sum", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU");
  if (gnu) return null;
  const dir = mkdtempSync(join(tmpdir(), "publish-blocks-shim-"));
  writeFileSync(join(dir, "sha256sum"), '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n');
  chmodSync(join(dir, "sha256sum"), 0o755);
  return dir;
})();
afterAll(() => {
  if (SHIM !== null) rmSync(SHIM, { recursive: true, force: true });
});
const basePath = () => (SHIM === null ? process.env.PATH : `${SHIM}:${process.env.PATH}`);

/** Run one block as GitHub does, in `cwd`, with `env` on top of a minimal process env. */
function runBlock({ run }, cwd, env, extra = {}) {
  const file = join(scratch(), "step.sh");
  writeFileSync(file, run);
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    env: { PATH: basePath(), ...GIT_ENV, ...env, ...extra },
  });
}

/** A bare repository the literal `url` is rewritten to, for one git invocation's config. */
function redirect(url) {
  const bare = join(scratch(), "remote.git");
  git(ROOT, "init", "--quiet", "--bare", bare);
  return {
    bare,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
      GIT_ALLOW_PROTOCOL: "file",
    },
  };
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

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.each([
  ["publish-packagist", "git@github.com:confeature/confeature-php-sdk.git", "pack-packagist"],
  ["publish-swiftpm", "git@github.com:confeature/confeature-swift.git", "pack-swiftpm"],
])("%s pushes the received split, verbatim", (jobId, url, packId) => {
  /** The workspace of one run: the pack job's bundle of `src`'s main at release/mirror.bundle. */
  function workspace(src) {
    const ws = scratch();
    mkdirSync(join(ws, "release"));
    git(src, "bundle", "create", "--quiet", join(ws, "release/mirror.bundle"), "main");
    return ws;
  }
  const publish = (src, remote, tag) => {
    const ws = workspace(src);
    const table = {
      [`needs.${packId}.outputs.sha256`]: sha256(join(ws, "release/mirror.bundle")),
      [`needs.${packId}.outputs.split`]: git(src, "rev-parse", "main"),
      "needs.setup.outputs.name": jobId === "publish-packagist" ? "php" : "swift",
      "needs.setup.outputs.mirrorRepository": url.slice("git@github.com:".length, -4),
      "needs.setup.outputs.mirrorTag": tag,
      "secrets.MIRROR_DEPLOY_KEY": "not a key",
      "github.workspace": ws,
    };
    const results = [];
    for (const name of [
      "Check the artifact against the pack job's digest and split",
      "Install the deploy key",
      "Upload",
      "Remove the deploy key",
    ]) {
      const s = step(PUBLISH, jobId, name);
      const env = resolveEnv(s.env, table);
      const r = runBlock(s, ws, env, name === "Upload" ? remote.env : {});
      results.push(r);
      if (r.status !== 0) return { ws, results, failed: name };
    }
    return { ws, results, failed: null };
  };

  it("lands main on the split and the tag on it, and removes the key", () => {
    const src = history("one", "two");
    const remote = redirect(url);
    const { ws, failed, results } = publish(src, remote, "v1.0.0");
    expect(failed, results.map((r) => r.stderr).join("\n")).toBeNull();
    const split = git(src, "rev-parse", "main");
    expect(git(remote.bare, "rev-parse", "refs/heads/main")).toBe(split);
    expect(git(remote.bare, "rev-parse", "refs/tags/v1.0.0")).toBe(split);
    expect(existsSync(join(ws, "publish-tmp/ssh"))).toBe(false);
  });

  it("refuses a tag that already exists, and moves nothing (atomic)", () => {
    const src = history("one");
    const remote = redirect(url);
    expect(publish(src, remote, "v1.0.0").failed).toBeNull();
    git(src, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "next");
    const again = publish(src, remote, "v1.0.0");
    expect(again.failed).toBe("Upload");
    expect(git(remote.bare, "rev-parse", "refs/heads/main")).not.toBe(
      git(src, "rev-parse", "main"),
    );
  });

  it("refuses a main that does not fast-forward, and creates no tag", () => {
    const remote = redirect(url);
    expect(publish(history("one"), remote, "v1.0.0").failed).toBeNull();
    const other = publish(history("unrelated"), remote, "v1.0.1");
    expect(other.failed).toBe("Upload");
    expect(git(remote.bare, "tag", "--list", "v1.0.1")).toBe("");
  });

  it("refuses a bundle that is not the pack job's digest, before any push", () => {
    const src = history("one");
    const remote = redirect(url);
    const ws = workspace(src);
    const s = step(PUBLISH, jobId, "Check the artifact against the pack job's digest and split");
    const env = resolveEnv(s.env, {
      [`needs.${packId}.outputs.sha256`]: "0".repeat(64),
      [`needs.${packId}.outputs.split`]: git(src, "rev-parse", "main"),
      "needs.setup.outputs.name": "x",
      "needs.setup.outputs.mirrorRepository": "x",
      "needs.setup.outputs.mirrorTag": "v1",
    });
    expect(runBlock(s, ws, env).status).not.toBe(0);
    expect(git(remote.bare, "for-each-ref")).toBe("");
  });
});

describe("publish-go tags the checkout's HEAD, verbatim", () => {
  it("pushes HEAD:refs/tags/<module tag> to confeature/sdks", () => {
    const clone = history("one", "two");
    const remote = redirect("git@github.com:confeature/sdks.git");
    const table = {
      "needs.setup.outputs.releaseTag": "apps/sdk-go/v1.2.3",
      "needs.setup.outputs.coordinates": "github.com/confeature/sdks/apps/sdk-go",
      "needs.setup.outputs.version": "1.2.3",
      "secrets.GO_TAG_DEPLOY_KEY": "not a key",
      "github.workspace": clone,
    };
    for (const name of ["Install the deploy key", "Upload", "Remove the deploy key"]) {
      const s = step(PUBLISH, "publish-go", name);
      const r = runBlock(s, clone, resolveEnv(s.env, table), name === "Upload" ? remote.env : {});
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
    expect(git(remote.bare, "rev-parse", "refs/tags/apps/sdk-go/v1.2.3")).toBe(
      git(clone, "rev-parse", "HEAD"),
    );
  });
});

describe("the source-only uploads name the unit's own manifest (round 4: UNIT_PATH was undefined)", () => {
  /** A bin directory whose `tool` logs argv and fails as the real one would. */
  function stubs() {
    const bin = scratch();
    const log = join(bin, "argv.log");
    const tools = {
      rustup: 'echo "rustup $*" >> "$ARGV_LOG"',
      // cargo +<toolchain> publish --no-verify --manifest-path <path>
      cargo: `echo "cargo $*" >> "$ARGV_LOG"
m=""; while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && m="$2"; shift; done
[ -f "$m" ] || { echo "error: manifest path \`$m\` does not exist" >&2; exit 101; }`,
      // dart pub publish --force --directory <dir>
      dart: `echo "dart $*" >> "$ARGV_LOG"
d=""; while [ $# -gt 0 ]; do [ "$1" = --directory ] && d="$2"; shift; done
[ -f "$d/pubspec.yaml" ] || { echo "Could not find a file named \\"pubspec.yaml\\" in \\"$d\\"" >&2; exit 66; }`,
    };
    for (const [name, body] of Object.entries(tools)) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    return { bin, log };
  }
  const RESOLVED = {
    "publish-crates": {
      "needs.setup.outputs.path": "apps/sdk-rust",
      "steps.auth.outputs.token": "t",
    },
    "publish-pubdev": { "needs.setup.outputs.path": "apps/sdk-dart" },
  };

  it.each([
    [
      "publish-crates",
      ["Install the pinned Rust toolchain", "Upload"],
      "--manifest-path apps/sdk-rust/Cargo.toml",
    ],
    ["publish-pubdev", ["Upload"], "--directory apps/sdk-dart"],
  ])("%s runs with the unit's path", (jobId, names, want) => {
    const { bin, log } = stubs();
    for (const name of names) {
      const s = step(PUBLISH, jobId, name);
      const r = runBlock(s, ROOT, resolveEnv(s.env, RESOLVED[jobId]), {
        PATH: `${bin}:${basePath()}`,
        ARGV_LOG: log,
      });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
    expect(readFileSync(log, "utf8")).toContain(want);
  });
});

describe("the digest checks accept the pack job's artifact and refuse any other", () => {
  /** release/ holding `files`, and the sha256sum lines of them. */
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
    const env = (ws) =>
      resolveEnv(s.env, {
        [`needs.${packId}.outputs.sha256`]: sha256(join(ws, "release", file)),
        [`needs.${packId}.outputs.file`]: file,
        "needs.setup.outputs.coordinates": "x",
        "needs.setup.outputs.version": "1.0.0",
      });
    expect(runBlock(s, good.ws, env(good.ws)).status).toBe(0);
    const e = env(good.ws);
    tamper(good.ws, file);
    expect(runBlock(s, good.ws, e).status).not.toBe(0);
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
      resolveEnv(s.env, {
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
      resolveEnv(s.env, {
        "needs.release.outputs.sums-digest": digest,
        "github.ref_name": "cli-v1.0.0",
      });
    expect(runBlock(s, ws, env(sha256(join(ws, "dist/SHA256SUMS")))).status).toBe(0);
    expect(runBlock(s, ws, env("0".repeat(64))).status).not.toBe(0);
    expect(runBlock(s, ws, env("")).status).not.toBe(0);
  });
});
