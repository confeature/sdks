// SPDX-License-Identifier: MIT

/**
 * dagger-call.sh against a stub `dagger` on PATH (#789). Every case is a way the
 * wrapper could turn a red gate green, leak a file it must not, or leave a
 * snapshot or a `dagger` process behind — the plan's FR-004/FR-005/SC-005.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../dagger-call.sh");

// The stub records what it was handed, then behaves as STUB_MODE says.
const STUB = `#!/usr/bin/env bash
src=""
for a in "$@"; do case "$a" in --source=*) src="\${a#--source=}";; esac; done
echo $$ > "$STUB_DIR/pid"
printf '%s\\n' "$@" > "$STUB_DIR/args"
(cd "$src" && find . \\( -type f -o -type l \\) | sed 's|^\\./||' | sort) > "$STUB_DIR/files"
find "$src" -type d ! -perm -0055 | wc -l | tr -d ' ' > "$STUB_DIR/private-dirs"
case "$STUB_MODE" in
  exit:*) exit "\${STUB_MODE#exit:}" ;;
  sleep-then-green) sleep 30; exit 0 ;;
  ignore-term) trap '' TERM; sleep 30; exit 0 ;;
  term-green) trap 'exit 0' TERM; sleep 30 & wait ;;
esac
`;

let repo;
let stubDir;
let binDir;

// The host's global git config (a core.excludesFile, for instance) must not
// decide what the fixture repo ignores.
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(...args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, ...GIT_ENV } });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "dagger-call-repo-"));
  stubDir = mkdtempSync(join(tmpdir(), "dagger-call-stub-"));
  binDir = join(stubDir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "dagger"), STUB);
  chmodSync(join(binDir, "dagger"), 0o755);

  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "secret.env\nbuild/\n");
  writeFileSync(join(repo, "tracked.txt"), "a");
  writeFileSync(join(repo, "gone.txt"), "b");
  writeFileSync(join(repo, "with space.txt"), "c");
  mkdirSync(join(repo, "sub", "deep"), { recursive: true });
  writeFileSync(join(repo, "sub", "deep", "nested.txt"), "n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // The working tree the wrapper must read: one deletion, one untracked file,
  // and the two kinds of ignored content it must never hand over.
  rmSync(join(repo, "gone.txt"));
  writeFileSync(join(repo, "untracked.txt"), "d");
  writeFileSync(join(repo, "secret.env"), "API_KEY=do-not-upload");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "out.js"), "e");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

function run(args, mode, onSpawn, extraPath = "") {
  return new Promise((done) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      cwd: repo,
      env: {
        ...process.env,
        ...GIT_ENV,
        PATH: `${extraPath}${binDir}:${process.env.PATH}`,
        STUB_DIR: stubDir,
        STUB_MODE: mode,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    onSpawn?.(child);
    child.on("exit", (code, signal) => done({ code, signal, stderr }));
  });
}

const snapshots = () => {
  const base = join(repo, ".git", "dagger-snapshot");
  return existsSync(base) ? readdirSync(base) : [];
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("what Dagger is handed", () => {
  it("git's view of the working tree: no ignored file, the untracked one, not the deleted one", async () => {
    const { code, stderr } = await run(["js-test"], "exit:0");
    expect(code).toBe(0);
    const files = readFileSync(join(stubDir, "files"), "utf-8").trim().split("\n");
    expect(files).toEqual([
      ".gitignore",
      "sub/deep/nested.txt",
      "tracked.txt",
      "untracked.txt",
      "with space.txt",
    ]);
    expect(readFileSync(join(stubDir, "args"), "utf-8")).toMatch(
      /^call\n-m\n\.\/dagger\njs-test\n--source=/,
    );
    expect(stderr).toContain("1 untracked, 1 changed-vs-HEAD files included");
    expect(snapshots()).toEqual([]); // cleaned up
  });

  it("the snapshot is readable by a non-root container user; only the base is private", async () => {
    await run(["js-test"], "exit:0");
    // Dagger preserves modes: a 0700 directory failed goTest (runs as `runner`).
    expect(readFileSync(join(stubDir, "private-dirs"), "utf-8").trim()).toBe("0");
    expect(statSync(join(repo, ".git", "dagger-snapshot")).mode & 0o777).toBe(0o700);
  });

  it("leftovers of a dead run and malformed names are swept, never evaluated; a live run's is kept", async () => {
    const base = join(repo, ".git", "dagger-snapshot");
    // A pid that has certainly exited: a child we spawned and reaped.
    const dead = await new Promise((r) => {
      const c = spawn("true");
      c.on("exit", () => r(c.pid));
    });
    mkdirSync(join(base, `snap.${dead}.x`), { recursive: true });
    writeFileSync(join(base, `list.${dead}.x`), "");
    mkdirSync(join(base, `snap.${process.pid}.live`));
    mkdirSync(join(base, "snap.$(touch pwned).x"));
    await run(["js-test"], "exit:0");
    expect(snapshots()).toEqual([`snap.${process.pid}.live`]);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });
});

describe("the exit code is dagger's, and never better", () => {
  it.each([0, 3])("passes %i through", async (n) => {
    expect((await run(["js-test"], `exit:${n}`)).code).toBe(n);
  });

  it("a run past the ceiling is 124 even if dagger would have exited 0", async () => {
    const { code } = await run(["--timeout", "2", "js-test"], "term-green");
    expect(code).toBe(124);
    expect(alive(Number(readFileSync(join(stubDir, "pid"), "utf-8")))).toBe(false);
    expect(snapshots()).toEqual([]);
  }, 20_000);

  it("a dagger that ignores TERM is killed after the grace, still 124", async () => {
    const { code } = await run(["--timeout", "1", "js-test"], "ignore-term");
    expect(code).toBe(124);
    expect(alive(Number(readFileSync(join(stubDir, "pid"), "utf-8")))).toBe(false);
  }, 20_000);

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ])(
    "%s to the wrapper stops dagger, removes the snapshot, exits %i",
    async (sig, expected) => {
      const pidFile = join(stubDir, "pid");
      const result = await run(["js-test"], "sleep-then-green", (child) => {
        void until(() => existsSync(pidFile)).then(() => child.kill(sig));
      });
      expect(result.code).toBe(expected);
      expect(alive(Number(readFileSync(pidFile, "utf-8")))).toBe(false);
      expect(snapshots()).toEqual([]);
    },
    30_000,
  );
});

describe("refusing an unsafe or incomplete snapshot", () => {
  it("a copy that does not match git's list is refused before dagger runs", async () => {
    // An rsync that copies nothing: the count check must catch it.
    const fake = mkdtempSync(join(tmpdir(), "dagger-call-rsync-"));
    writeFileSync(join(fake, "rsync"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(fake, "rsync"), 0o755);
    const { code, stderr } = await run(["js-test"], "exit:0", undefined, `${fake}:`);
    rmSync(fake, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(stderr).toMatch(/snapshot holds 0 files, git lists \d+/);
    expect(existsSync(join(stubDir, "args"))).toBe(false);
    expect(snapshots()).toEqual([]);
  });

  it("a symlinked snapshot base is refused with 70, and nothing is written through it", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "dagger-call-elsewhere-"));
    symlinkSync(elsewhere, join(repo, ".git", "dagger-snapshot"));
    const { code } = await run(["js-test"], "exit:0");
    const leaked = readdirSync(elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
    expect(code).toBe(70);
    expect(leaked).toEqual([]);
    expect(existsSync(join(stubDir, "args"))).toBe(false);
  });

  it("a tree where git lists nothing is refused, never handed over empty", async () => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "*\n");
    git("rm", "-rq", "--cached", ".");
    git("commit", "-qm", "empty");
    const { code, stderr } = await run(["js-test"], "exit:0");
    expect(code).toBe(1);
    expect(stderr).toContain("git lists no file");
    expect(existsSync(join(stubDir, "args"))).toBe(false);
  });
});

describe("arguments", () => {
  it.each([
    [[]],
    [["Bad_Name"]],
    [["a", "b"]],
    [["--timeout", "0", "js-test"]],
    [["--timeout", "x", "js-test"]],
    [["--bogus", "js-test"]],
    // Function arguments (#918) are `--<flag> <value>` pairs of plain names.
    [["live-suite", "--sdk"]],
    [["live-suite", "--sdk", "Bad_Name"]],
    [["live-suite", "--sdk", "$(id)"]],
    [["live-suite", "--Sdk", "node"]],
    [["live-suite", "--sdk=node"]],
    // The snapshot is the wrapper's to hand over, never the caller's.
    [["live-suite", "--source", "node"]],
  ])("refuses %j with 2, without calling dagger", async (args) => {
    expect((await run(args, "exit:0")).code).toBe(2);
    expect(existsSync(join(stubDir, "args"))).toBe(false);
  });

  it("hands a function's arguments to dagger after the function, before --source", async () => {
    const { code } = await run(["--timeout", "60", "live-suite", "--sdk", "node"], "exit:0");
    expect(code).toBe(0);
    expect(readFileSync(join(stubDir, "args"), "utf-8")).toMatch(
      /^call\n-m\n\.\/dagger\nlive-suite\n--sdk\nnode\n--source=/,
    );
  });
});
