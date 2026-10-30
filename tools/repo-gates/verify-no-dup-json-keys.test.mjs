// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDuplicateKeys } from "./verify-no-dup-json-keys.mjs";

// The duplicate-key verifier. JSON.parse keeps the LAST of two equal keys
// silently; every duplicate below would parse clean, and each is a mutation
// case for the `seen` check.

const GUARD = fileURLToPath(new URL("verify-no-dup-json-keys.mjs", import.meta.url));

describe("findDuplicateKeys", () => {
  it("passes an object with distinct keys at every depth", () => {
    expect(findDuplicateKeys('{"a": 1, "b": {"a": 2, "c": [{"a": 3}, {"a": 4}]}}')).toEqual([]);
  });

  it("finds a top-level duplicate, with its line", () => {
    expect(findDuplicateKeys('{\n  "ready": 1,\n  "ready": 2\n}')).toEqual([
      { path: "ready", key: "ready", line: 3 },
    ]);
  });

  it("finds a nested duplicate, with its path", () => {
    expect(findDuplicateKeys('{"scripts": {"test": "a", "test": "b"}}')).toEqual([
      { path: "scripts.test", key: "test", line: 1 },
    ]);
  });

  it("finds a duplicate inside an array element", () => {
    expect(findDuplicateKeys('{"x": [{"k": 1, "k": 2}]}')).toEqual([
      { path: "x.[0].k", key: "k", line: 1 },
    ]);
  });

  it("does not treat an escaped quote as the end of a key", () => {
    expect(findDuplicateKeys('{"a\\"b": 1, "a": 2}')).toEqual([]);
  });

  it("throws on a malformed object", () => {
    expect(() => findDuplicateKeys('{"a" 1}')).toThrow(/Expected ':'/);
  });

  it("throws on input cut short, wherever it stops (#870 item 7)", () => {
    // MUTATION (applied, #870): drop the final JSON.parse and every one of
    // these reads as clean ([]) — the gate passed a truncated file.
    for (const cut of ['{"a": 1', '{"a": "x', '{"a": [1, 2', '{"a": {"b": 1}', '{"a": 1,']) {
      expect(() => findDuplicateKeys(cut), cut).toThrow();
    }
  });
});

describe("the CLI", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dup-keys-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (...files) =>
    spawnSync(process.execPath, [GUARD, ...files], { cwd: dir, timeout: 60_000 }).status;

  it("exits 0 on a clean file, 1 on a duplicate, 2 on bad input or no input", () => {
    writeFileSync(join(dir, "ok.json"), '{"a": 1}');
    writeFileSync(join(dir, "dup.json"), '{"a": 1, "a": 2}');
    writeFileSync(join(dir, "bad.json"), '{"a" 1}');
    writeFileSync(join(dir, "cut.json"), '{"scripts": {"a": "x"');
    expect(run("ok.json")).toBe(0);
    expect(run("ok.json", "dup.json")).toBe(1);
    expect(run("bad.json")).toBe(2);
    expect(run("cut.json")).toBe(2);
    expect(run("missing.json")).toBe(2);
    expect(run()).toBe(2);
  });
});
