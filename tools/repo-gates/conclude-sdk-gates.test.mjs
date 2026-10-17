// SPDX-License-Identifier: MIT

// The aggregate of sdk-gates.yml (conclude-sdk-gates.mjs): `sdk gates` is
// green only when every job kind's result matches its selection, a known-red
// leg is shown and never counted, and anything
// it cannot read is red.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { conclude } from "./conclude-sdk-gates.mjs";
import { KINDS } from "./select-sdks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools/repo-gates/conclude-sdk-gates.mjs");

const NONE = { files: [], unnamed: 0 };
/** select's outputs, as the workflow hands them on: every value a string. */
const outputs = ({
  gate = [],
  known_red = [],
  swift = [],
  smoke = [],
  gate_files = NONE,
  summary = "push: every SDK selected (21)",
} = {}) => ({
  gate: JSON.stringify(gate),
  known_red: JSON.stringify(known_red),
  swift: JSON.stringify(swift),
  smoke: JSON.stringify(smoke),
  gate_files: JSON.stringify(gate_files),
  summary,
});
/** toJSON(needs): select's result and outputs, and each kind's result. */
const needs = (sel = {}, results = {}, selectResult = "success") => ({
  select: { result: selectResult, outputs: outputs(sel) },
  ...Object.fromEntries(
    KINDS.map((k) => [k.job, { result: results[k.job] ?? "skipped", outputs: {} }]),
  ),
});
const NODE = { name: "node", daggerFn: "js-test" };
const RUST_RED = { name: "rust", daggerFn: "rust-test", ticket: "#806" };
/** One selected SDK for each kind, the shape its output carries. */
const ONE = { gate: [NODE], known_red: [RUST_RED], swift: ["swift"], smoke: ["unreal"] };

describe("the pass rule, every result for every kind", () => {
  const RESULTS = ["success", "failure", "cancelled", "skipped", "missing"];
  const cases = KINDS.flatMap((k) =>
    RESULTS.flatMap((r) => [
      [k.job, "selected", r],
      [k.job, "not selected", r],
    ]),
  );
  it.each(cases)("%s %s, result %s", (job, selected, result) => {
    const kind = KINDS.find((k) => k.job === job);
    const sel = selected === "selected" ? { [kind.output]: ONE[kind.output] } : {};
    const n = needs(sel);
    if (result === "missing") delete n[job];
    else n[job].result = result;
    const got = conclude(n);
    // A known-red leg is never counted, whatever its result, once selected.
    const want =
      selected === "selected" ? !kind.counted || result === "success" : result === "skipped";
    expect(got.ok, got.problems.join("\n")).toBe(want);
    if (!want) expect(got.problems.join("\n")).toContain(job);
  });
});

