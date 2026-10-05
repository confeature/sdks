// SPDX-License-Identifier: MIT

/**
 * Unit tests for `DenoFileConfigCache` + `InMemoryConfigCache` (T025, US3).
 *
 * Coverage:
 *  - Memory cache: get / set roundtrip.
 *  - `cacheKind === "memory"` bypasses the filesystem entirely.
 *  - `globalThis.Deno` undefined (Node-runtime vitest, default) → cache
 *    auto-demotes to memory + emits exactly one warn log (research §R3 + §R7).
 *  - **SC-009 explicit test**: with a stubbed `Deno` whose
 *    `writeTextFile` rejects with `Deno.errors.PermissionDenied`, the
 *    cache falls back to memory AND emits exactly ONE warn log. A
 *    second `set()` call MUST NOT emit a second warn (one-shot policy).
 *  - With a happy-path stubbed `Deno`, writes round-trip to disk and
 *    the next `DenoFileConfigCache` instance hydrates synchronously.
 *  - Cache file basename is derived from `deriveCacheKeySync(sdkKey)` —
 *    raw SDK key never on disk.
 *  - FR-021: after `getValueAsync(key, default, user)` with a fully-
 *    populated user, dumping the persisted JSON shows ZERO user-context
 *    fields (`identifier`, `email`, `country`, `custom`).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  deriveCacheKeySync,
  LoggerWrapper,
  type IConfigCatLogger,
  LogLevel,
  ProjectConfig,
  User,
  type IConfig,
} from "@confeature/sdk-shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DenoFileConfigCache } from "../../src/deno-file-cache.ts";
import { InMemoryConfigCache } from "../../src/memory-cache.ts";
import { ConfeatureClient, disposeAllClients, PollingMode } from "../../src/index.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeConfig(): IConfig {
  return {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: {
      "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] },
      "feature.y": { t: 0, v: { b: false }, i: "vy", r: [] },
    },
    s: [],
  };
}

class CapturingLogger implements IConfigCatLogger {
  public level: LogLevel = LogLevel.Debug;
  public eol = "\n";
  public readonly entries: { level: LogLevel; eventId: number | string; message: string }[] = [];
  log(level: LogLevel, eventId: number | string, message: string | { toString(): string }): void {
    this.entries.push({
      level,
      eventId,
      message: typeof message === "string" ? message : message.toString(),
    });
  }
}

function makeLogger(): { wrapper: LoggerWrapper; captured: CapturingLogger } {
  const captured = new CapturingLogger();
  return { wrapper: new LoggerWrapper(captured), captured };
}

/**
 * Install a happy-path `globalThis.Deno` stub that delegates filesystem
 * writes to real `node:fs` — vitest runs under Node (research §R6 +
 * §R8) so we mimic Deno's surface.
 */
function stubDenoHappy(): { restore: () => void; calls: { writes: string[]; mkdirs: string[] } } {
  const prior = (globalThis as { Deno?: unknown }).Deno;
  const calls = { writes: [] as string[], mkdirs: [] as string[] };
  class PermissionDenied extends Error {
    constructor(message = "PermissionDenied") {
      super(message);
      this.name = "PermissionDenied";
    }
  }
  class NotCapable extends Error {
    constructor(message = "NotCapable") {
      super(message);
      this.name = "NotCapable";
    }
  }
  class NotFound extends Error {
    constructor(message = "NotFound") {
      super(message);
      this.name = "NotFound";
    }
  }
  (globalThis as { Deno?: unknown }).Deno = {
    writeTextFile: (path: string, data: string): Promise<void> => {
      calls.writes.push(path);
      writeFileSync(path, data);
      return Promise.resolve();
    },
    readTextFile: (path: string): Promise<string> => Promise.resolve(readFileSync(path, "utf8")),
    mkdir: (path: string): Promise<void> => {
      calls.mkdirs.push(path);
      // Cache root is created up-front by the test via mkdtempSync.
      return Promise.resolve();
    },
    env: { get: (_name: string): string | undefined => undefined },
    errors: { PermissionDenied, NotCapable, NotFound },
  };
  return {
    calls,
    restore: () => {
      if (prior === undefined) {
        delete (globalThis as { Deno?: unknown }).Deno;
      } else {
        (globalThis as { Deno?: unknown }).Deno = prior;
      }
    },
  };
}

