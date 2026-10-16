// SPDX-License-Identifier: MIT

// The npm tarball check (tools/sdk-pack/check-npm-tarball.mjs): one case per
// refusal, so each rule is seen to fail closed, and the CLI on real tarballs.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tarballProblems } from "../sdk-pack/check-npm-tarball.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/sdk-pack/check-npm-tarball.mjs");

const GOOD = {
  name: "@confeature/sdk-x",
  version: "0.1.0",
  main: "./dist/index.cjs",
  types: "./dist/index.d.ts",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs" },
    "./package.json": "./package.json",
  },
  dependencies: { "@confeature/sdk-shared": "^0.1.0" },
};
const FILES = [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/index.cjs",
  "dist/index.mjs",
  "dist/index.d.ts",
];
const check = (m, files = FILES) => tarballProblems(m, files, "@confeature/sdk-x", "0.1.0");

describe("tarballProblems", () => {
  it("accepts a complete tarball", () => {
    expect(check(GOOD)).toEqual([]);
  });

  it("refuses another name or version", () => {
    expect(check({ ...GOOD, version: "0.1.1" })).toEqual([
      "the tarball is @confeature/sdk-x@0.1.1, not @confeature/sdk-x@0.1.0",
    ]);
  });

  it("refuses an unrewritten workspace range in any runtime field", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const problems = check({
        ...GOOD,
        dependencies: {},
        [field]: { "@confeature/sdk-browser-js": "workspace:^" },
      });
      expect(problems).toEqual([
        `unrewritten workspace range: ${field}.@confeature/sdk-browser-js = workspace:^`,
      ]);
    }
  });

  it("ignores devDependencies, which consumers never install", () => {
    expect(
      check({
        ...GOOD,
        devDependencies: { "@confeature/test-fixtures-sdk-parity": "workspace:*" },
      }),
    ).toEqual([]);
  });

  it("refuses a tarball with no LICENSE at its root", () => {
    expect(
      check(
        GOOD,
        FILES.filter((f) => f !== "LICENSE"),
      ),
    ).toEqual(["no LICENSE at the package root"]);
    expect(check(GOOD, [...FILES.filter((f) => f !== "LICENSE"), "dist/LICENSE"])).toEqual([
      "no LICENSE at the package root",
    ]);
  });

  it("refuses a manifest with no entry point (the sdk-angular source manifest, #899)", () => {
    const bare = { ...GOOD };
    for (const k of ["main", "types", "exports"]) delete bare[k];
    expect(check(bare, [...FILES, "dist/package.json", "dist/fesm2022/x.mjs"])).toEqual([
      "no entry point: the manifest declares no exports, main or module",
    ]);
  });

  it("refuses every declared path the tarball does not contain", () => {
    const problems = check(GOOD, ["package.json", "LICENSE", "dist/index.cjs"]);
    expect(problems).toEqual([
      "types names ./dist/index.d.ts, which is not in the tarball",
      "exports > . > types names ./dist/index.d.ts, which is not in the tarball",
      "exports > . > import names ./dist/index.mjs, which is not in the tarball",
    ]);
  });

  it("checks bin and browser, and skips export patterns", () => {
    const m = {
      ...GOOD,
      bin: { x: "./bin/x.js" },
      browser: "./dist/b.js",
      exports: { "./*": "./dist/*.mjs" },
    };
    expect(check(m)).toEqual([
      "browser names ./dist/b.js, which is not in the tarball",
      "bin > x names ./bin/x.js, which is not in the tarball",
    ]);
  });
});

describe("files that never belong in a published tarball (#794 review)", () => {
  it.each([
    ".env",
    ".env.production",
    "dist/.env.local",
    ".npmrc",
    "certs/server.pem",
    "dist/signing.key",
    "release.p12",
    "id_rsa",
    "keys/id_ed25519.pub",
    "node_modules/x/index.js",
    ".git/config",
    "dist/__tests__/client.test.js",
    "tests/unit/x.js",
    "dist/fixtures/config.json",
    "dist/client.test.mjs",
    "dist/client.spec.d.ts",
  ])("refuses %s", (file) =>
    expect(check(GOOD, [...FILES, file])).toEqual([
      `${file}: a secret, a dependency tree, VCS data or a test file has no place in a published package`,
    ]),
  );
  it.each([
    "dist/testing.mjs",
    "dist/env.mjs",
    "dist/keyboard.js",
    "dist/latest.d.ts",
    "dist/contest.js",
  ])("accepts %s (a name that only looks alike)", (file) =>
    expect(check(GOOD, [...FILES, file])).toEqual([]),
  );
});

describe("the CLI", () => {
  const pack = (manifest, files) => {
    const dir = mkdtempSync(join(tmpdir(), "npm-tarball-"));
    for (const f of files) {
      mkdirSync(dirname(join(dir, "package", f)), { recursive: true });
      writeFileSync(join(dir, "package", f), f === "package.json" ? JSON.stringify(manifest) : "x");
    }
    spawnSync("tar", ["-czf", join(dir, "x.tgz"), "-C", dir, "package"]);
    return join(dir, "x.tgz");
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("exits 0 on a complete tarball", () => {
    const r = run(pack(GOOD, FILES), "@confeature/sdk-x", "0.1.0");
    expect(r.status, r.stderr).toBe(0);
  });

  it("exits 1 and names each problem", () => {
    const r = run(pack(GOOD, ["package.json", "LICENSE"]), "@confeature/sdk-x", "0.1.0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::main names ./dist/index.cjs, which is not in the tarball");
  });

  it("exits 2 on a missing argument or an unreadable tarball", () => {
    expect(run("x.tgz", "@confeature/sdk-x").status).toBe(2);
    expect(run(join(tmpdir(), "no-such.tgz"), "@confeature/sdk-x", "0.1.0").status).toBe(2);
  });
});
