// SPDX-License-Identifier: MIT

/**
 * The reference origin runs locally and is never deployed (#861, plan §12
 * Q2): its wrangler.toml names no account, no route and no KV id, keeps
 * observability off, and nothing in the repository deploys it. Read with
 * wrangler's own parser, so a key spelled any way wrangler accepts is seen.
 *
 * Also the default-upstream rule (src/upstream.ts): the reference origin
 * unless CDN_ENTRY and CDN_CONFIG opt into another Worker together; and the
 * KV namespace rule (kvNamespaceArgs), which refuses what it cannot seed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

import { referenceOrigin, resolveUpstream } from "../src/upstream.js";
import { kvNamespaceArgs } from "../src/wrangler-host.js";

const pkgRoot = pathResolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = pathResolve(pkgRoot, "../..");
const { cdnEntry, cdnConfigPath } = referenceOrigin();
const SELF = "tools/test-harness-live-contract/tests/reference-origin-config.test.ts";

/** Every tracked file kind that can run a deploy: workflows, shell, JS and TS. */
const DEPLOY_SCANNED = ["*.yml", "*.yaml", "*.sh", "*.mjs", "*.cjs", "*.js", "*.ts"];
/** How a file can name the origin: its directory or Worker name, or the harness helper. */
const NAMES_ORIGIN = /reference-origin|referenceOrigin/;
/** A deploy, in every form wrangler offers, spelled in a shell line or a spawn array. */
const DEPLOYS =
  /wrangler(?:\.js)?["'\s,]+(?:deploy|publish|versions["'\s,]+(?:upload|deploy))\b|wrangler-action/;

/**
 * Whether `text` deploys the reference origin. A package.json is judged per
 * script (its `ready:deploy` may test the origin without deploying anything);
 * any other file as a whole, so a path held in a variable a few lines above
 * the deploy is still seen.
 */
function deploysOrigin(file: string, text: string): boolean {
  if (file.endsWith("package.json")) {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.values(scripts).some((cmd) => NAMES_ORIGIN.test(cmd) && DEPLOYS.test(cmd));
  }
  return NAMES_ORIGIN.test(text) && DEPLOYS.test(text);
}

/** Never scanned by the walk. Everything else is: the walk must see at least what git sees. */
const WALK_SKIPS = new Set([".git", "node_modules"]);
/** The share of the listed files that must actually be read. */
const READ_SHARE = 0.9;
/**
 * The walk's floor when there is no .git, hence no git count to derive one from
 * (the Dagger snapshot). Where .git exists, the walk is held to git itself: its
 * list must be a superset of `git ls-files` on the same tree.
 *
 * One floor for both repositories this file runs in (it moves to the public
 * SDK repository, ADR 0006): sized to the smaller tree, about 340
 * deploy-capable files on 2026-10-05. A count alone cannot catch a walk cut
 * short in the larger tree; `SENTINELS` does, whatever the count.
 */
const WALK_MIN = 250;

/**
 * Files every walk must have READ, in both repositories. They sit under
 * `tools/`, the last directory a walk reaches, so a walk cut short anywhere
 * misses them whatever its count.
 */
const SENTINELS = [
  SELF,
  "tools/test-harness-live-contract/src/upstream.ts",
  "tools/test-harness-live-contract/reference-origin/src/index.ts",
];

const isScanned = (rel: string): boolean =>
  rel.endsWith("package.json") || DEPLOY_SCANNED.some((g) => rel.endsWith(g.slice(1)));

/** Git's tracked deploy-capable files; throws, never falls back, when git cannot answer. */
function gitListed(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", "*package.json", ...DEPLOY_SCANNED], {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(`no-deploy guard: git ls-files failed in ${root} (${String(e)})`);
  }
  return out.split("\0").filter((f) => f.length > 0);
}

/**
 * Every deploy-capable file under `root` but .git and node_modules. No
 * .gitignore is read: the Dagger snapshot is already git's view, and a tracked
 * file a .gitignore also names (a generated route tree, say) must be scanned.
 * Symlinked directories are not followed.
 */
function walkListed(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIPS.has(entry.name)) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), childRel);
      else if (isScanned(childRel)) out.push(childRel);
    }
  };
  try {
    visit(root, "");
  } catch (e) {
    throw new Error(`no-deploy guard: ${root} has no .git and cannot be walked (${String(e)})`);
  }
  return out;
}

