#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Post-build bundle-size gate (SC-002 + SC-002b).
 *
 * Reads `dist/index.mjs`, gzips it in-memory, and asserts:
 *  - Total gzipped bytes ≤ 35 KB (35,840) — SC-002b hard ceiling.
 *  - "React layer alone" (total minus the published sdk-browser-js
 *    bundle weight) ≤ 5 KB (5,120) — SC-002 React-layer budget.
 *
 * Re-baselined 2026-06-01 (spec 117 / epic #382): the ConfigCat-parity
 * evaluation engine grew sdk-browser-js from ~15.8 KB → ~30 KB gzipped, so
 * BOTH the total ceiling (30→35 KB, still < configcat-js@9.6.1's 35.21 KB)
 * AND the browser-js baseline (15,795 → 30,129 bytes) are updated. The
 * React-layer-alone budget is unchanged at 5 KB — the wrapper itself
 * (Provider + hooks) is ~2.8 KB; the prior failure was entirely the stale
 * baseline attributing browser-js's growth to the layer.
 *
 * Exit code 1 on either failure so `vp pack`'s postbuild surfaces the
 * regression as a build error.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// SC-002b — hard ceiling on the total delivered bundle.
const TOTAL_BUDGET_BYTES = 35_840;
// React-layer-alone budget — total minus the gzipped size of the sdk-browser-js
// bundle it embeds must stay within REACT_LAYER_BUDGET_BYTES. That baseline is
// MEASURED from the built sdk-browser-js (#800): a hardcoded number went stale
// the moment browser-js shrank, and silently turned this budget off.
const REACT_LAYER_BUDGET_BYTES = 5_120;

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

const browserJsPath = resolve(here, "..", "..", "sdk-browser-js", "dist", "index.mjs");
let browserJsGzippedBytes;
try {
  browserJsGzippedBytes = gzipSync(readFileSync(browserJsPath)).length;
} catch (err) {
  console.error(
    `[bundle-size] ${browserJsPath} could not be read (${err?.message ?? err}) — build @confeature/sdk-browser-js first: the React-layer budget is measured against it.`,
  );
  process.exit(1);
}
if (gzipped.length < browserJsGzippedBytes) {
  // A negative layer means sdk-react no longer embeds this browser-js build (or
  // reads a stale one): the subtraction measures nothing, so fail, never clamp.
  console.error(
    `[bundle-size] the React bundle (${gzipped.length} B gz) is smaller than the sdk-browser-js bundle it should embed (${browserJsGzippedBytes} B gz) — rebuild both; the React-layer budget cannot be measured.`,
  );
  process.exit(1);
}

const rawKB = (raw.length / 1024).toFixed(2);
const gzKB = (gzipped.length / 1024).toFixed(2);
const totalBudgetKB = (TOTAL_BUDGET_BYTES / 1024).toFixed(2);
const reactBudgetKB = (REACT_LAYER_BUDGET_BYTES / 1024).toFixed(2);
const reactLayerBytes = gzipped.length - browserJsGzippedBytes;
const reactLayerKB = (reactLayerBytes / 1024).toFixed(2);

const failures = [];
if (gzipped.length > TOTAL_BUDGET_BYTES) {
  failures.push(
    `total ${gzKB} KB gzipped > ${totalBudgetKB} KB budget (SC-002b, raw: ${rawKB} KB)`,
  );
}
if (reactLayerBytes > REACT_LAYER_BUDGET_BYTES) {
  failures.push(
    `React layer alone ${reactLayerKB} KB gzipped > ${reactBudgetKB} KB budget (SC-002)`,
  );
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[bundle-size] FAIL: ${f}`);
  process.exit(1);
}

console.log(
  `[bundle-size] OK: total ${gzKB} KB ≤ ${totalBudgetKB} KB; ` +
    `React layer alone ${reactLayerKB} KB ≤ ${reactBudgetKB} KB.`,
);
