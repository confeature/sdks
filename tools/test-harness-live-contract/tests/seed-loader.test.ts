// SPDX-License-Identifier: MIT

/**
 * T019 — seed-loader negative validation cases.
 *
 * Each case must throw SeedValidationError with a non-empty JSON Pointer.
 */

import { describe, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { parseSeed, loadSeed, SeedValidationError } from "../src/seed-loader.js";

describe("parseSeed — validation errors", () => {
  test("wrong schemaVersion", () => {
    expect(() =>
      parseSeed({
        schemaVersion: "2.0",
        keys: [{ sdkKey: "k", payload: {} }],
      }),
    ).toThrow(SeedValidationError);
  });

  test("empty keys array", () => {
    expect(() => parseSeed({ schemaVersion: "1.0", keys: [] })).toThrow(SeedValidationError);
  });

  test("sdkKey with slash", () => {
    expect(() =>
      parseSeed({
        schemaVersion: "1.0",
        keys: [{ sdkKey: "a/b", payload: {} }],
      }),
    ).toThrow(SeedValidationError);
  });

  test("empty sdkKey", () => {
    expect(() =>
      parseSeed({
        schemaVersion: "1.0",
        keys: [{ sdkKey: "", payload: {} }],
      }),
    ).toThrow(SeedValidationError);
  });

  // FR-006 (plan 680): a null payload means "absent from KV". It may stand
  // alone (the upstream serves its real miss) or carry a fault that replaces the
  // whole response — but never a fault that forwards an upstream body.
  test.each([
    ["timeout", { kind: "timeout", ms: 100 }],
    ["etag-mismatch", { kind: "etag-mismatch", newEtag: '"x"' }],
    ["close-mid-response", "close-mid-response"],
  ])("payload null with a body-forwarding fault (%s) is rejected", (_name, fault) => {
    expect(() =>
      parseSeed({ schemaVersion: "1.0", keys: [{ sdkKey: "test-key", payload: null, fault }] }),
    ).toThrow(SeedValidationError);
  });

  test.each([
    ["no fault", undefined],
    ["5xx", "5xx"],
    ["404", "404"],
    ["status", { kind: "status", status: 403, headers: { "Content-Type": "text/plain" } }],
  ])("payload null with %s is accepted", (_name, fault) => {
    const key: Record<string, unknown> = { sdkKey: "test-key", payload: null };
    if (fault !== undefined) key["fault"] = fault;
    expect(() => parseSeed({ schemaVersion: "1.0", keys: [key] })).not.toThrow();
  });

  test("missing schemaVersion", () => {
    expect(() => parseSeed({ keys: [{ sdkKey: "k", payload: {} }] })).toThrow(SeedValidationError);
  });

  test("SeedValidationError has non-empty pointer on keys error", () => {
    let err: SeedValidationError | null = null;
    try {
      parseSeed({ schemaVersion: "1.0", keys: [] });
    } catch (e) {
      err = e as SeedValidationError;
    }
    expect(err).not.toBeNull();
    expect(err!.pointer).toBeTruthy();
  });

  test("SeedValidationError has pointer on key-level error", () => {
    let err: SeedValidationError | null = null;
    try {
      parseSeed({
        schemaVersion: "1.0",
        keys: [{ sdkKey: "", payload: {} }],
      });
    } catch (e) {
      err = e as SeedValidationError;
    }
    expect(err).not.toBeNull();
    expect(err!.pointer).toMatch(/keys/);
  });
});

describe("loadSeed — file loading", () => {
  test("malformed JSON throws SeedValidationError", async () => {
    const tmpPath = join(tmpdir(), `test-seed-malformed-${Date.now()}.json`);
    await writeFile(tmpPath, "{ not valid json", "utf-8");
    try {
      await expect(loadSeed(tmpPath)).rejects.toThrow(SeedValidationError);
    } finally {
      await rm(tmpPath, { force: true });
    }
  });

  test("valid seed file loads correctly", async () => {
    const tmpPath = join(tmpdir(), `test-seed-valid-${Date.now()}.json`);
    const seed = {
      schemaVersion: "1.0",
      keys: [{ sdkKey: "test-key", payload: { p: null, f: {}, s: [] } }],
    };
    await writeFile(tmpPath, JSON.stringify(seed), "utf-8");
    try {
      const loaded = await loadSeed(tmpPath);
      expect(loaded.schemaVersion).toBe("1.0");
      expect(loaded.keys).toHaveLength(1);
      expect(loaded.keys[0]!.sdkKey).toBe("test-key");
    } finally {
      await rm(tmpPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `status` fault validation (plan 680 FR-001, decision row 1; audits A4, S1-S3)
// ---------------------------------------------------------------------------

describe("status fault — validation", () => {
  const seedWith = (fault: unknown) => ({
    schemaVersion: "1.0",
    keys: [{ sdkKey: "k", payload: null, fault }],
  });
  const accepts = (fault: unknown) => expect(() => parseSeed(seedWith(fault))).not.toThrow();
  const rejects = (fault: unknown) =>
    expect(() => parseSeed(seedWith(fault))).toThrow(SeedValidationError);

  test("accepts a corpus-shaped 429 with Retry-After", () => {
    accepts({
      kind: "status",
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    });
  });

  test("accepts a bodiless 304 carrying Last-Modified only", () => {
    accepts({
      kind: "status",
      status: 304,
      headers: { "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
  });

  test.each([204, 205, 304])("rejects a body on null-body status %i", (status) => {
    rejects({ kind: "status", status, headers: { "Content-Type": "text/plain" }, body: "x" });
  });

  test("rejects a body without a declared Content-Type", () => {
    rejects({ kind: "status", status: 200, body: "x" });
  });

  test("rejects active content (text/html) — the harness never serves it", () => {
    rejects({
      kind: "status",
      status: 200,
      headers: { "Content-Type": "text/html" },
      body: "<script>",
    });
  });

  test.each(["Content-Length", "Transfer-Encoding", "Connection", "Set-Cookie", "content-type"])(
    "rejects a header outside the closed set: %s",
    (name) => {
      rejects({ kind: "status", status: 200, headers: { [name]: "1" } });
    },
  );

  test.each([
    ["CRLF (response splitting)", "a\r\nX-Injected: 1"],
    ["a control character", "a\u0001b"],
    ["leading whitespace", " leading"],
    ["trailing whitespace", "trailing "],
    ["a non-ASCII character", "caf\u00e9"],
  ])("rejects a header value with %s", (_name, value) => {
    rejects({ kind: "status", status: 200, headers: { ETag: value } });
  });

  test.each([199, 600, 200.5])("rejects status %s", (status) => {
    rejects({ kind: "status", status });
  });
});

describe("seed lastModified — the shape the CDN Worker echoes as Last-Modified (#785)", () => {
  const withLm = (lastModified: string) => ({
    schemaVersion: "1.0",
    keys: [{ sdkKey: "k", payload: {}, lastModified }],
  });

  test("accepts an IMF-fixdate, as the management API writes it", () => {
    expect(() => parseSeed(withLm(new Date(0).toUTCString()))).not.toThrow();
  });

  test.each(["yesterday", "2026-09-26T10:00:00Z", "Sat, 26 Sep 2026 10:00:00 UTC"])(
    "rejects %j — the Worker would put it on the wire verbatim",
    (value) => {
      expect(() => parseSeed(withLm(value))).toThrow(SeedValidationError);
    },
  );
});