/** Git's list when the tree has a .git; otherwise the walk, the Dagger snapshot's case (#865). */
function listed(root: string): { source: "git" | "walk"; files: string[]; floor: number } {
  if (existsSync(join(root, ".git"))) {
    const files = gitListed(root);
    return { source: "git", files, floor: Math.max(1, Math.ceil(READ_SHARE * files.length)) };
  }
  const files = walkListed(root);
  return {
    source: "walk",
    files,
    floor: Math.max(WALK_MIN, Math.ceil(READ_SHARE * files.length)),
  };
}

/**
 * The files under `root` that deploy the reference origin, the guard's own file
 * aside. A listed file that is gone (tracked, deleted in the working tree) is
 * skipped; any other read failure throws. Throws, too, when fewer files were
 * READ than the floor: an empty or unreadable scan must never pass as "nothing
 * deploys".
 */
function scanForDeploys(root: string): { source: "git" | "walk"; offending: string[] } {
  const { source, files, floor } = listed(root);
  let read = 0;
  const seen = new Set<string>();
  const offending: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(pathResolve(root, file), "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`no-deploy guard: cannot read ${file} (${String(e)})`);
    }
    read += 1;
    seen.add(file);
    if (file !== SELF && deploysOrigin(file, text)) offending.push(file);
  }
  if (read < floor) {
    throw new Error(
      `no-deploy guard: the ${source} scan of ${root} read ${String(read)} files, fewer than ${String(floor)}`,
    );
  }
  const unread = source === "walk" ? SENTINELS.filter((f) => !seen.has(f)) : [];
  if (unread.length > 0) {
    throw new Error(
      `no-deploy guard: the walk scan of ${root} never read ${unread.join(", ")}: it was cut short`,
    );
  }
  return { source, offending };
}

