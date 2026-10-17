#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Live-suite coverage of the SDK roster (#918, plan 867 FR-016; first spec
 * 115 / #150).
 *
 * Reads `dagger/sdk-manifest.json` only. Every SDK of the roster is one of:
 *   - live    : has a `liveSuite.runner`. Its leg in sdk-gates.yml runs it as
 *               a step after the suite (`live-suite --sdk <name>`), so whether
 *               it PASSES is that leg's result, judged on every push; this
 *               report says only that it runs;
 *   - exempt  : carries `liveExempt`, shown with its reason;
 *   - pending : neither — "no live suite yet". Counted in the denominator and
 *               listed, never shown as covered.
 *
 * Exemption is read from `liveExempt`, never from `status`: `status` says how
 * an SDK is published (swift is publish-exempt and still has a wire layer), so
 * reading it here would green-wash an SDK that simply has no live suite.
 *
 * Importable: `buildReport(manifest)` is pure. CLI:
 * `live-coverage-report.mjs [manifest-path]` prints the table (and appends it
 * to $GITHUB_STEP_SUMMARY when set); exit 0, or 2 when the manifest cannot be
 * read. It never fails on a pending SDK: the gap is shown, and closing it is
 * the follow-up children's work, not a red run.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const LIVE = "runs on every push (its leg's live-suite step)";
const PENDING = "▫ no live suite yet";

/**
 * @param {{ sdks: Array<{name:string, liveSuite?:{runner?:string}, liveExempt?:string}> }} manifest
 * @returns {{ rows: Array<{sdk:string,live:string,result:string}>, covered:number, exempt:number, pending:string[], total:number, headline:string, markdown:string }}
 */
export function buildReport(manifest) {
  const rows = [];
  const pending = [];
  let covered = 0;
  let exempt = 0;
  const total = manifest.sdks.length;

  for (const sdk of manifest.sdks) {
    if (typeof sdk.liveSuite?.runner === "string" && sdk.liveSuite.runner.trim() !== "") {
      covered += 1;
      rows.push({ sdk: sdk.name, live: "yes", result: LIVE });
    } else if (typeof sdk.liveExempt === "string" && sdk.liveExempt.trim() !== "") {
      exempt += 1;
      rows.push({ sdk: sdk.name, live: "—", result: `exempt: ${sdk.liveExempt}` });
    } else {
      pending.push(sdk.name);
      rows.push({ sdk: sdk.name, live: "no", result: PENDING });
    }
  }

  const headline = `Live suites — ${covered}/${total} SDKs run one on every push, ${exempt} exempt, ${pending.length} with no live suite yet`;
  const header = "| SDK | Live | Status |\n| --- | --- | --- |";
  const body = rows.map((r) => `| ${r.sdk} | ${r.live} | ${r.result} |`).join("\n");
  const markdown = `### ${headline}\n\n${header}\n${body}\n`;

  return { rows, covered, exempt, pending, total, headline, markdown };
}

// CLI entry — only when run directly, not when imported by the test.
if (process.argv[1] && resolve(process.argv[1]).endsWith("live-coverage-report.mjs")) {
  const manifestPath = process.argv[2] ?? "dagger/sdk-manifest.json";
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    process.stderr.write(
      `live-coverage-report: cannot read ${manifestPath} (${e?.message ?? e})\n`,
    );
    process.exit(2);
  }
  const report = buildReport(manifest);
  process.stdout.write(report.markdown + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown + "\n");
    } catch (e) {
      // The summary is a second copy of what stdout already carries.
      process.stderr.write(`live-coverage-report: step summary not written (${e?.message ?? e})\n`);
    }
  }
}
