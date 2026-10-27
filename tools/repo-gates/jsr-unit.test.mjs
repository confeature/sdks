// SPDX-License-Identifier: MIT

// The JSR target of a publish unit (#935): tools/sdk-pack/jsr-unit.mjs over
// the real repository, and over fixtures that break each rule once.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jsrProblems, specifiers } from "../sdk-pack/jsr-unit.mjs";
import { declaredVersion, resolvePublish } from "../sdk-pack/resolve-publish.mjs";
import { jsrFindings } from "./verify-workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "dagger/sdk-manifest.json"), "utf8"));
const declared = (root) => (u) => declaredVersion(u, root, undefined);

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PATTERN = '^  "version": "([^"]+)",$';
const src = (file) => ({ file, pattern: PATTERN });
const pkg = (name, version) => `{\n  "name": "${name}",\n  "version": "${version}",\n}\n`;
const SHARED = {
  name: "shared",
  registry: "npm",
  coordinates: "@xy/shared",
  path: "packages/shared",
  versionSource: src("packages/shared/package.json"),
  after: [],
  gateFn: "shared-test",
};
const PRIMARY = {
  name: "deno",
  gate: "deno",
  registry: "npm",
  coordinates: "@xy/sdk-deno",
  path: "apps/sdk-deno",
  versionSource: src("apps/sdk-deno/package.json"),
  after: ["shared"],
};
const JSR = {
  name: "deno",
  registry: "jsr",
  coordinates: "@xy/sdk-deno",
  path: "apps/sdk-deno",
  versionSource: src("apps/sdk-deno/package.json"),
};
const CONFIG = {
  name: "@xy/sdk-deno",
  version: "1.2.3",
  license: "MIT",
  exports: "./src/index.ts",
  publish: { include: ["jsr.json", "src/**/*.ts"] },
};
const INDEX = `/** import { a } from "@xy/sdk-deno"; */\n// import { b } from "nowhere";\nimport { c } from "@confeature/sdk-shared";\nexport { d } from "./d.ts";\nimport { readFileSync } from "node:fs";\n`;

/** A fixture repository: the manifest, both package.json files, jsr.json and src/. */
function fixture({
  publish = [SHARED, PRIMARY, JSR],
  config = CONFIG,
  index = INDEX,
  files = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "jsr-unit-"));
  dirs.push(root);
  const write = (f, text) => {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  };
  write("packages/shared/package.json", pkg("@xy/shared", "0.4.0"));
  write("apps/sdk-deno/package.json", pkg("@xy/sdk-deno", "1.2.3"));
  if (config !== null) write("apps/sdk-deno/jsr.json", JSON.stringify(config, null, 2));
  write("apps/sdk-deno/src/index.ts", index);
  write("apps/sdk-deno/src/d.ts", "export const d = 1;\n");
  for (const [f, text] of Object.entries(files)) write(f, text);
  const manifest = { tagFormat: "sdk-{name}-v{version}", sdks: [], publish };
  write("dagger/sdk-manifest.json", JSON.stringify(manifest));
  return { root, manifest };
}
const problems = (opts) => {
  const { root, manifest } = fixture(opts);
  return jsrProblems(manifest, root, declared(root));
};

describe("the repository's JSR target", () => {
  it("passes: apps/sdk-deno/jsr.json is the deno unit's, at its declared version", () => {
    expect(jsrProblems(MANIFEST, ROOT, declared(ROOT))).toEqual([]);
    expect(jsrFindings(MANIFEST, ROOT)).toEqual([]);
  });
  it("the deno unit carries a jsr entry with the npm entry's path and version source", () => {
    const deno = MANIFEST.publish.filter((u) => u.name === "deno");
    expect(deno.map((u) => u.registry)).toEqual(["npm", "jsr"]);
    expect(deno[1].path).toBe(deno[0].path);
    expect(deno[1].versionSource).toEqual(deno[0].versionSource);
  });
  it("the resolver emits the JSR package for the deno unit, and nothing for another", async () => {
    const deno = await resolvePublish({ root: ROOT, unit: "deno" });
    expect(deno.registry).toBe("npm");
    expect(deno.jsr).toBe("@confeature/sdk-deno");
    expect((await resolvePublish({ root: ROOT, unit: "node" })).jsr).toBe("");
  });
});

describe("a fixture that keeps every rule passes", () => {
  it("has no problem", () => expect(problems()).toEqual([]));
  it("reads specifiers past comments", () =>
    expect(specifiers(INDEX)).toEqual(["@confeature/sdk-shared", "./d.ts", "node:fs"]));
});