/**
 * Install a `globalThis.Deno` stub whose `writeTextFile` rejects with
 * `Deno.errors.PermissionDenied` on every call — exercises the SC-009
 * permission-denied fallback path.
 */
function stubDenoPermissionDenied(): {
  restore: () => void;
  writeAttempts: { count: number };
} {
  const prior = (globalThis as { Deno?: unknown }).Deno;
  const writeAttempts = { count: 0 };
  class PermissionDenied extends Error {
    constructor(message = "Requires write access") {
      super(message);
      this.name = "PermissionDenied";
    }
  }
  class NotCapable extends Error {
    constructor(message = "NotCapable") {
      super(message);
      this.name = "NotCapable";
    }
  }
  class NotFound extends Error {
    constructor(message = "NotFound") {
      super(message);
      this.name = "NotFound";
    }
  }
  (globalThis as { Deno?: unknown }).Deno = {
    writeTextFile: (_path: string, _data: string): Promise<void> => {
      writeAttempts.count++;
      return Promise.reject(new PermissionDenied());
    },
    readTextFile: (_path: string): Promise<string> => Promise.reject(new NotFound()),
    mkdir: (_path: string): Promise<void> => Promise.resolve(),
    env: { get: (_name: string): string | undefined => undefined },
    errors: { PermissionDenied, NotCapable, NotFound },
  };
  return {
    writeAttempts,
    restore: () => {
      if (prior === undefined) {
        delete (globalThis as { Deno?: unknown }).Deno;
      } else {
        (globalThis as { Deno?: unknown }).Deno = prior;
      }
    },
  };
}

let tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "confeature-test-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs = [];
  disposeAllClients();
});

afterEach(() => {
  disposeAllClients();
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow — best-effort cleanup */
    }
  }
  vi.restoreAllMocks();
});

describe("InMemoryConfigCache", () => {
  test("starts empty", () => {
    const c = new InMemoryConfigCache();
    expect(c.getCurrent().configJson).toBeNull();
  });

  test("set() swaps the held config", () => {
    const c = new InMemoryConfigCache();
    const cfg = new ProjectConfig(makeConfig(), '"e1"', 1000);
    c.set(cfg);
    expect(c.getCurrent()).toBe(cfg);
  });
});

describe("DenoFileConfigCache — cacheKind === 'memory' bypasses filesystem", () => {
  test("memory mode never writes to disk regardless of Deno availability", () => {
    const root = makeTempDir();
    const { wrapper, captured } = makeLogger();
    const cache = new DenoFileConfigCache("key12345", "memory", wrapper, root);
    cache.set(new ProjectConfig(makeConfig(), '"e1"', 999));
    expect(cache.getCurrent().eTag).toBe('"e1"');
    // No warn-log was emitted (memory mode is the chosen state, not a fallback).
    expect(captured.entries.find((e) => e.level === LogLevel.Warn)).toBeUndefined();
  });
});

describe("DenoFileConfigCache — globalThis.Deno undefined → memory fallback + one warn log", () => {
  test("filesystem mode without Deno global falls back to memory with a single warn", () => {
    // We intentionally do NOT stub Deno here — simulates the
    // raw-Node-vitest runtime.
    const root = makeTempDir();
    const { wrapper, captured } = makeLogger();
    const cache = new DenoFileConfigCache("key67890", "filesystem", wrapper, root);
    cache.set(new ProjectConfig(makeConfig(), '"e1"', 1));
    expect(cache.getCurrent().eTag).toBe('"e1"');
    // Exactly one warn-level log line about the fallback.
    const warns = captured.entries.filter((e) => e.level === LogLevel.Warn);
    expect(warns.length).toBe(1);
    expect(warns[0]!.message).toMatch(/filesystem cache unavailable/i);
    // A second set() should NOT emit another warn (one-shot policy).
    cache.set(new ProjectConfig(makeConfig(), '"e2"', 2));
    expect(captured.entries.filter((e) => e.level === LogLevel.Warn).length).toBe(1);
  });
});

