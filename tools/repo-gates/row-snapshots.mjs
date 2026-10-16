// SPDX-License-Identifier: MIT

/**
 * The findings each refuses row produces, snapshotted per row (round 8).
 *
 * A row asserts its own reason; the snapshot also holds every other finding
 * it produces, sorted, so a regression that adds or drops one beside the
 * pinned reason is seen, and a regeneration shows WHAT changed in its diff
 * (bare counts let a regeneration bless anything).
 *
 *   RECORD_ROW_COUNTS=1 pnpm --filter @confeature/repo-gates record:row-counts
 *
 * rewrites the snapshots; review the diff. Recording is refused under CI.
 * finish() (in an afterAll) checks that every row was seen once, under a
 * label of its own, and that no snapshot is left over.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function rowSnapshots(file) {
  const path = join(FIXTURES, file);
  const recording = process.env.RECORD_ROW_COUNTS === "1";
  if (recording && process.env.CI)
    throw new Error(
      "RECORD_ROW_COUNTS is refused under CI: snapshots are recorded and reviewed locally",
    );
  const stored = recording ? {} : JSON.parse(readFileSync(path, "utf8"));
  const recorded = {};
  const seen = [];
  return {
    check(label, findings) {
      seen.push(label);
      const sorted = [...findings].sort(byText);
      if (recording) recorded[label] = sorted;
      else
        expect(sorted, `${label} (re-record with RECORD_ROW_COUNTS=1 and review)`).toEqual(
          stored[label],
        );
    },
    finish() {
      if (recording) {
        writeFileSync(path, `${JSON.stringify(recorded, null, 2)}\n`);
        return;
      }
      expect(new Set(seen).size, "two rows share a label").toBe(seen.length);
      expect(
        Object.keys(stored).sort(byText),
        "a snapshot without a row, or a row without one",
      ).toEqual([...new Set(seen)].sort(byText));
    },
  };
}
