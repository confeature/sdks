// SPDX-License-Identifier: MIT

import {
  type IConfig,
  isConfigShape,
  type LoggerWrapper,
  ProjectConfig,
} from "@confeature/sdk-shared";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryConfigCache } from "./memory-cache.ts";

/**
 * On-disk shape of the cache entry.
 *
 * SECURITY (FR-020): only the configuration blob, ETag, and fetch
 * timestamp may be persisted. User context is forbidden.
 */
interface CachedEntry {
  /** Parsed config_v6.json wire payload (already shape-checked). */
  config: IConfig;
  /** ETag of the config that produced this entry (or `null` if absent). */
  etag: string | null;
  /** Wall-clock time at which `config` was fetched. */
  fetchedAt: number;
}

/** Public cache root — `${os.tmpdir()}/confeature-cache-v1/`. */
export const CACHE_DIR_NAME = "confeature-cache-v1";

/**
 * Bun-flavoured cache. Wraps an in-memory cache for hot reads + a
 * `Bun.file()`-backed slot for persistence across processes.
 *
 * Behaviour (research §R4 + §R7):
 *  - Constructor hydrates synchronously from disk so the very first
 *    `getValueAsync()` after `new ConfeatureClient(...)` returns the
 *    cached value without waiting for the network (research §R13 from
 *    spec 031 — instant first paint, no FOUC).
 *  - `set()` writes through to disk via `Bun.write(...)` whenever the
 *    filesystem is healthy; on write failure (quota / read-only FS),
 *    falls back silently to memory-only AND emits one warn log
 *    (research §R7).
 *  - When `cacheKind === "memory"`, the disk path is bypassed entirely
 *    and the cache behaves as a pure in-memory store.
 *  - When the cache directory cannot be created on first call, the
 *    cache is demoted to memory-only for the rest of its lifetime
 *    (same warn-log policy).
 *
 * The cache filename is derived elsewhere (via `deriveCacheKey` in the
 * shared sdk-key utilities) — keeping the SDK-key → key hashing in one
 * place. The raw SDK key never appears on disk (FR-019).
 */
export class BunFileConfigCache {
  private readonly memory = new InMemoryConfigCache();
  private filesystemEnabled: boolean;
  private fallbackWarned = false;
  private readonly cachePath: string | null;
  private readonly logger: LoggerWrapper;

  /**
   * @param cacheFileBaseName  Already-hashed safe filename (no SDK key).
   * @param cacheKind          `"filesystem"` or `"memory"`.
   * @param logger             Configured logger for the warn-on-fallback path.
   * @param cacheRoot          Override for the cache root dir (tests inject `/tmp/...`).
   */
  constructor(
    cacheFileBaseName: string,
    cacheKind: "filesystem" | "memory",
    logger: LoggerWrapper,
    cacheRoot: string = join(tmpdir(), CACHE_DIR_NAME),
  ) {
    this.logger = logger;
    this.filesystemEnabled = cacheKind === "filesystem";
    if (!this.filesystemEnabled) {
      this.cachePath = null;
      return;
    }
    const safeBaseName = cacheFileBaseName.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.cachePath = join(cacheRoot, `${safeBaseName}.json`);
    try {
      mkdirSync(cacheRoot, { recursive: true });
    } catch (err) {
      this.demoteToMemory(`cannot create cache directory (${describeError(err)})`);
      return;
    }
    this.hydrate();
  }

  /** Currently-held config. Never null; `ProjectConfig.empty()` if no data. */
  getCurrent(): ProjectConfig {
    return this.memory.getCurrent();
  }

  /**
   * Atomic in-memory swap + write-through to `Bun.file()`. Disk
   * failure (quota / read-only) is non-fatal: the in-memory copy is
   * always updated; the disk slot stays stale silently after one
   * warn-level log.
   */
  set(next: ProjectConfig): void {
    this.memory.set(next);
    if (!this.filesystemEnabled || this.cachePath === null || next.configJson === null) return;
    const entry: CachedEntry = {
      config: next.configJson,
      etag: next.eTag,
      fetchedAt: next.fetchTime,
    };
    // `Bun.write` exists at runtime when running under Bun; we type-
    // guard via the optional global to keep TS happy under @types/bun.
    const bunWrite = (globalThis as { Bun?: { write: (path: string, data: string) => unknown } })
      .Bun?.write;
    if (typeof bunWrite !== "function") {
      this.demoteToMemory("Bun.write is unavailable in this runtime");
      return;
    }
    try {
      const out = bunWrite(this.cachePath, JSON.stringify(entry));
      // Bun.write returns a Promise — log but don't await; failures
      // bubble through the unhandledRejection path on Bun, which is
      // fine because the memory copy is already authoritative.
      if (out !== undefined && typeof (out as Promise<number>).catch === "function") {
        (out as Promise<number>).catch((err: unknown) => {
          this.demoteToMemory(`Bun.write failed asynchronously (${describeError(err)})`);
        });
      }
    } catch (err) {
      this.demoteToMemory(`Bun.write threw synchronously (${describeError(err)})`);
    }
  }

  private hydrate(): void {
    if (!this.filesystemEnabled || this.cachePath === null) return;
    let raw: string;
    try {
      raw = readFileSync(this.cachePath, "utf8");
    } catch (err) {
      // ENOENT is normal on first run — no warn-log, just no hydrate.
      if (isFileNotFoundError(err)) return;
      this.demoteToMemory(`hydrate read failed (${describeError(err)})`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted entry — silently ignore. A subsequent successful
      // `set()` will overwrite the file.
      return;
    }
    if (!isCachedEntry(parsed)) return;
    const cfg = new ProjectConfig(parsed.config, parsed.etag, parsed.fetchedAt);
    this.memory.set(cfg);
  }

  /**
   * Permanently disable the filesystem path for this cache instance
   * after a single warn-level log (research §R7).
   */
  private demoteToMemory(reason: string): void {
    this.filesystemEnabled = false;
    if (this.fallbackWarned) return;
    this.fallbackWarned = true;
    this.logger.configWarn(`Filesystem cache unavailable; falling back to memory. (${reason})`);
  }
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CachedEntry>;
  if (typeof v.fetchedAt !== "number") return false;
  if (v.etag !== null && typeof v.etag !== "string") return false;
  return isConfigShape(v.config);
}

function isFileNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
