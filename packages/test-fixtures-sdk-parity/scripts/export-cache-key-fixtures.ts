// SPDX-License-Identifier: MIT

/**
 * Export a cross-language cache-key fixture for non-TS SDK parity gates.
 *
 * For each of ≥ 5 canonical SDK key inputs, computes the cache key via
 * `@confeature/sdk-shared`'s `deriveCacheKey` (SHA-256 path — research §R2
 * of spec 037) and writes the (sdkKey, expectedCacheKey) pairs to
 * `fixtures/cache-key-fixtures.json`.
 *
 * Non-TS SDKs (e.g. apps/sdk-python's `derive_cache_key`) MUST produce
 * byte-identical strings for every entry. See spec 037 FR-010.
 *
 * Usage:
 *   pnpm run export:cache-key-fixtures
 *   pnpm run check:exports                # (chained — uses --check)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCacheKey } from "@confeature/sdk-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const FIXTURE_PATH = resolve(PACKAGE_ROOT, "fixtures", "cache-key-fixtures.json");

/**
 * Inputs cover: the key shape minted today (`configcat-sdk-1/<22>/<22>`,
 * #802 — its `/` separators must hash as plain bytes), the pre-#802
 * Confeature key, ConfigCat-style legacy key,
 * single ASCII char, empty string, multi-byte UTF-8 emoji. Each exercises
 * a distinct corner of the SHA-256 input domain (length, byte
 * distribution, encoding round-trip).
 */
const INPUTS: readonly string[] = [
  "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d",
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "configcat-sdk-1-test-key-deadbeef-cafebabe",
  "x",
  "",
  "🦀-emoji-key",
];

async function buildFixture(): Promise<string> {
  const rows: { sdkKey: string; expectedCacheKey: string }[] = [];
  for (const sdkKey of INPUTS) {
    const expectedCacheKey = await deriveCacheKey(sdkKey);
    rows.push({ sdkKey, expectedCacheKey });
  }
  return JSON.stringify(rows, null, 2) + "\n";
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const expected = await buildFixture();

  if (checkMode) {
    let actual: string;
    try {
      actual = readFileSync(FIXTURE_PATH, "utf8");
    } catch (err) {
      console.error(`[export-cache-key-fixtures] missing committed JSON: ${FIXTURE_PATH}`);
      console.error(`[export-cache-key-fixtures] underlying error: ${(err as Error).message}`);
      process.exit(1);
    }
    if (actual !== expected) {
      console.error(
        `[export-cache-key-fixtures] DRIFT: ${FIXTURE_PATH} differs from live deriveCacheKey output.`,
      );
      console.error(
        `[export-cache-key-fixtures] regenerate with: pnpm run export:cache-key-fixtures`,
      );
      process.exit(1);
    }
    console.log("[export-cache-key-fixtures] OK — committed JSON matches live TS source.");
    return;
  }

  writeFileSync(FIXTURE_PATH, expected, "utf8");
  console.log(`[export-cache-key-fixtures] wrote ${INPUTS.length} pairs → ${FIXTURE_PATH}`);
}

void main();
