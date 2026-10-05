#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Post-build bundle-size gate (SC-002).
 *
 * Reads `dist/index.mjs`, gzips it in-memory, asserts the gzipped byte
 * count is at or below 33 KB (33,792 bytes). On failure, exits with
 * code 1 so the surrounding `vp pack` / CI invocation surfaces it as
 * a build error.
 *
 * Why ≤ 33 KB (re-baselined 2026-06-01, spec 117/#382): the 25 KB budget predated the real evaluation engine (now ~+13 KB gz); configcat-js@9.6.1 is 35.21 KB gz, so Confeature at ~30 KB stays leaner than the parity target. Budget MUST stay < configcat-js size.
 * spec SC-002 allows up to +15% to absorb the per-runtime adapter
 * code without losing the "we don't bloat your bundle" pitch.
 *
 * This file is a direct clone of `apps/sdk-browser-js/scripts/check-bundle-size.mjs`
 * — the bundle-size policy is identical across runtimes.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BUDGET_BYTES = 33_792;

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
      `(raw: ${rawKB} KB). See SC-002 in spec 032.`,
  );
  process.exit(1);
}

console.log(
  `[bundle-size] OK: ${gzKB} KB gzipped ≤ ${budgetKB} KB budget ` + `(raw: ${rawKB} KB).`,
);
