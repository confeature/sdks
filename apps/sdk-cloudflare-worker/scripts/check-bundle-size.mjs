#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Post-build bundle-size gate (SC-005).
 *
 * Reads `dist/index.mjs`, gzips it in-memory, asserts the gzipped byte
 * count is at or below 15 KB (15,360 bytes). On failure, exits with
 * code 1 so the surrounding `vp pack` / CI invocation surfaces it as
 * a build error.
 *
 * Why ≤ 15 KB: the Cloudflare Worker SDK is a thin wrapper on top of
 * `@confeature/sdk-browser-js` (peer-imported, not bundled). Marginal
 * code = the KV cache adapter + the `getConfeatureClient` factory + a
 * re-export barrel — well under 15 KB gzipped.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BUDGET_BYTES = 15_360;

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
      `(raw: ${rawKB} KB). See SC-005 in spec 042.`,
  );
  process.exit(1);
}

console.log(
  `[bundle-size] OK: ${gzKB} KB gzipped ≤ ${budgetKB} KB budget ` + `(raw: ${rawKB} KB).`,
);
