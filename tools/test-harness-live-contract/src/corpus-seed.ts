// SPDX-License-Identifier: MIT

/**
 * The corpus seed — which wire-cases the harness can serve, and the one seed
 * that serves them all at once (#783, decision rows 1-2).
 *
 * This module is the ONLY reader of `seeds/` against the wire-case corpus.
 * The fidelity test, the CLI's `--corpus-seed`, and every SDK live runner get
 * the set from here — a non-TypeScript runner asks the running harness
 * (`GET /admin/state` → `keys`), never recomputes `wire-cases ∩ seeds/`.
 *
 * One seed, every case: each case's seed key is renamed to the case id, so a
 * single boot and a single KV write serve the whole corpus, and a runner
 * addresses a case by using its id as the SDK key.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { caseToSeedPath, defaultWireCasesPath } from "./corpus-mapper.js";
import { parseSeed } from "./seed-loader.js";
import type { Seed, SeededKey } from "./types.js";

function seedsDir(): string {
  return dirname(caseToSeedPath("probe"));
}

function corpusCaseIds(): string[] {
  const corpus = JSON.parse(readFileSync(defaultWireCasesPath(), "utf-8")) as {
    cases: Array<{ id: string }>;
  };
  return corpus.cases.map((c) => c.id);
}

/**
 * Every corpus case that has a seed, in corpus order. Throws when the set is
 * empty: a runner iterating an empty set would pass having checked nothing.
 */
export function seededCaseIds(): string[] {
  const seeded = new Set(
    readdirSync(seedsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => basename(f, ".json")),
  );
  const ids = corpusCaseIds().filter((id) => seeded.has(id));
  if (ids.length === 0) {
    throw new Error("no wire-case in the corpus has a seed — refusing an empty case set");
  }
  return ids;
}

/** The seed of every seeded case, each key renamed to its case id. */
export function buildCorpusSeed(): Seed {
  const keys: SeededKey[] = seededCaseIds().map((id) => {
    const seed = parseSeed(JSON.parse(readFileSync(caseToSeedPath(id), "utf-8")) as unknown);
    if (seed.keys.length !== 1) {
      throw new Error(`seeds/${id}.json must hold exactly one key, has ${seed.keys.length}`);
    }
    return { ...seed.keys[0]!, sdkKey: id };
  });
  return {
    schemaVersion: "1.0",
    description: "every seeded wire-case, keyed by case id",
    keys,
  };
}

/**
 * How long the `timeout` case holds a request — a live runner derives its
 * SDK deadline from this and asserts it is shorter, so the two numbers can
 * never drift apart unnoticed. Undefined when no key carries a timeout fault.
 */
export function timeoutHoldMs(seed: Seed): number | undefined {
  for (const key of seed.keys) {
    if (typeof key.fault === "object" && key.fault.kind === "timeout") return key.fault.ms;
  }
  return undefined;
}
