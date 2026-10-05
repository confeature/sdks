#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Live-contract conformance report (spec 115 / #150, sub-task D).
 *
 * Reads the SDK roster from `dagger/sdk-manifest.json` and the per-job result
 * artifacts (`live-result-<sdk>.json`, data-model §2), and builds the per-SDK
 * conformance table + `N/<roster> live-covered` headline (data-model §3).
 *
 * Classification:
 *   - exempt  : manifest status === "exempt"            (swift, unreal)
 *   - pass    : has liveSuite AND result.status === "pass"
 *   - fail    : has liveSuite AND (result missing OR result.status === "fail")
 *   - pending : no liveSuite, not exempt                (burn-down — never green, never red)
 *
 * Exit: non-zero iff any SDK is `fail`. A `pending` SDK never fails the run
 * (FR-004 — burn-down, not false-green and not false-red).
 *
 * Importable: `buildReport(manifest, results)` is pure for unit testing (T011).
 * CLI: `live-coverage-report.mjs <results-dir> [manifest-path]`.
 */

import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PASS = "✓ pass";
const FAIL = "✗ fail";
const PENDING = "▫ pending (no live suite yet)";
const EXEMPT = "exempt";

/**
 * @param {{ sdks: Array<{name:string,status:string,liveSuite?:object}> }} manifest
 * @param {Map<string,{status:string}>} results  sdk name → result artifact
 * @returns {{ rows: Array<{sdk:string,live:string,result:string}>, covered:number, total:number, failed:string[], headline:string, markdown:string }}
 */
export function buildReport(manifest, results) {
  const rows = [];
  const failed = [];
  let covered = 0;
  const total = manifest.sdks.length;

  for (const sdk of manifest.sdks) {
    if (sdk.status === "exempt") {
      rows.push({ sdk: sdk.name, live: "—", result: EXEMPT });
      continue;
    }
    if (!sdk.liveSuite) {
      rows.push({ sdk: sdk.name, live: "no", result: PENDING });
      continue;
    }
    const r = results.get(sdk.name);
    if (r && r.status === "pass") {
      covered += 1;
      rows.push({ sdk: sdk.name, live: "yes", result: PASS });
    } else {
      failed.push(sdk.name);
      rows.push({ sdk: sdk.name, live: "yes", result: FAIL });
    }
  }

  const headline = `Live contract conformance — ${covered}/${total} live-covered`;
  const header = "| SDK | Live | Result |\n| --- | --- | --- |";
  const body = rows.map((r) => `| ${r.sdk} | ${r.live} | ${r.result} |`).join("\n");
  const markdown = `### ${headline}\n\n${header}\n${body}\n`;

  return { rows, covered, total, failed, headline, markdown };
}

/** Load all `live-result-*.json` from a directory into a name→result map. */
export function loadResults(dir) {
  const map = new Map();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return map; // no results dir → everything pending/fail per the manifest
  }
  for (const f of entries) {
    if (!/^live-result-.*\.json$/.test(f)) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      if (data && typeof data.sdk === "string") map.set(data.sdk, data);
    } catch {
      // skip unparseable result; the SDK will read as fail if it has a liveSuite
    }
  }
  return map;
}

// CLI entry — only when run directly, not when imported by the test.
if (process.argv[1] && resolve(process.argv[1]).endsWith("live-coverage-report.mjs")) {
  const resultsDir = process.argv[2] ?? "live-results";
  const manifestPath = process.argv[3] ?? "dagger/sdk-manifest.json";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const results = loadResults(resultsDir);
  const report = buildReport(manifest, results);

  process.stdout.write(report.markdown + "\n");
  // Append to the GitHub step summary when running in Actions (best-effort).
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown + "\n");
    } catch {
      /* summary is non-critical */
    }
  }
  if (report.failed.length > 0) {
    process.stderr.write(`Live conformance FAILED for: ${report.failed.join(", ")}\n`);
    process.exit(1);
  }
}
