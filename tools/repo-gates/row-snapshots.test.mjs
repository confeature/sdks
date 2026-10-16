// SPDX-License-Identifier: MIT
// row-snapshots.mjs on its own (round 9): the snapshot store the refuses
// tables lean on must refuse what would let a regeneration bless anything.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rowSnapshots } from "./row-snapshots.mjs";

let dir;
afterEach(() => {
  vi.unstubAllEnvs();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
/** A fixtures directory holding `snap.json` = `stored`. */
function fixtures(stored) {
  dir = mkdtempSync(join(tmpdir(), "row-snapshots-"));
  writeFileSync(join(dir, "snap.json"), `${JSON.stringify(stored, null, 2)}\n`);
  return dir;
}
const read = () => JSON.parse(readFileSync(join(dir, "snap.json"), "utf8"));
const RECORD = { RECORD_ROW_FINDINGS: "1" };

describe("rowSnapshots", () => {
  it("refuses to record under CI (stubbed process env)", () => {
    vi.stubEnv("RECORD_ROW_FINDINGS", "1");
    vi.stubEnv("CI", "true");
    expect(() => rowSnapshots("snap.json", { dir: fixtures({}) })).toThrow(/refused under CI/);
  });
  it("records outside CI", () => {
    vi.stubEnv("RECORD_ROW_FINDINGS", "1");
    vi.stubEnv("CI", "");
    expect(() => rowSnapshots("snap.json", { dir: fixtures({}) })).not.toThrow();
  });

  it("passes a full run that matches", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: ["x"], b: [] }) });
    s.rows([["a"], ["b"]]);
    s.check("a", ["x"]);
    s.check("b", []);
    expect(() => s.finish()).not.toThrow();
  });
  it("fails a row whose findings changed, sorted before comparing", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: ["x", "y"] }) });
    s.rows([["a"]]);
    expect(() => s.check("a", ["y", "x"])).not.toThrow();
    expect(() => s.check("a", ["x"])).toThrow(/re-record with RECORD_ROW_FINDINGS=1/);
  });
  it("finish() fails on a snapshot no registered row has", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: [], gone: [] }) });
    s.rows([["a"]]);
    s.check("a", []);
    expect(() => s.finish()).toThrow(/a snapshot without a row/);
  });
  it("finish() fails on a registered row with no snapshot, even if it never ran", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: [] }) });
    s.rows([["a"], ["new"]]);
    s.check("a", []);
    expect(() => s.finish()).toThrow(/a snapshot without a row, or a row without one/);
  });
  it("a filtered run (some rows skipped) still checks against every registered row", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: [], b: [] }) });
    s.rows([["a"], ["b"]]);
    s.check("a", []);
    expect(() => s.finish()).not.toThrow();
  });
  it("finish() fails on two rows sharing a label", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: [] }) });
    s.rows([["a"], ["a"]]);
    expect(() => s.finish()).toThrow(/two rows share a label/);
  });
  it("finish() fails on a row checked without registering", () => {
    const s = rowSnapshots("snap.json", { env: {}, dir: fixtures({ a: [], b: [] }) });
    s.rows([["a"]]);
    s.check("a", []);
    expect(() => s.check("b", [])).not.toThrow();
    expect(() => s.finish()).toThrow(/without registering/);
  });

  it("record mode refuses a duplicate label before writing", () => {
    const s = rowSnapshots("snap.json", { env: RECORD, dir: fixtures({ a: ["old"] }) });
    s.rows([["a"], ["a"]]);
    s.check("a", ["new"]);
    expect(() => s.finish()).toThrow(/two rows share a label/);
    expect(read()).toEqual({ a: ["old"] });
  });
  it("record mode merges into the stored map and drops unregistered labels", () => {
    const s = rowSnapshots("snap.json", {
      env: RECORD,
      dir: fixtures({ a: ["old"], b: ["kept"], gone: ["x"] }),
    });
    s.rows([["a"], ["b"], ["c"]]);
    s.check("a", ["new"]);
    s.check("c", ["z", "y"]);
    s.finish();
    expect(read()).toEqual({ a: ["new"], b: ["kept"], c: ["y", "z"] });
  });
  it("record mode refuses to write when fewer rows ran than the snapshot holds", () => {
    const s = rowSnapshots("snap.json", { env: RECORD, dir: fixtures({ a: ["old"], b: ["old"] }) });
    s.rows([["a"], ["b"]]);
    s.check("a", ["new"]);
    expect(() => s.finish()).toThrow(/record a full run/);
    expect(read()).toEqual({ a: ["old"], b: ["old"] });
  });
});