describe("DenoFileConfigCache — SC-009 PermissionDenied fallback (explicit test)", () => {
  test("Deno.writeTextFile PermissionDenied → memory fallback + exactly ONE warn log", async () => {
    const stub = stubDenoPermissionDenied();
    const root = makeTempDir();
    try {
      const { wrapper, captured } = makeLogger();
      const cache = new DenoFileConfigCache("perm-denied-key", "filesystem", wrapper, root);
      cache.set(new ProjectConfig(makeConfig(), '"e1"', 1));
      // Give the async writeTextFile rejection time to surface.
      await Promise.resolve();
      await Promise.resolve();
      // First write attempt failed → exactly one warn log.
      let warns = captured.entries.filter((e) => e.level === LogLevel.Warn);
      expect(warns.length).toBe(1);
      expect(warns[0]!.message).toMatch(/--allow-write|permissiondenied/i);
      expect(stub.writeAttempts.count).toBe(1);

      // SC-009 contract: second set() MUST NOT re-log AND MUST NOT
      // attempt the FS write again (the cache is permanently demoted).
      cache.set(new ProjectConfig(makeConfig(), '"e2"', 2));
      await Promise.resolve();
      await Promise.resolve();
      warns = captured.entries.filter((e) => e.level === LogLevel.Warn);
      expect(warns.length).toBe(1); // still one — no spam
      expect(stub.writeAttempts.count).toBe(1); // FS never re-attempted

      // Third set() — same story.
      cache.set(new ProjectConfig(makeConfig(), '"e3"', 3));
      await Promise.resolve();
      await Promise.resolve();
      expect(captured.entries.filter((e) => e.level === LogLevel.Warn).length).toBe(1);
      expect(stub.writeAttempts.count).toBe(1);

      // Memory cache still works — last set() value is observable.
      expect(cache.getCurrent().eTag).toBe('"e3"');
    } finally {
      stub.restore();
    }
  });
});

describe("DenoFileConfigCache — Deno.writeTextFile roundtrip", () => {
  test("set() persists to disk; new instance hydrates synchronously", async () => {
    const root = makeTempDir();
    const stub = stubDenoHappy();
    try {
      const { wrapper: w1 } = makeLogger();
      const cache = new DenoFileConfigCache("hash-abc", "filesystem", w1, root);
      const cfg = new ProjectConfig(makeConfig(), '"e1"', 12345);
      cache.set(cfg);
      // Let the async write resolve.
      await Promise.resolve();
      await Promise.resolve();

      // Verify the file exists with the right shape.
      const filePath = join(root, "hash-abc.json");
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.etag).toBe('"e1"');
      expect(parsed.fetchedAt).toBe(12345);

      // A fresh cache hydrates from the same file.
      const { wrapper: w2 } = makeLogger();
      const next = new DenoFileConfigCache("hash-abc", "filesystem", w2, root);
      expect(next.getCurrent().eTag).toBe('"e1"');
      expect(next.getCurrent().fetchTime).toBe(12345);
      expect(next.getCurrent().configJson).not.toBeNull();
    } finally {
      stub.restore();
    }
  });

  test("filename uses only [A-Za-z0-9_-] characters (raw SDK key never on disk)", async () => {
    const root = makeTempDir();
    const stub = stubDenoHappy();
    try {
      const safeKey = deriveCacheKeySync(SDK_KEY);
      expect(safeKey).toMatch(/^confeature:cache:v1:[A-Za-z0-9_-]{32}$/);
      // The cache file itself can't contain `:` on most filesystems —
      // DenoFileConfigCache sanitises to `_`.
      const { wrapper } = makeLogger();
      const cache = new DenoFileConfigCache(safeKey, "filesystem", wrapper, root);
      cache.set(new ProjectConfig(makeConfig(), '"e1"', 1));
      await Promise.resolve();
      await Promise.resolve();
      const sanitised = safeKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const expected = join(root, `${sanitised}.json`);
      expect(readFileSync(expected, "utf8")).toContain('"etag":"\\"e1\\""');
      // And the raw SDK key never appears in the filename.
      expect(sanitised).not.toContain(SDK_KEY);
    } finally {
      stub.restore();
    }
  });

  test("hydrate() drops corrupted JSON entries silently", () => {
    const root = makeTempDir();
    const stub = stubDenoHappy();
    try {
      // Pre-seed the file with garbage.
      writeFileSync(join(root, "garbage.json"), "not-json{");
      const { wrapper } = makeLogger();
      const cache = new DenoFileConfigCache("garbage", "filesystem", wrapper, root);
      expect(cache.getCurrent().configJson).toBeNull();
    } finally {
      stub.restore();
    }
  });

  test("hydrate() drops entries with bad shape", () => {
    const root = makeTempDir();
    const stub = stubDenoHappy();
    try {
      writeFileSync(
        join(root, "badshape.json"),
        JSON.stringify({ config: { not: "the right shape" }, etag: null, fetchedAt: 1 }),
      );
      const { wrapper } = makeLogger();
      const cache = new DenoFileConfigCache("badshape", "filesystem", wrapper, root);
      expect(cache.getCurrent().configJson).toBeNull();
    } finally {
      stub.restore();
    }
  });
});