describe("the aggregate", () => {
  it("is green on a full, passing selection", () => {
    const got = conclude(needs({ gate: [NODE] }, { gate: "success" }));
    expect(got.ok).toBe(true);
    expect(got.summary).toMatch(/sdk gates: GREEN/);
  });

  it("is red, naming the kind, when a kind ran although nothing was selected", () => {
    const got = conclude(needs({}, { gate: "success" }));
    expect(got.ok).toBe(false);
    expect(got.problems.join()).toMatch(/gate: success, but nothing was selected for it/);
  });

  it.each(["failure", "cancelled", "skipped"])("is red when select is %s", (r) => {
    const got = conclude(needs({}, {}, r));
    expect(got.ok).toBe(false);
    expect(got.problems.join()).toMatch(new RegExp(`select: ${r}`));
  });

  it("is red when select's result is missing", () => {
    const n = needs();
    delete n.select;
    expect(conclude(n).ok).toBe(false);
  });

  it("a red known-red leg still lets it pass, and is listed with its ticket", () => {
    const got = conclude(
      needs(
        { gate: [NODE], known_red: [RUST_RED] },
        { gate: "success", "gate-known-red": "failure" },
      ),
    );
    expect(got.ok, got.problems.join("\n")).toBe(true);
    expect(got.summary).toMatch(/KNOWN RED \(1\)/);
    expect(got.summary).toMatch(/`rust` \(#806\): failure/);
  });

  it("a known-red leg that passed is never shown as passing, only as a waiver to remove", () => {
    const got = conclude(needs({ known_red: [RUST_RED] }, { "gate-known-red": "success" }));
    expect(got.ok).toBe(true);
    expect(got.summary).toMatch(/`rust` \(#806\): its leg passed; remove its ci\.knownRed/);
  });

  it("an empty selection is green, and says no SDK was selected", () => {
    const got = conclude(
      needs({ summary: "pull_request: no SDK selected (only apps/cli changed)" }),
    );
    expect(got.ok).toBe(true);
    expect(got.summary).toMatch(/no SDK selected/);
  });

  it("is red on a job it does not judge", () => {
    const n = needs({ gate: [NODE] }, { gate: "success" });
    n.extra = { result: "failure", outputs: {} };
    const got = conclude(n);
    expect(got.ok).toBe(false);
    expect(got.problems.join()).toMatch(/extra: a job conclude-sdk-gates does not judge/);
  });

  it.each([
    ["an output that is not JSON", (n) => void (n.select.outputs.gate = "[")],
    ["an output that is not an array", (n) => void (n.select.outputs.swift = '{"a":1}')],
    ["a missing output", (n) => void delete n.select.outputs.smoke],
    ["a name that is not an SDK name", (n) => void (n.select.outputs.smoke = '["a b"]')],
    ["a leg with no name", (n) => void (n.select.outputs.gate = '[{"daggerFn":"x"}]')],
    [
      "a known-red leg with no ticket",
      (n) => void (n.select.outputs.known_red = '[{"name":"rust","daggerFn":"rust-test"}]'),
    ],
    [
      "gate files that are not plain",
      (n) => void (n.select.outputs.gate_files = '{"files":["a\\nb"],"unnamed":0}'),
    ],
  ])("is red on %s", (_name, mutate) => {
    const n = needs();
    mutate(n);
    expect(conclude(n).ok).toBe(false);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
  ])("is red when needs is %s", (_name, n) => expect(conclude(n).ok).toBe(false));
});

describe("the summary's first line lists the gate files changed", () => {
  it("names them, and counts the ones it cannot print", () => {
    const got = conclude(
      needs({ gate_files: { files: [".github/workflows/sdk-gates.yml"], unnamed: 2 } }),
    );
    expect(got.summary.split("\n")[0]).toBe(
      "Gate files this pull request changes (its own copies judged this run): `.github/workflows/sdk-gates.yml`, and 2 more with a name not shown",
    );
  });
  it("says none when there are none", () =>
    expect(conclude(needs()).summary.split("\n")[0]).toBe("Gate files changed: none"));
  it("comes first even when select failed", () =>
    expect(conclude(needs({}, {}, "failure")).summary.split("\n")[0]).toMatch(/^Gate files/));
});

// ---------------------------------------------------------------------------
// The CLI.

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "conclude-sdk-gates-"));
  dirs.push(dir);
  const summary = join(dir, "summary.md");
  const base = { ...process.env, GITHUB_STEP_SUMMARY: summary };
  delete base.NEEDS_JSON;
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...base, ...env } });
  let written = "";
  try {
    written = readFileSync(summary, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  return { status: r.status, stderr: r.stderr, summary: written };
}

describe("the CLI", { timeout: 60_000 }, () => {
  it("exits 0 and writes the table when green", () => {
    const got = run({ NEEDS_JSON: JSON.stringify(needs({ gate: [NODE] }, { gate: "success" })) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.summary).toMatch(/\| Job \| Selected \| Result \| Counted \|/);
    expect(got.summary).toMatch(/\| gate \| `node` \| success \| yes \|/);
  });
  it("exits 1 and names the SDK when red", () => {
    const got = run({ NEEDS_JSON: JSON.stringify(needs({ gate: [NODE] }, { gate: "failure" })) });
    expect(got.status).toBe(1);
    expect(got.stderr).toMatch(/gate: failure \(selected: node\)/);
    expect(got.summary).toMatch(/sdk gates: RED/);
  });
  it.each([
    ["unparsable", { NEEDS_JSON: "{" }],
    ["missing", {}],
  ])("is red when NEEDS_JSON is %s", (_name, env) => {
    const got = run(env);
    expect(got.status).not.toBe(0);
    expect(got.summary).toMatch(/sdk gates: RED/);
  });
});