describe("the reference origin's wrangler.toml cannot deploy anywhere", () => {
  const config = unstable_readConfig({ config: cdnConfigPath }, { hideWarnings: true });

  it("names no account, route, custom domain or workers.dev subdomain", () => {
    expect(config.account_id).toBeUndefined();
    expect(config.route).toBeUndefined();
    expect(config.routes ?? []).toEqual([]);
    expect(config.workers_dev).toBe(false);
  });

  it("binds CONFIG_KV with no namespace id and no preview id", () => {
    expect(config.kv_namespaces).toEqual([{ binding: "CONFIG_KV" }]);
    expect(kvNamespaceArgs(cdnConfigPath)).toEqual(["--namespace-id=CONFIG_KV"]);
  });

  it("keeps observability and its logs off: SDK keys travel in the path", () => {
    expect(config.observability?.enabled).toBe(false);
    expect(config.observability?.logs?.enabled).toBe(false);
  });

  it("serves the entry the harness boots", () => {
    expect(pathResolve(pathResolve(cdnConfigPath, ".."), config.main ?? "")).toBe(cdnEntry);
  });

  it("no tracked script, workflow or source deploys it", { timeout: 60_000 }, () => {
    const { source, offending } = scanForDeploys(repoRoot);
    // Git whenever there is a .git; the walk only in a tree without one.
    expect(source).toBe(existsSync(join(repoRoot, ".git")) ? "git" : "walk");
    expect(offending).toEqual([]);
  });

  it.skipIf(!existsSync(join(repoRoot, ".git")))(
    "the walk sees every file git lists, on this very tree",
    () => {
      const walked = new Set(walkListed(repoRoot));
      const missed = gitListed(repoRoot).filter(
        (f) => existsSync(pathResolve(repoRoot, f)) && !walked.has(f),
      );
      expect(missed).toEqual([]);
    },
  );

  describe("without .git (the Dagger snapshot)", () => {
    const PLANT =
      "npx wrangler deploy -c tools/test-harness-live-contract/reference-origin/wrangler.toml\n";
    let copy = "";

    /** This tree's scanned files, copied into a temp dir with no .git. */
    const copyTree = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "lc-nogit-"));
      for (const f of [".gitignore", ...listed(repoRoot).files]) {
        const from = pathResolve(repoRoot, f);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(from, join(dir, f));
      }
      return dir;
    };
    const plant = (rel: string, text = PLANT) => {
      mkdirSync(dirname(join(copy, rel)), { recursive: true });
      writeFileSync(join(copy, rel), text);
    };
    /** Plant `rels`, run `check`, then take every plant out again. */
    const withPlants = (rels: string[], check: () => void) => {
      try {
        for (const r of rels) plant(r);
        check();
      } finally {
        for (const r of rels) rmSync(join(copy, r), { force: true });
      }
    };

    beforeAll(() => {
      copy = copyTree();
    });
    afterAll(() => {
      rmSync(copy, { recursive: true, force: true });
    });

    it("walks the tree and still sees a planted deploy, of every file kind", () => {
      const planted = [
        ".github/workflows/planted.yml",
        "scripts/planted.sh",
        "apps/x/planted.ts",
        "apps/x/planted.mjs",
        "apps/x/planted.cjs",
        "apps/x/planted.js",
        "apps/x/planted.yaml",
      ];
      withPlants(planted, () => {
        plant("apps/x/package.json", JSON.stringify({ scripts: { up: PLANT.trim() } }));
        try {
          const { source, offending } = scanForDeploys(copy);
          expect(source).toBe("walk");
          expect(offending.sort()).toEqual([...planted, "apps/x/package.json"].sort());
        } finally {
          rmSync(join(copy, "apps/x/package.json"));
        }
      });
    });

    it("leaves out node_modules only: dist and what a .gitignore names are scanned", () => {
      const skipped = ["node_modules/x/deploy.js", "apps/x/node_modules/y/deploy.js"];
      const seen = ["dist/deploy.js", "apps/x/dist/deploy.js", "apps/x/ignored-out/deploy.ts"];
      withPlants([...skipped, ...seen, "apps/x/.gitignore"], () => {
        plant("apps/x/.gitignore", "ignored-out/\ndist\n");
        expect(scanForDeploys(copy).offending.sort()).toEqual(seen.sort());
      });
    });

    it("refuses a file it cannot read, rather than counting it as deploying nothing", () => {
      // A symlink loop: unreadable even for root (ELOOP), unlike a chmod 000.
      const loop = join(copy, "apps/x/loop.ts");
      mkdirSync(dirname(loop), { recursive: true });
      symlinkSync("loop.ts", loop);
      try {
        expect(() => scanForDeploys(copy)).toThrow(/cannot read apps\/x\/loop\.ts .*ELOOP/);
      } finally {
        rmSync(loop);
      }
    });

    it("refuses a walk cut short before tools/, whatever its count", () => {
      // MUTATION: drop the sentinel check and a walk that never reached tools/
      // passes on its count alone.
      const cut = mkdtempSync(join(tmpdir(), "lc-nogit-cut-"));
      try {
        for (const f of listed(repoRoot).files.filter((p) => !p.startsWith("tools/"))) {
          if (!existsSync(pathResolve(repoRoot, f))) continue;
          mkdirSync(dirname(join(cut, f)), { recursive: true });
          copyFileSync(pathResolve(repoRoot, f), join(cut, f));
        }
        // Enough files that only the sentinels can tell.
        for (let i = 0; i < 600; i++) writeFileSync(join(cut, `pad${String(i)}.ts`), "x\n");
        expect(() => scanForDeploys(cut)).toThrow(/never read .*reference-origin-config\.test\.ts/);
      } finally {
        rmSync(cut, { recursive: true, force: true });
      }
    });

    it("refuses a walk that reads fewer files than the floor", () => {
      const small = mkdtempSync(join(tmpdir(), "lc-nogit-small-"));
      try {
        writeFileSync(join(small, "deploy.sh"), PLANT);
        expect(() => scanForDeploys(small)).toThrow(/walk scan .* read 1 files, fewer than 250/);
      } finally {
        rmSync(small, { recursive: true, force: true });
      }
    });

    it("refuses a tree it can neither ask git about nor walk", () => {
      expect(() => scanForDeploys(join(copy, "does-not-exist"))).toThrow(
        /has no \.git and cannot be walked/,
      );
    });

    it("refuses, rather than walks, a .git that git cannot read", () => {
      writeFileSync(join(copy, ".git"), "gitdir: /nowhere\n");
      try {
        expect(() => scanForDeploys(copy)).toThrow(/git ls-files failed in /);
      } finally {
        rmSync(join(copy, ".git"));
      }
    });
  });

  it.skipIf(spawnSync("git", ["--version"]).status !== 0)(
    "refuses a git scan that reads less than 90% of what git lists",
    () => {
      const repo = mkdtempSync(join(tmpdir(), "lc-git-floor-"));
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repo,
          stdio: "ignore",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      try {
        git("init", "-q");
        for (let i = 0; i < 10; i++) writeFileSync(join(repo, `f${String(i)}.ts`), "x\n");
        git("add", "-A");
        git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "init");
        expect(scanForDeploys(repo)).toEqual({ source: "git", offending: [] });
        rmSync(join(repo, "f0.ts"));
        expect(scanForDeploys(repo).source).toBe("git"); // 9 of 10 read: at the floor
        rmSync(join(repo, "f1.ts"));
        expect(() => scanForDeploys(repo)).toThrow(/git scan .* read 8 files, fewer than 9/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "a workflow step",
      "w.yml",
      "run: npx wrangler deploy -c tools/test-harness-live-contract/reference-origin/wrangler.toml",
    ],
    [
      "a versions upload",
      "x.sh",
      "wrangler versions upload --config reference-origin/wrangler.toml",
    ],
    [
      "the path in a variable",
      "x.sh",
      'CFG=reference-origin/wrangler.toml\nnpx wrangler deploy -c "$CFG"',
    ],
    [
      "a spawn from source",
      "x.ts",
      'spawn("npx", ["wrangler", "deploy", "-c", referenceOrigin().cdnConfigPath]);',
    ],
    [
      "the wrangler action",
      "w.yml",
      "uses: cloudflare/wrangler-action@v3\nworkingDirectory: reference-origin",
    ],
    [
      "a package script",
      "package.json",
      JSON.stringify({ scripts: { up: "wrangler deploy -c reference-origin/wrangler.toml" } }),
    ],
  ])("the guard sees %s", (_name, file, text) => {
    expect(deploysOrigin(file, text)).toBe(true);
  });

  it("the guard lets a script that only tests the origin through", () => {
    const pkg = {
      scripts: { "ready:deploy": "vp test run tests/reference-origin-transcript.test.ts" },
    };
    expect(deploysOrigin("package.json", JSON.stringify(pkg))).toBe(false);
  });
});

