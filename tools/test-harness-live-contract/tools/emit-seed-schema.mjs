// SPDX-License-Identifier: MIT
/**
 * Emits the seed JSON Schema from the zod SeedSchema definition.
 *
 * Usage:
 *   node tools/emit-seed-schema.mjs [--output <path>]
 *
 * Default output: schemas/seed.schema.json (relative to package root).
 *
 * This script is wired into the `prepack` lifecycle script so the
 * published package always ships the schema in sync with the zod source.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

// We need to resolve the TypeScript source via tsx/ts-node at emit time.
// Since this runs as a prepack script (after build) OR standalone,
// we try to import the compiled JS first, then fall back to tsx if needed.
async function loadSeedSchema() {
  // After build, dist/seed-schema.js exists.
  const distPath = join(pkgRoot, "dist", "seed-schema.js");
  try {
    const mod = await import(distPath);
    return mod.SeedSchema;
  } catch {
    // During development (no dist yet), use tsx to load the TS source.
    const require = createRequire(import.meta.url);
    let tsxPath;
    try {
      tsxPath = require.resolve("tsx/esm");
    } catch {
      throw new Error(
        "Cannot load seed-schema.ts: dist/seed-schema.js not found and tsx is not available. " +
          "Run `pnpm build` first or install tsx as a devDependency.",
      );
    }
    // Dynamically register tsx loader and import the TS source
    const { register } = await import("node:module");
    register(tsxPath, import.meta.url);
    const mod = await import(join(pkgRoot, "src", "seed-schema.ts"));
    return mod.SeedSchema;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let outputPath = join(pkgRoot, "schemas", "seed.schema.json");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = resolve(args[i + 1]);
      i++;
    }
  }

  const { zodToJsonSchema } = await import("zod-to-json-schema");
  const SeedSchema = await loadSeedSchema();

  const jsonSchema = zodToJsonSchema(SeedSchema, {
    name: "Seed",
    $refStrategy: "none",
    target: "jsonSchema2020-12",
    definitionPath: "$defs",
  });

  // Add top-level metadata to match the contracts/seed.schema.json format
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://confeature.io/schemas/test-harness-live-contract/seed.schema.json",
    title: "Live-contract harness seed",
    description:
      "Describes the KV state and faults the live-contract-harness serves. One seed file per wire-case scenario, OR an inline payload passed via POST /admin/reset. STRUCTURAL ONLY: the zod schema in src/seed-schema.ts is authoritative, and its cross-field rules (no body on status 204/205/304, a body requires a Content-Type, a null payload allows only a whole-response fault) are not expressed here — a seed this schema accepts can still be rejected at load time.",
    ...jsonSchema,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(schema, null, 2) + "\n", "utf-8");
  console.error(`[emit-seed-schema] wrote ${outputPath}`);
}

main().catch((err) => {
  console.error("[emit-seed-schema] FATAL:", err.message);
  process.exit(1);
});
