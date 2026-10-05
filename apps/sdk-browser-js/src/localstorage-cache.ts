// SPDX-License-Identifier: MIT

import {
  type IConfig,
  isConfigShape,
  type LoggerWrapper,
  ProjectConfig,
} from "@confeature/sdk-shared";

import { InMemoryConfigCache } from "./memory-cache.ts";

/**
 * On-disk shape of the `localStorage` cache entry.
 *
 * SECURITY (FR-019): only the configuration blob, ETag, and fetch
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

/**
 * Browser-flavoured cache. Wraps an in-memory cache for hot reads + a
 * `localStorage` slot for persistence across page reloads.
 *
 * Behaviour:
 *  - Constructor hydrates synchronously from `localStorage` so the very
 *    first `getValueAsync()` call after `new ConfigCatClient(...)`
 *    returns the cached value without waiting for the network
 *    (research §R13 — instant first paint / no FOUC).
 *  - `set()` writes through to `localStorage` whenever the storage is
 *    healthy; on `setItem` failure (quota / private mode), falls back
 *    silently to memory-only.
 *  - When `cacheKind === "memory"`, `localStorage` is bypassed entirely
 *    and the cache behaves as a pure in-memory store.
 *
 * The cache key is derived elsewhere (via `deriveCacheKey` in the
 * shared sdk-key utilities) and supplied to the constructor — keeping
 * the SDK-key → key hashing in one place.
 */
export class BrowserConfigCache {
  private readonly memory = new InMemoryConfigCache();
  private storage: Storage | null;
  private readonly storageKey: string;
  private readonly logger: LoggerWrapper;

  constructor(storageKey: string, cacheKind: "localStorage" | "memory", logger: LoggerWrapper) {
    this.storageKey = storageKey;
    this.logger = logger;
    this.storage = cacheKind === "memory" ? null : detectLocalStorage();
    this.hydrate();
  }

  /** Currently-held config. Never null; `ProjectConfig.empty()` if no data. */
  getCurrent(): ProjectConfig {
    return this.memory.getCurrent();
  }

  /**
   * Atomic in-memory swap + write-through to `localStorage`. Storage
   * failure (quota / private mode) is non-fatal: the in-memory copy is
   * always updated; the `localStorage` slot stays stale silently.
   */
  set(next: ProjectConfig): void {
    this.memory.set(next);
    if (!this.storage || next.configJson === null) return;
    const entry: CachedEntry = {
      config: next.configJson,
      etag: next.eTag,
      fetchedAt: next.fetchTime,
    };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(entry));
    } catch (err) {
      // Quota exceeded, private mode, or storage suddenly disabled.
      // Demote to memory-only for the lifetime of this client.
      this.logger.configWarn(
        `localStorage write failed; demoting to memory-only cache. (${describeError(err)})`,
      );
      this.storage = null;
    }
  }

  /** Drop the persisted entry. Used by tests + on parse-failure cleanup. */
  clearPersisted(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* swallow — storage may have been revoked mid-session */
    }
  }

  private hydrate(): void {
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (err) {
      this.logger.configWarn(
        `localStorage read failed; falling back to memory cache. (${describeError(err)})`,
      );
      this.storage = null;
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted entry — drop it and start fresh.
      this.clearPersisted();
      return;
    }
    if (!isCachedEntry(parsed)) {
      this.clearPersisted();
      return;
    }
    const cfg = new ProjectConfig(parsed.config, parsed.etag, parsed.fetchedAt);
    this.memory.set(cfg);
  }
}

/**
 * Returns `globalThis.localStorage` if it exists AND a probe write
 * succeeds. Private-mode Safari and embedded WebViews expose the
 * property but throw on `setItem` — the probe catches both.
 */
function detectLocalStorage(): Storage | null {
  const g = globalThis as typeof globalThis & { localStorage?: Storage };
  const ls = g.localStorage;
  if (!ls) return null;
  const probeKey = "__confeature_probe__";
  try {
    ls.setItem(probeKey, "1");
    ls.removeItem(probeKey);
    return ls;
  } catch {
    return null;
  }
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CachedEntry>;
  if (typeof v.fetchedAt !== "number") return false;
  if (v.etag !== null && typeof v.etag !== "string") return false;
  return isConfigShape(v.config);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