describe("kvNamespaceArgs refuses a config it cannot seed correctly (#861)", () => {
  const withToml = (toml: string, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "lc-kvargs-"));
    try {
      const path = join(dir, "wrangler.toml");
      writeFileSync(
        path,
        `name = "x"\nmain = "index.ts"\ncompatibility_date = "2026-05-14"\n${toml}`,
      );
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("a config with no CONFIG_KV binding", () => {
    withToml('[[kv_namespaces]]\nbinding = "OTHER_KV"\n', (path) => {
      expect(() => kvNamespaceArgs(path)).toThrow(/declares no CONFIG_KV binding/);
    });
    withToml("", (path) => {
      expect(() => kvNamespaceArgs(path)).toThrow(/declares no CONFIG_KV binding/);
    });
  });

  it("a CONFIG_KV with an id and no preview_id", () => {
    withToml('[[kv_namespaces]]\nbinding = "CONFIG_KV"\nid = "local-only"\n', (path) => {
      expect(() => kvNamespaceArgs(path)).toThrow(/an id but no preview_id/);
    });
  });

  it("accepts both ids (the CDN Worker's shape) with --binding --preview", () => {
    withToml(
      '[[kv_namespaces]]\nbinding = "CONFIG_KV"\nid = "local-a"\npreview_id = "local-b"\n',
      (path) => expect(kvNamespaceArgs(path)).toEqual(["--binding=CONFIG_KV", "--preview"]),
    );
  });
});

describe("the harness's default upstream (#861)", () => {
  it("is the reference origin", () => {
    expect(resolveUpstream({})).toEqual(referenceOrigin());
    expect(cdnEntry).toBe(pathResolve(pkgRoot, "reference-origin/src/index.ts"));
  });

  it("is another Worker only when CDN_ENTRY and CDN_CONFIG are both set", () => {
    expect(resolveUpstream({ CDN_ENTRY: "/w/index.ts", CDN_CONFIG: "/w/wrangler.toml" })).toEqual({
      cdnEntry: "/w/index.ts",
      cdnConfigPath: "/w/wrangler.toml",
    });
    expect(() => resolveUpstream({ CDN_ENTRY: "/w/index.ts" })).toThrow(/together/);
    expect(() => resolveUpstream({ CDN_CONFIG: "/w/wrangler.toml" })).toThrow(/together/);
  });

  it("the CLI exits 2 on half an opt-in, before booting anything", { timeout: 120_000 }, () => {
    // The CLI is what runners call, so it is the built file that is run.
    execFileSync(pathResolve(pkgRoot, "node_modules/.bin/tsc"), ["--build"], { cwd: pkgRoot });
    const env: NodeJS.ProcessEnv = { ...process.env, CDN_ENTRY: "/w/index.ts" };
    delete env["CDN_CONFIG"];
    const run = spawnSync(process.execPath, [pathResolve(pkgRoot, "dist/cli.js")], {
      env,
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/set both, or neither/);
    expect(run.stdout).not.toMatch(/LIVE_HARNESS_URL/);
  });
});
