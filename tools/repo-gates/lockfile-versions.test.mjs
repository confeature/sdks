// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvedVersions, snapshotDependency } from "./lockfile-versions.mjs";

// One @types/node for the whole workspace.
// With two resolved, pnpm's private hoist link
// (node_modules/.pnpm/node_modules/@types/node) points at whichever one the
// install order left there; undici-types reaches Node's types through it, so
// sdk-deno's program saw two global AbortSignal declarations (TS2741) on some
// fresh installs and not on others. The catalog entry plus the `overrides`
// entry in pnpm-workspace.yaml hold the lockfile to one version; this test is
// what notices when a dependency change brings a second one back.

const LOCKFILE = fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url));
const lockText = readFileSync(LOCKFILE, "utf8");

/** The lockfile with a second @types/node resolved beside the first. */
function withSecondVersion(text, version) {
  return text
    .replace(
      /^packages:\n/m,
      `packages:\n\n  '@types/node@${version}':\n    resolution: {integrity: sha512-x}\n`,
    )
    .replace(/^snapshots:\n/m, `snapshots:\n\n  '@types/node@${version}': {}\n`);
}

describe("the lockfile's @types/node", () => {
  it("resolves exactly one version", () => {
    const versions = resolvedVersions(lockText, "@types/node");
    expect(versions, "zero means this test reads nothing: check the lockfile path").not.toEqual([]);
    expect(
      versions,
      "a second @types/node resolves: see pnpm-workspace.yaml `overrides`",
    ).toHaveLength(1);
  });

  it("is refused when a second version is re-added (mutation)", () => {
    const [only] = resolvedVersions(lockText, "@types/node");
    const mutated = withSecondVersion(lockText, "24.12.4");
    expect(resolvedVersions(mutated, "@types/node").sort()).toEqual([only, "24.12.4"].sort());
  });
});

// bun-types reaches undici-types without declaring it.
// Its fetch.d.ts types Request, Headers and Response as
// `import("undici-types").Request` and so on, but its package.json depends only
// on `@types/node: "*"`. Under pnpm the import then resolves only through the
// private hoist link node_modules/.pnpm/node_modules/undici-types, and an
// incremental install that drops the undici-types version the link pointed at
// (#867 dropped 7.16.0) removes the link without re-creating it. sdk-bun's
// program then loses Request.url and Headers.get with no error at the import.
// The `packageExtensions` entry in pnpm-workspace.yaml declares the edge; this
// test notices when the lockfile stops carrying it, or when the extension's
// version and @types/node's stop being the same single copy.
describe("the lockfile's undici-types", () => {
  it("resolves exactly one version", () => {
    const versions = resolvedVersions(lockText, "undici-types");
    expect(versions, "zero means this test reads nothing: check the lockfile path").not.toEqual([]);
    expect(
      versions,
      "a second undici-types resolves: the bun-types packageExtensions range in pnpm-workspace.yaml must follow @types/node's",
    ).toHaveLength(1);
  });

  it("is a declared dependency of bun-types, the one @types/node uses", () => {
    const [bunTypes] = resolvedVersions(lockText, "bun-types");
    const [node] = resolvedVersions(lockText, "@types/node");
    expect(bunTypes, "no bun-types in the lockfile: this test reads nothing").toBeDefined();
    const fromBun = snapshotDependency(lockText, `bun-types@${bunTypes}`, "undici-types");
    expect(
      fromBun,
      "bun-types lost its undici-types edge: see pnpm-workspace.yaml `packageExtensions`",
    ).toBeDefined();
    expect(fromBun).toBe(snapshotDependency(lockText, `'@types/node@${node}'`, "undici-types"));
  });
});

describe("resolvedVersions", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    devDependencies:",
    "      '@types/node':",
    "        specifier: ^25",
    "        version: 25.7.0",
    "packages:",
    "  '@types/node@25.7.0':",
    "    resolution: {integrity: sha512-a}",
    "  '@types/node-forge@1.3.14':",
    "    resolution: {integrity: sha512-b}",
    "  vite@7.3.3:",
    "    resolution: {integrity: sha512-c}",
    "snapshots:",
    "  '@types/node@22.19.19': {}",
    "  vite@7.3.3(@types/node@25.7.0)(jiti@2.7.0):",
    "    optionalDependencies:",
    "      '@types/node': 25.7.0",
    "",
  ].join("\n");

  it("reads a scoped name from the package and snapshot keys, never a lookalike", () => {
    expect(resolvedVersions(lock, "@types/node").sort()).toEqual(["22.19.19", "25.7.0"]);
    expect(resolvedVersions(lock, "@types/node-forge")).toEqual(["1.3.14"]);
  });

  it("strips a snapshot's peer suffix from an unscoped name", () => {
    expect(resolvedVersions(lock, "vite")).toEqual(["7.3.3"]);
  });

  it("finds nothing in a lockfile without the package", () => {
    expect(resolvedVersions("lockfileVersion: '9.0'\n", "@types/node")).toEqual([]);
  });
});

describe("snapshotDependency", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "packages:",
    "  bun-types@1.3.14:",
    "    resolution: {integrity: sha512-a}",
    "snapshots:",
    "  '@types/node@25.7.0':",
    "    dependencies:",
    "      undici-types: 7.21.0",
    "",
    "  bun-types@1.3.14:",
    "    dependencies:",
    "      '@types/node': 25.7.0",
    "",
    "  vite@7.3.3(@types/node@25.7.0):",
    "    optionalDependencies:",
    "      undici-types: 7.21.0",
    "",
  ].join("\n");

  it("reads a dependency's version from one snapshot, scoped names included", () => {
    expect(snapshotDependency(lock, "'@types/node@25.7.0'", "undici-types")).toBe("7.21.0");
    expect(snapshotDependency(lock, "bun-types@1.3.14", "@types/node")).toBe("25.7.0");
  });

  it("never reads a neighbouring snapshot's dependency, nor the packages section", () => {
    expect(snapshotDependency(lock, "bun-types@1.3.14", "undici-types")).toBeUndefined();
  });

  it("finds nothing for a snapshot that is absent", () => {
    expect(snapshotDependency(lock, "bun-types@9.9.9", "@types/node")).toBeUndefined();
  });
});
