// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvedVersions } from "./lockfile-versions.mjs";

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
