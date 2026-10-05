// SPDX-License-Identifier: MIT
/**
 * Drift check — re-runs the seed schema emitter into a temp file and diffs
 * against the checked-in schemas/seed.schema.json. Exits 1 on drift.
 *
 * IT MUST REPRODUCE EVERY STEP THAT PRODUCES THE COMMITTED FILE — build, emit,
 * format — not just the emitter. `schemas/seed.schema.json` is tracked, so `vp fmt` formats it like
 * any other JSON in this repo; the emitter writes its own spacing. Comparing
 * raw emitter output against a formatted file reports drift on a tree that has
 * none — which is exactly what this script did, permanently, from the day it
 * was written until #770: the two files are semantically identical (zero diff
 * after JSON normalisation) and differ at byte 2538 on whitespace alone.
 *
 * Nobody noticed because nothing ran it (#764's sweep found it orphaned). A
 * gate that is wired while permanently red does not become a gate, it becomes
 * a thing people skip — so the byte comparison had to be made honest BEFORE
 * this script was given a home.
 *
 * Same defect and same remedy as `packages/contract/scripts/check-generated.mjs`
 * (#756), whose comment states the rule this one now follows: run every step of
 * the generation, in order, or the comparison is against the wrong thing.
 *
 * Usage:
 *   node tools/check-seed-schema-drift.mjs
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

async function main() {
  const checkedIn = join(pkgRoot, "schemas", "seed.schema.json");
  const tmpDir = await mkdtemp(join(tmpdir(), "seed-schema-drift-"));
  const tmpOut = join(tmpDir, "seed.schema.json");

  try {
    // Step 1 of 3: BUILD. `emit-seed-schema.mjs` imports `dist/seed-schema.js`
    // and only falls back to the TypeScript source when dist is absent — so a
    // stale dist wins over an edited `src/seed-schema.ts`, and the check passes
    // green on precisely the drift it exists to catch.
    //
    // Verified rather than assumed (#770): adding a `.describe()` to the source
    // schema and running this check WITHOUT a build exits 0. That is a fail-open,
    // and it is the important direction — hand-editing the committed JSON is the
    // rare mistake, forgetting to regenerate after a source change is the common
    // one. Building first makes the comparison the real pipeline, source through
    // build through emit through format, rather than a snapshot of whenever
    // someone last ran tsc.
    await execFileAsync("pnpm", ["exec", "tsc", "--build"], { cwd: pkgRoot });

    // Step 2 of 3: re-emit into the temp file.
    await execFileAsync("node", [
      join(pkgRoot, "tools", "emit-seed-schema.mjs"),
      "--output",
      tmpOut,
    ]);

    // Step 3 of 3: format it, because the committed file is formatted. Without
    // this the comparison below is emitter-output vs formatted-file and can
    // never pass. See the header.
    await execFileAsync("pnpm", ["exec", "vp", "fmt", tmpOut], { cwd: pkgRoot });

    const [checkedInText, emittedText] = await Promise.all([
      readFile(checkedIn, "utf-8").catch(() => null),
      readFile(tmpOut, "utf-8"),
    ]);

    if (checkedInText === null) {
      console.error(
        "[check-seed-schema-drift] ERROR: schemas/seed.schema.json is missing. Run `node tools/emit-seed-schema.mjs` to generate it.",
      );
      process.exit(1);
    }

    if (checkedInText !== emittedText) {
      console.error(
        "[check-seed-schema-drift] DRIFT DETECTED: schemas/seed.schema.json is out of sync with src/seed-schema.ts.\n" +
          "Run `node tools/emit-seed-schema.mjs && pnpm exec vp fmt schemas/seed.schema.json` and commit the result.",
      );
      process.exit(1);
    }

    console.error("[check-seed-schema-drift] OK — schemas/seed.schema.json is in sync.");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[check-seed-schema-drift] FATAL:", err.message);
  process.exit(1);
});
