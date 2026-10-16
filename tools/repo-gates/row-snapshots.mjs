// SPDX-License-Identifier: MIT

/**
 * The findings each refuses row produces, snapshotted per row (round 8).
 *
 * A row asserts its own reason; the snapshot also holds every other finding
 * it produces, sorted, so a regression that adds or drops one beside the
 * pinned reason is seen, and a regeneration shows WHAT changed in its diff
 * (bare counts let a regeneration bless anything).
 *
 *   pnpm --filter @confeature/repo-gates record:row-findings
 *
 * (RECORD_ROW_FINDINGS=1) rewrites the snapshots; review the diff. Recording
 * is refused under CI.
 *
 * Every table registers its labels when the suite is collected (rows()),
 * before any test runs (round 9), so the set of rows is known whatever a
 * `-t` filter runs: finish() (in an afterAll) checks that no two rows share
 * a label, that every registered row has a snapshot and every snapshot a
 * registered row, and that every row that ran was registered; under CI,
 * where nothing filters, also that every registered row ran. Recording
 * merges what ran into the stored map, keeps only registered labels, and
 * refuses to write when fewer rows ran than the stored map holds for them
 * (a filtered run would otherwise drop the rows it skipped).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The labels of `labels` that occur more than once, sorted. */
function duplicates(labels) {
  const once = new Set();
  const twice = new Set();
  for (const l of labels) (once.has(l) ? twice : once).add(l);
  return [...twice].sort(byText);
}

/**
 * The snapshots of one fixture file. `env` and `dir` exist for the module's
 * own tests (row-snapshots.test.mjs).
 */
export function rowSnapshots(file, { env = process.env, dir = FIXTURES } = {}) {
  const path = join(dir, file);
  const recording = env.RECORD_ROW_FINDINGS === "1";
  if (recording && env.CI)
    throw new Error(
      "RECORD_ROW_FINDINGS is refused under CI: snapshots are recorded and reviewed locally",
    );
  const stored = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const registered = [];
  const recorded = {};
  const seen = [];
  return {
    /** Registers a table's rows (label first) at collection time; returns the table. */
    rows(table) {
      for (const row of table) registered.push(row[0]);
      return table;
    },
    check(label, findings) {
      seen.push(label);
      const sorted = [...findings].sort(byText);
      if (recording) recorded[label] = sorted;
      else
        expect(sorted, `${label} (re-record with RECORD_ROW_FINDINGS=1 and review)`).toEqual(
          stored[label],
        );
    },
    finish() {
      expect(duplicates(registered), "two rows share a label").toEqual([]);
      expect(duplicates(seen), "a row ran twice").toEqual([]);
      const known = new Set(registered);
      expect(
        seen.filter((l) => !known.has(l)),
        "a row checked without registering (wrap its table in rows())",
      ).toEqual([]);
      if (recording) {
        const kept = Object.keys(stored).filter((l) => known.has(l));
        if (seen.length < kept.length)
          throw new Error(
            `recording saw ${seen.length} rows, the snapshot holds ${kept.length}: record a full run, not a filtered one`,
          );
        const merged = {};
        for (const l of known)
          if (Object.hasOwn(recorded, l) || Object.hasOwn(stored, l))
            merged[l] = recorded[l] ?? stored[l];
        writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
        return;
      }
      expect(
        Object.keys(stored).sort(byText),
        "a snapshot without a row, or a row without one",
      ).toEqual([...known].sort(byText));
      // Under CI no filter runs, so a registered row that never ran was
      // skipped (`it.skip.each`, `describe.skip`) and checks nothing (round 10).
      if (env.CI) {
        const ran = new Set(seen);
        expect(
          [...known].filter((l) => !ran.has(l)),
          "a registered row never ran under CI (skipped?)",
        ).toEqual([]);
      }
    },
  };
}
