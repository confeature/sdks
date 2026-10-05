// SPDX-License-Identifier: MIT

/**
 * Validate `fixtures/wire-cases.json` against `fixtures/wire-cases.schema.json`.
 *
 * Runs as the root `verify:wire-cases` gate in `pre-push` (#783), so every
 * push touching the wire-cases fixture is gated on schema conformance.
 * This is the load-time gate every SDK consumer can rely on — the
 * fixture cannot land malformed.
 *
 * The schema is JSON Schema Draft 2020-12. Validation uses ajv 8 with
 * ajv-formats for the `uri` format on `$schema`.
 *
 * Then the cross-file rules the schema cannot express (1.3, #803), from
 * `src/wire-case-rules.ts`: every `given.sdkKey` is a valid key of
 * `sdk-key-shapes.json` (one named malformed-key case excepted), and every
 * `expected.requestPath` is FR-001's path for that key.
 *
 * Exits 0 on success, 1 on any validation error (with the ajv error
 * list printed for diagnosis). See spec 112 / #148 / epic #146.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ajv/dist/2020 path works at runtime; TypeScript needs the explicit .js
// extension to resolve under "moduleResolution": "bundler", and the named
// `Ajv2020` import (not default) sidesteps the CommonJS-vs-ESM
// constructability check. The schema uses no JSON Schema formats so
// `ajv-formats` is intentionally not pulled in.
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  crossFileErrors as crossFileRuleErrors,
  type WireCaseLike,
} from "../src/wire-case-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures");
const fixturePath = resolve(fixturesDir, "wire-cases.json");
const schemaPath = resolve(fixturesDir, "wire-cases.schema.json");

const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf-8"));

// strict=false: ajv's strictRequired complains about `not: { required: [...] }`
// inside `server` even though the pattern is valid Draft 2020-12. We get the
// same gate effect without the false-positive.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema as object);
const ok = validate(fixture);

if (!ok) {
  console.error(`✗ wire-cases.json failed schema validation:`);
  for (const err of validate.errors ?? []) {
    const path = err.instancePath || "(root)";
    console.error(`  ${path} ${err.message ?? ""}`);
    if (err.params && Object.keys(err.params).length > 0) {
      console.error(`    params: ${JSON.stringify(err.params)}`);
    }
  }
  process.exit(1);
}

// ---- Cross-file rules the schema cannot express (1.3, #803) ---------------
// The rules live in src/wire-case-rules.ts (pure, unit-tested by
// tests/wire-case-rules.test.ts); this gate runs them on the real corpus.
const keyShapes = JSON.parse(
  readFileSync(resolve(fixturesDir, "sdk-key-shapes.json"), "utf-8"),
) as {
  valid: Array<{ key: string }>;
};
const validKeys = new Set(keyShapes.valid.map((entry) => entry.key));
const cases = (fixture as { cases: WireCaseLike[] }).cases;
const crossFileErrors = crossFileRuleErrors(cases, validKeys);
if (crossFileErrors.length > 0) {
  console.error(`✗ wire-cases.json failed the cross-file checks:`);
  for (const error of crossFileErrors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`✓ wire-cases.json — ${cases.length} cases validated against wire-cases.schema.json`);
