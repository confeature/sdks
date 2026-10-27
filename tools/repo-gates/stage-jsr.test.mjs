// SPDX-License-Identifier: MIT

// tools/sdk-pack/stage-jsr.mjs (#935, architect ruling (b)): the staged JSR
// package is exactly the unit's source plus the bundled sdk-shared source, out
// of the tree, and every refusal is a case here. Deterministic: no deno runs
// (pack-jsr's live dry run is the run that proves deno's own checks).

import {
  cpSync,
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
import { afterEach, describe, expect, it } from "vitest";
import { byName, listFiles, stageJsr } from "../sdk-pack/stage-jsr.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "apps/sdk-deno/package.json"), "utf8")).version;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "stage-jsr-"));
  dirs.push(d);
  return d;
};
const out = () => join(scratch(), "stage");

/** A copy of the parts of the repository the stager reads, to break one at a time. */
function copyRoot() {
  const root = scratch();
  for (const p of [
    "dagger/sdk-manifest.json",
    "LICENSE",
    "apps/sdk-deno/package.json",
    "apps/sdk-deno/jsr.json",
    "apps/sdk-deno/README.md",
    "apps/sdk-deno/src",
    "packages/sdk-shared/package.json",
    "packages/sdk-shared/src",
  ])
    cpSync(join(ROOT, p), join(root, p), { recursive: true });
  return root;
}
const edit = (root, file, fn) =>
  writeFileSync(join(root, file), fn(readFileSync(join(root, file), "utf8")));
const stage = (root, o = out(), version = VERSION) =>
  stageJsr({ root, unit: "deno", version, out: o });

describe("the repository's deno unit stages", () => {
  it("exactly its source, the bundled sdk-shared source, jsr.json, README and LICENSE", () => {
    const o = out();
    const files = stage(ROOT, o);
    const own = listFiles(join(ROOT, "apps/sdk-deno/src")).map((f) => `src/${f}`);
    const shared = listFiles(join(ROOT, "packages/sdk-shared/src"))
      .filter((f) => !f.endsWith(".test.ts"))
      .map((f) => `src/_shared/${f}`);
    expect(files).toEqual(["LICENSE", "README.md", "jsr.json", ...own, ...shared].sort(byName));
    expect(files.some((f) => /package\.json|node_modules|deno\.lock|\.test\.ts$/.test(f))).toBe(
      false,
    );
    const cfg = JSON.parse(readFileSync(join(o, "jsr.json"), "utf8"));
    expect(cfg.imports).toEqual({ "@confeature/sdk-shared": "./src/_shared/index.ts" });
    expect(cfg.version).toBe(VERSION);
    expect(readFileSync(join(o, "src/_shared/index.ts"), "utf8")).toBe(
      readFileSync(join(ROOT, "packages/sdk-shared/src/index.ts"), "utf8"),
    );
  });
  it("into an existing empty directory", () => {
    const o = out();
    mkdirSync(o);
    expect(stage(ROOT, o).length).toBeGreaterThan(3);
  });
});

describe("refuses", () => {
  const refused = (fn, re) => expect(fn).toThrow(re);
  it("a --version other than the one the unit declares", () =>
    refused(() => stage(ROOT, out(), "9.9.9"), /--version 9\.9\.9 differs/));
  it("a jsr.json whose version drifts from the versionSource", () => {
    const root = copyRoot();
    edit(root, "apps/sdk-deno/jsr.json", (t) =>
      t.replace(`"version": "${VERSION}"`, '"version": "9.9.9"'),
    );
    refused(() => stage(root), /drifts from/);
  });
  it("an --out that is not empty", () => {
    const o = out();
    mkdirSync(o);
    writeFileSync(join(o, "x"), "");
    refused(() => stage(ROOT, o), /exists and is not empty/);
  });
  it("an --out inside the repository", () =>
    refused(() => stage(ROOT, join(ROOT, "tmp-stage-never")), /inside the repository/));
  it("an npm: import injected in the unit's source", () => {
    const root = copyRoot();
    edit(root, "apps/sdk-deno/src/index.ts", (t) => `${t}\nexport { z } from "npm:zod@3";\n`);
    refused(() => stage(root), /npm:zod@3, which is neither/);
  });
  it("a bare import injected in the bundled source", () => {
    const root = copyRoot();
    edit(root, "packages/sdk-shared/src/index.ts", (t) => `${t}\nimport "lodash";\n`);
    refused(() => stage(root), /src\/_shared\/index\.ts imports lodash/);
  });
  it("a jsr.json that maps sdk-shared to npm 0.1.0", () => {
    const root = copyRoot();
    edit(root, "apps/sdk-deno/jsr.json", (t) =>
      t.replace(
        /\n}\s*$/,
        ',\n  "imports": { "@confeature/sdk-shared": "npm:@confeature/sdk-shared@0.1.0" }\n}\n',
      ),
    );
    refused(() => stage(root), /maps imports; a workspace unit is bundled/);
  });
  it("a missing bundled source (no sdk-shared src/)", () => {
    const root = copyRoot();
    rmSync(join(root, "packages/sdk-shared/src"), { recursive: true });
    refused(() => stage(root), /@confeature\/sdk-shared: .* does not exist/);
  });
  it("a relative import that leaves the stage (no _shared to resolve)", () => {
    const root = copyRoot();
    edit(root, "apps/sdk-deno/src/index.ts", (t) => `${t}\nexport * from "../../x.ts";\n`);
    refused(() => stage(root), /which is not a staged file/);
  });
  it("a non-TypeScript file in a copied tree (a stray node_modules)", () => {
    const root = copyRoot();
    mkdirSync(join(root, "apps/sdk-deno/src/node_modules/x"), { recursive: true });
    writeFileSync(join(root, "apps/sdk-deno/src/node_modules/x/package.json"), "{}");
    refused(() => stage(root), /node_modules\/x\/package\.json is not TypeScript source/);
  });
  it("a unit that already has src/_shared", () => {
    const root = copyRoot();
    mkdirSync(join(root, "apps/sdk-deno/src/_shared"));
    writeFileSync(join(root, "apps/sdk-deno/src/_shared/a.ts"), "export {};\n");
    refused(() => stage(root), /already has src\/_shared/);
  });
  it("a unit with no jsr entry", () =>
    expect(() => stageJsr({ root: ROOT, unit: "node", version: "0.1.0", out: out() })).toThrow(
      /has no jsr entry/,
    ));
  it("and stages nothing on a refusal before copying", () => {
    const o = out();
    refused(() => stage(ROOT, o, "9.9.9"), /differs/);
    expect(existsSync(o)).toBe(false);
  });
});