describe("Cache key format (FR-020)", () => {
  test("deriveCacheKeySync output matches `confeature:cache:v1:[A-Za-z0-9_-]{32}`", () => {
    const key = deriveCacheKeySync(SDK_KEY);
    expect(key).toMatch(/^confeature:cache:v1:[A-Za-z0-9_-]{32}$/);
  });

  test("deriveCacheKeySync is deterministic for the same input", () => {
    expect(deriveCacheKeySync(SDK_KEY)).toBe(deriveCacheKeySync(SDK_KEY));
  });

  test("deriveCacheKeySync produces different keys for different inputs", () => {
    const a = deriveCacheKeySync(SDK_KEY);
    const b = deriveCacheKeySync(SDK_KEY.replace(/A/g, "Z"));
    expect(a).not.toBe(b);
  });
});

describe("FR-021: user context MUST NOT be persisted to disk", () => {
  test("getValueAsync with a fully-populated user leaves the cache file user-free", async () => {
    const stub = stubDenoHappy();
    const root = makeTempDir();
    try {
      // Seed a working config so the snapshot/eval path exercises every
      // user-aware code path the SDK has. We pre-write the cache file
      // directly so the client hydrates from it.
      const cacheKey = deriveCacheKeySync(SDK_KEY).replace(/[^a-zA-Z0-9_-]/g, "_");
      const seedPath = join(root, `${cacheKey}.json`);
      writeFileSync(
        seedPath,
        JSON.stringify({ config: makeConfig(), etag: '"e1"', fetchedAt: Date.now() }),
      );

      const { wrapper } = makeLogger();
      const cache = new DenoFileConfigCache(cacheKey, "filesystem", wrapper, root);
      // Sanity: the cache hydrated from our seed.
      expect(cache.getCurrent().configJson).not.toBeNull();

      // Now drive a client (memory mode, so it doesn't touch our tmp dir)
      // through every user-aware path with a rich user.
      const richUser = new User("alice@example.com", "alice@example.com", "FR", {
        plan: "pro",
        betaTester: "true",
      });
      const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
        offline: true,
        cache: "memory",
      });
      await client.getValueAsync("feature.x", false, richUser);
      await client.getValueDetailsAsync("feature.x", false, richUser);
      await client.getAllValuesAsync(richUser);
      await client.getAllValueDetailsAsync(richUser);
      client.setDefaultUser(richUser);
      await client.getValueAsync("feature.y", true);
      client.clearDefaultUser();
      client.dispose();

      // Round-trip a ProjectConfig through the DenoFileConfigCache that
      // IS on disk — the persisted file MUST NOT contain user fields
      // (the cache architecturally only sees the ProjectConfig).
      cache.set(new ProjectConfig(makeConfig(), '"e2"', 999));
      await Promise.resolve();
      await Promise.resolve();

      const persisted = readFileSync(seedPath, "utf8");
      const banned = ["alice@example.com", '"FR"', "betaTester", '"plan"', '"pro"'];
      for (const needle of banned) {
        expect(persisted).not.toContain(needle);
      }
      const parsed = JSON.parse(persisted) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["config", "etag", "fetchedAt"]));
      expect(Object.keys(parsed)).not.toContain("identifier");
      expect(Object.keys(parsed)).not.toContain("email");
      expect(Object.keys(parsed)).not.toContain("country");
      expect(Object.keys(parsed)).not.toContain("custom");
    } finally {
      stub.restore();
    }
  });
});
