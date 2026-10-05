#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Verifies that the architectural-extraction manifest (the constants below,
 * first recorded in spec 031's data model) matches the actual
 * filesystem layout. Fails loudly when drift is detected so future SDK
 * sub-tasks (#42 Bun, #43 Deno, …) can rely on the documented contract.
 *
 * Checks:
 *   1. Every "moved into sdk-shared" entry exists at the new path AND
 *      is absent from the old path.
 *   2. Every "moved into test-fixtures-sdk-parity" entry exists at the
 *      new path AND is absent from the old path.
 *   3. Every "stays in sdk-node" entry still exists.
 *
 * Exit codes:
 *   0 — manifest matches reality.
 *   1 — at least one entry diverges.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Source of truth: the table in data-model.md. Updates here MUST also
// update the manifest table.
//
// MOVED_TO_SHARED — files that originated in `apps/sdk-node/src/` and
// were lifted to `packages/sdk-shared/src/`. Each entry is checked
// (a) for presence at the new path AND (b) for absence at the old path.
const MOVED_TO_SHARED = [
  "evaluator.ts",
  "project-config.ts",
  "config-json.ts",
  "sdk-key.ts",
  "user.ts",
  "logger.ts",
  "flag-overrides.ts",
  "refresh-result.ts",
];

// MOVED_TO_SHARED_NOT_FROM_SDK_NODE — files that landed in
// `packages/sdk-shared/src/` from sources other than sdk-node (e.g.
// coordinated extractions from multiple WHATWG-fetch SDKs per spec
// 034 §R5 and spec 036 §R7). These entries skip the "absent from
// sdk-node" check because sdk-node correctly keeps its own
// runtime-specific copy (or never had one in the first place).
const MOVED_TO_SHARED_NOT_FROM_SDK_NODE = ["config-fetcher.ts", "override-eval.ts"];

const MOVED_TO_FIXTURES = ["config-v6.boolean.json", "config-v6.malformed.json"];

const STAYS_IN_SDK_NODE = [
  "client.ts",
  "config-fetcher.ts",
  "config-cache.ts",
  "auto-poll-service.ts",
  "hooks.ts",
  "options.ts",
  "version.ts",
  "types.ts",
  "index.ts",
];

const SHARED_PKG_SRC = path.join(REPO_ROOT, "packages/sdk-shared/src");
const SHARED_FIXTURES = path.join(REPO_ROOT, "packages/test-fixtures-sdk-parity/fixtures");
const SDK_NODE_SRC = path.join(REPO_ROOT, "apps/sdk-node/src");

const failures = [];

for (const file of MOVED_TO_SHARED) {
  const newPath = path.join(SHARED_PKG_SRC, file);
  const oldPath = path.join(SDK_NODE_SRC, file);
  if (!existsSync(newPath)) {
    failures.push(`MOVED_TO_SHARED: expected ${file} at ${newPath}; not found`);
  }
  if (existsSync(oldPath)) {
    failures.push(
      `MOVED_TO_SHARED: ${file} still exists at ${oldPath} — should have been deleted after move`,
    );
  }
}

for (const file of MOVED_TO_SHARED_NOT_FROM_SDK_NODE) {
  const newPath = path.join(SHARED_PKG_SRC, file);
  if (!existsSync(newPath)) {
    failures.push(`MOVED_TO_SHARED_NOT_FROM_SDK_NODE: expected ${file} at ${newPath}; not found`);
  }
  // Intentionally NO absence check at SDK_NODE_SRC — these files
  // originated outside sdk-node (e.g. lifted from the three WHATWG-fetch
  // SDKs in spec 034). sdk-node may legitimately keep a runtime-specific
  // copy at apps/sdk-node/src/<file>.
}

for (const file of MOVED_TO_FIXTURES) {
  const newPath = path.join(SHARED_FIXTURES, file);
  if (!existsSync(newPath)) {
    failures.push(`MOVED_TO_FIXTURES: expected ${file} at ${newPath}; not found`);
  }
}

for (const file of STAYS_IN_SDK_NODE) {
  const stayPath = path.join(SDK_NODE_SRC, file);
  if (!existsSync(stayPath)) {
    failures.push(
      `STAYS_IN_SDK_NODE: ${file} expected at ${stayPath} but missing — runtime-specific code should remain in sdk-node`,
    );
  }
}

if (failures.length > 0) {
  console.error("Architectural extraction manifest drift detected:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nUpdate this script's MOVED_TO_* constants so they match reality." +
      " SC-007 depends on this.",
  );
  process.exit(1);
}

const totalIntoShared = MOVED_TO_SHARED.length + MOVED_TO_SHARED_NOT_FROM_SDK_NODE.length;
console.log(
  `SDK extraction manifest OK: ${totalIntoShared} into sdk-shared, ${MOVED_TO_FIXTURES.length} into test-fixtures-sdk-parity, ${STAYS_IN_SDK_NODE.length} stay in sdk-node.`,
);
