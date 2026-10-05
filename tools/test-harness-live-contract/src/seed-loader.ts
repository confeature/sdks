// SPDX-License-Identifier: MIT

/**
 * Seed file loader — reads a JSON file from disk, validates it against
 * the zod SeedSchema, and returns a typed Seed. Throws SeedValidationError
 * with a JSON Pointer path on validation failure.
 */

import { readFile } from "node:fs/promises";
import { SeedSchema } from "./seed-schema.js";
import type { Seed } from "./types.js";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// SeedValidationError
// ---------------------------------------------------------------------------

/**
 * Thrown when a seed file or inline seed object fails zod validation.
 * `pointer` is a JSON Pointer (RFC 6901) indicating the first failing field,
 * e.g. "keys/0/sdkKey".
 */
export class SeedValidationError extends Error {
  readonly pointer: string;

  constructor(message: string, pointer: string) {
    super(message);
    this.name = "SeedValidationError";
    this.pointer = pointer;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a zod ZodError to a SeedValidationError.
 * Uses the path of the first issue as the JSON Pointer.
 */
function fromZodError(err: ZodError): SeedValidationError {
  const first = err.issues[0];
  const pointer = first?.path.join("/") ?? "";
  const message = first
    ? `${first.path.length > 0 ? pointer + ": " : ""}${first.message}`
    : "seed validation failed";
  return new SeedValidationError(message, pointer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw unknown value as a Seed.
 * Throws SeedValidationError if validation fails.
 */
export function parseSeed(raw: unknown): Seed {
  const result = SeedSchema.safeParse(raw);
  if (!result.success) {
    throw fromZodError(result.error);
  }
  return result.data;
}

/**
 * Read a seed file from disk and parse/validate it.
 * Throws SeedValidationError if the file is invalid JSON or fails schema validation.
 */
export async function loadSeed(filePath: string): Promise<Seed> {
  let raw: unknown;
  try {
    const text = await readFile(filePath, "utf-8");
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new SeedValidationError(
        `malformed JSON in seed file '${filePath}': ${err.message}`,
        "",
      );
    }
    throw err;
  }
  return parseSeed(raw);
}
