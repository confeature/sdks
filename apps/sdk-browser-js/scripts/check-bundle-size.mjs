#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Post-build bundle-size gate (SC-002).
 *
 * Reads `dist/index.mjs`, gzips it in-memory, asserts the gzipped byte
 * count is at or below 35 KB (35,840 bytes). On failure, exits with
 * code 1 so the surrounding `vp pack` / CI invocation surfaces it as
 * a build error.
 *
 * Why ≤ 35 KB (2026-10-01, #800): back UNDER configcat-js@9.6.1 (35.21 KB
 * gzipped, the same engine + eval-log), like every other SDK budget. The 37 KB
 * of #498 / ADR 0003 made room for the shared engine's JSDoc, which shipped in
 * the JS and was half of every gzipped byte; the JS now ships without it
 * (`tools/sdk-pack/comments.mjs`) and sits near 19 KB. Re-measure configcat-js
 * on a major bump.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BUDGET_BYTES = 35_840;

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, "..", "dist", "index.mjs");

try {
  statSync(bundlePath);
} catch {
  console.error(`[bundle-size] ${bundlePath} not found — did you run 'vp pack'?`);
  process.exit(1);
}

const raw = readFileSync(bundlePath);
const gzipped = gzipSync(raw);

const rawKB = (raw.length / 1024).toFixed(2);
const gzKB = (gzipped.length / 1024).toFixed(2);
const budgetKB = (BUDGET_BYTES / 1024).toFixed(2);

if (gzipped.length > BUDGET_BYTES) {
  console.error(
    `[bundle-size] FAIL: ${gzKB} KB gzipped > ${budgetKB} KB budget ` +
      `(raw: ${rawKB} KB). See SC-002 in spec 031.`,
  );
  process.exit(1);
}

console.log(
  `[bundle-size] OK: ${gzKB} KB gzipped ≤ ${budgetKB} KB budget ` + `(raw: ${rawKB} KB).`,
);
