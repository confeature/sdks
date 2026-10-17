#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * When `sdk gates`, the one required check of `.github/workflows/sdk-gates.yml`,
 * is green (#793, FR-005). The one place that rule lives (plan 867 §5): no
 * workflow `if:` and no rule of verify-workflows.mjs restates it.
 *
 *   NEEDS_JSON='${{ toJSON(needs) }}' node tools/repo-gates/conclude-sdk-gates.mjs
 *
 * It reads `toJSON(needs)`, which carries the select job's result and its
 * outputs (the selection) beside each job kind's result, so the selection
 * reaches it through the same `env:` value and no second copy can disagree.
 * It takes no token: a matrix job reports one combined result to `needs`, so
 * each leg names itself in its own step summary and the run's job list shows
 * which leg is red; known-red legs run in their own job so that one combined
 * result is never counted (plan 867 A1).
 *
 * Green only when:
 *   - select succeeded, and every output it hands on is what select-sdks.mjs
 *     writes (JSON arrays of manifest names, known-red legs with a ticket);
 *   - each counted kind (KINDS) is `success` when its selection is non-empty
 *     and `skipped` when it is empty: `failure`, `cancelled`, a missing
 *     result, or a kind that ran with nothing selected is red;
 *   - no SDK is pending: a selected SDK with no leg yet is never green;
 *   - needs names no job this rule does not judge.
 * A known-red leg is shown with its ticket and never counted; one that passed
 * is shown as a waiver to remove, never as passing.
 *
 * Writes a table to $GITHUB_STEP_SUMMARY (when set) whose first line lists
 * the gate files the pull request changes, then names every red reason on
 * stderr. Exit codes: 0 green, 1 red, 2 NEEDS_JSON missing or unparsable (red).
 *
 * Zero dependencies on purpose: the aggregate runs it without an install.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";
import { KINDS, NAME, OUTPUT_KEYS, PLAIN_PATH, SELECT_JOB, TICKET } from "./select-sdks.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const quoted = (names) => names.map((n) => `\`${n}\``).join(", ");

/**
 * select's outputs, read back and checked: every selection array holds
 * manifest names only (gate and known-red legs as `{ name, daggerFn }`, a
 * known-red one with its ticket), and gate_files plain paths. Returns the
 * parsed outputs, or the reasons they cannot be trusted.
 */
function readSelection(outputs) {
  const problems = [];
  const sel = {};
  for (const key of OUTPUT_KEYS.filter((k) => k !== "summary")) {
    const raw = outputs?.[key];
    let v;
    try {
      v = JSON.parse(String(raw));
    } catch {
      problems.push(
        `select's output ${key} is not JSON (${raw === undefined ? "missing" : "unparsable"})`,
      );
      continue;
    }
    sel[key] = v;
  }
  for (const k of [...KINDS.map((x) => x.output), "pending"]) {
    const v = sel[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      problems.push(`select's output ${k} is not an array`);
      delete sel[k];
      continue;
    }
    const legs = k === "gate" || k === "known_red";
    const bad = v.filter((x) =>
      legs
        ? !isObject(x) ||
          typeof x.name !== "string" ||
          !NAME.test(x.name) ||
          (k === "known_red" && (typeof x.ticket !== "string" || !TICKET.test(x.ticket)))
        : typeof x !== "string" || !NAME.test(x),
    );
    if (bad.length > 0) {
      problems.push(
        `select's output ${k} holds ${bad.length} entr${bad.length === 1 ? "y" : "ies"} that are not manifest SDKs`,
      );
      delete sel[k];
    }
  }
  const gf = sel.gate_files;
  if (
    gf !== undefined &&
    (!isObject(gf) ||
      !Array.isArray(gf.files) ||
      !gf.files.every((f) => typeof f === "string" && PLAIN_PATH.test(f)) ||
      !Number.isInteger(gf.unnamed) ||
      gf.unnamed < 0)
  ) {
    problems.push("select's output gate_files is not a list of plain paths and a count");
    delete sel.gate_files;
  }
  const summary = typeof outputs?.summary === "string" ? outputs.summary : "";
  return { sel, summary, problems };
}

/** The first summary line: the gate files a pull request runs its own copy of (plan 867 S3). */
function gateFilesLine(gf) {
  if (gf === undefined) return "Gate files changed: unknown (select's output could not be read)";
  if (gf.files.length === 0 && gf.unnamed === 0) return "Gate files changed: none";
  const more =
    gf.unnamed > 0
      ? `${gf.files.length > 0 ? ", and " : ""}${gf.unnamed} ${gf.files.length > 0 ? "more " : ""}with a name not shown`
      : "";
  return `Gate files this pull request changes (its own copies judged this run): ${quoted(gf.files)}${more}`;
}

/**
 * The verdict over `toJSON(needs)`: `{ ok, problems, summary }`, the summary
 * being the markdown the step writes. Pure: the tests feed it objects.
 */
export function conclude(needs) {
  const problems = [];
  if (!isObject(needs)) {
    problems.push("NEEDS_JSON is not an object of jobs");
    return { ok: false, problems, summary: render(undefined, "", [], [], [], problems) };
  }
  const known = new Set([SELECT_JOB, ...KINDS.map((k) => k.job)]);
  for (const job of Object.keys(needs))
    if (!known.has(job)) problems.push(`${job}: a job conclude-sdk-gates does not judge`);
  const selectResult = needs[SELECT_JOB]?.result ?? "missing";
  if (selectResult !== "success") {
    problems.push(`select: ${selectResult}, so nothing was selected and nothing was judged`);
    return { ok: false, problems, summary: render(undefined, "", [], [], [], problems) };
  }
  const { sel, summary, problems: unreadable } = readSelection(needs[SELECT_JOB]?.outputs);
  problems.push(...unreadable);
  const rows = [];
  const knownRed = [];
  for (const kind of KINDS) {
    const selected = sel[kind.output];
    const result = needs[kind.job]?.result ?? "missing";
    if (selected === undefined) {
      rows.push({ job: kind.job, names: [], result, counted: kind.counted });
      continue;
    }
    const names = selected.map((x) => (typeof x === "string" ? x : x.name));
    rows.push({ job: kind.job, names, result, counted: kind.counted });
    if (names.length === 0) {
      if (result !== "skipped")
        problems.push(`${kind.job}: ${result}, but nothing was selected for it`);
      continue;
    }
    if (!kind.counted) {
      knownRed.push(...selected.map((x) => ({ name: x.name, ticket: x.ticket, result })));
      continue;
    }
    if (result !== "success")
      problems.push(`${kind.job}: ${result} (selected: ${names.join(", ")})`);
  }
  const pending = sel.pending ?? [];
  if (pending.length > 0) problems.push(`PENDING (no leg yet): ${pending.join(", ")}`);
  return {
    ok: problems.length === 0,
    problems,
    summary: render(sel.gate_files, summary, rows, knownRed, pending, problems),
  };
}

/** The step summary: gate files first, the verdict, the table, the waivers, the reasons. */
function render(gateFilesValue, selectSummary, rows, knownRed, pending, problems) {
  const lines = [gateFilesLine(gateFilesValue), ""];
  lines.push(`**sdk gates: ${problems.length === 0 ? "GREEN" : "RED"}**`, "");
  if (selectSummary !== "") lines.push(selectSummary, "");
  if (rows.length > 0) {
    lines.push("| Job | Selected | Result | Counted |", "| :-- | :-- | :-- | :-- |");
    for (const r of rows)
      lines.push(
        `| ${r.job} | ${r.names.length === 0 ? "none" : quoted(r.names)} | ${r.result} | ${r.counted ? "yes" : "no (known red)"} |`,
      );
    lines.push("");
  }
  if (knownRed.length > 0) {
    lines.push(`KNOWN RED (${knownRed.length}), shown and not counted:`, "");
    for (const k of knownRed)
      lines.push(
        `- \`${k.name}\` (${k.ticket}): ${k.result === "success" ? "its leg passed; remove its ci.knownRed" : k.result}`,
      );
    lines.push("");
  }
  if (pending.length > 0)
    lines.push(
      `PENDING (no leg yet) (${pending.length}): ${quoted(pending)}. Never green: each is red until its leg lands.`,
      "",
    );
  if (problems.length > 0) {
    lines.push("Red because:", "");
    for (const p of problems) lines.push(`- ${p}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  let status;
  let result;
  try {
    result = conclude(JSON.parse(process.env.NEEDS_JSON ?? ""));
    status = result.ok ? 0 : 1;
  } catch (e) {
    const problems = [`NEEDS_JSON is missing or does not parse (${e?.message ?? e})`];
    result = { ok: false, problems, summary: render(undefined, "", [], [], [], problems) };
    status = 2;
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
  for (const p of result.problems) console.error(`sdk gates: ${p}`);
  console.log(`sdk gates: ${status === 0 ? "green" : "red"}`);
  return status;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
