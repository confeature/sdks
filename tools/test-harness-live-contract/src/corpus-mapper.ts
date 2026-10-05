// SPDX-License-Identifier: MIT

/**
 * Corpus mapper — resolves a wire-cases.json case ID to its matching
 * seed file shipped in this package's `seeds/` directory.
 *
 * The mapping is `seeds/<caseId>.json`. We also surface a helper that
 * loads `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`
 * and asserts every case ID has a discoverable seed.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

// Resolve the package root from this module's URL — works under both
// `dist/` (compiled) and `src/` (vitest) layouts.
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here is .../tools/test-harness-live-contract/src OR /dist
  return pathResolve(here, "..");
}

/** The monorepo root — this package sits two levels below it. */
function workspaceRoot(): string {
  return pathResolve(packageRoot(), "..", "..");
}

export function caseToSeedPath(caseId: string): string {
  // Validate the ID shape — alphanum + hyphen, no slashes/dots.
  if (!/^[a-z0-9-]+$/.test(caseId)) {
    throw new Error(`invalid case id: ${caseId}`);
  }
  return pathResolve(packageRoot(), "seeds", `${caseId}.json`);
}

/**
 * Read `wire-cases.json` from the parity-fixtures package and return
 * the list of case IDs.
 */
export async function listWireCaseIds(wireCasesPath: string): Promise<string[]> {
  const raw = await readFile(wireCasesPath, "utf-8");
  const json = JSON.parse(raw) as { cases?: Array<{ id: string }> };
  if (!Array.isArray(json.cases)) {
    throw new Error(`wire-cases.json does not contain a 'cases' array`);
  }
  return json.cases.map((c) => c.id);
}

/**
 * Resolve the default path to wire-cases.json via the workspace dep.
 */
export function defaultWireCasesPath(): string {
  // Resolved from the WORKSPACE ROOT, not by adjacency. This used to walk one
  // level up and assume `test-fixtures-sdk-parity` was a sibling, which was
  // true only while both lived under `packages/`. #759 moved this harness to
  // `tools/` — it boots a deployable Worker in-process, so it is tooling, not a
  // shared library — and the sibling assumption broke on the move while every
  // other relative path survived, because `tools/x` and `packages/x` are both
  // two levels deep. Naming the real location makes the next relocation a
  // one-line change instead of a silent ENOENT.
  return pathResolve(
    workspaceRoot(),
    "packages",
    "test-fixtures-sdk-parity",
    "fixtures",
    "wire-cases.json",
  );
}