describe("fails closed on", () => {
  const one = (opts, re) => {
    const got = problems(opts);
    expect(got.length, JSON.stringify(got)).toBeGreaterThan(0);
    expect(got.join("\n")).toMatch(re);
  };
  it("a jsr.json version that drifts from the unit's versionSource", () =>
    one({ config: { ...CONFIG, version: "1.2.4" } }, /drifts from 1\.2\.3/));
  it("a missing jsr.json", () => one({ config: null }, /cannot read apps\/sdk-deno\/jsr\.json/));
  it("a jsr.json of another package", () =>
    one({ config: { ...CONFIG, name: "@xy/other" } }, /names "@xy\/other"/));
  it("a license other than MIT", () => one({ config: { ...CONFIG, license: "ISC" } }, /not MIT/));
  it("an unknown jsr.json key", () => one({ config: { ...CONFIG, scripts: {} } }, /has scripts/));
  it("exports into dist/", () =>
    one({ config: { ...CONFIG, exports: "./dist/index.mjs" } }, /not TypeScript source under/));
  it("exports of a file that does not exist", () =>
    one({ config: { ...CONFIG, exports: { ".": "./src/gone.ts" } } }, /does not exist/));
  it("no exports", () => one({ config: { ...CONFIG, exports: {} } }, /exports nothing/));
  it("an npm: mapping of the bundled workspace unit (ruling (a): bundle, never a registry)", () =>
    one(
      {
        config: {
          ...CONFIG,
          imports: { "@confeature/sdk-shared": "npm:@confeature/sdk-shared@0.1.0" },
        },
      },
      /maps imports; a workspace unit is bundled/,
    ));
  it("any imports at all: the stager writes the one mapping", () =>
    one(
      { config: { ...CONFIG, imports: { "@confeature/sdk-shared": "./src/_shared/index.ts" } } },
      /maps imports/,
    ));
  it("an npm: specifier in the source", () =>
    one(
      { index: `${INDEX}import { z } from "npm:zod@3";\n` },
      /imports npm:zod@3, which is neither/,
    ));
  it("a jsr: specifier in the source", () =>
    one({ index: `${INDEX}import { z } from "jsr:@std/path@1";\n` }, /imports jsr:@std\/path@1/));
  it("a node: built-in that is not listed", () =>
    one(
      { index: `${INDEX}import { z } from "node:child_process";\n` },
      /imports node:child_process/,
    ));
  it("a relative import that does not name a .ts file", () =>
    one({ index: `${INDEX}import { z } from "./d.js";\n` }, /does not name a \.ts file/));
  it("a bare specifier", () =>
    one({ index: `${INDEX}import { z } from "zod";\n` }, /imports zod, which is neither/));
  it("exports outside src/", () =>
    one({ config: { ...CONFIG, exports: "./lib/index.ts" } }, /not TypeScript source under/));
  it("a jsr entry with no primary", () =>
    one({ publish: [SHARED, JSR] }, /follows the unit's primary entry/));
  it("a jsr entry before its primary", () =>
    one({ publish: [SHARED, JSR, PRIMARY] }, /follows the unit's primary entry/));
  it("a jsr entry with a key of its own", () =>
    one({ publish: [SHARED, PRIMARY, { ...JSR, after: ["shared"] }] }, /not exactly/));
  it("a jsr entry with a path of its own", () =>
    one({ publish: [SHARED, PRIMARY, { ...JSR, path: "apps/other" }] }, /is not the primary's/));
  it("a jsr entry with a version source of its own", () =>
    one(
      {
        publish: [SHARED, PRIMARY, { ...JSR, versionSource: src("packages/shared/package.json") }],
      },
      /versionSource differs/,
    ));
  it("coordinates that are not a JSR package name", () =>
    one(
      { publish: [SHARED, PRIMARY, { ...JSR, coordinates: "sdk-deno" }] },
      /not a JSR package name/,
    ));
  it("two jsr entries of one unit", () =>
    one({ publish: [SHARED, PRIMARY, JSR, JSR] }, /two jsr entries/));
  it("two primaries sharing a name", () =>
    one({ publish: [SHARED, PRIMARY, { ...PRIMARY, registry: "pypi" }, JSR] }, /only a jsr entry/));
  it("and the resolver refuses the unit's dry run on the same drift", async () => {
    const { root } = fixture({ config: { ...CONFIG, version: "9.9.9" } });
    const manifest = JSON.parse(readFileSync(join(root, "dagger/sdk-manifest.json"), "utf8"));
    manifest.sdks = [{ name: "deno", status: "exempt" }];
    writeFileSync(join(root, "dagger/sdk-manifest.json"), JSON.stringify(manifest));
    await expect(resolvePublish({ root, unit: "deno" })).rejects.toThrow(/drifts from 1\.2\.3/);
  });
});
