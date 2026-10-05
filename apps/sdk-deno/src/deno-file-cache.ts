// SPDX-License-Identifier: MIT

import {
  type IConfig,
  isConfigShape,
  type LoggerWrapper,
  ProjectConfig,
} from "@confeature/sdk-shared";
import { readFileSync } from "node:fs";

import { InMemoryConfigCache } from "./memory-cache.ts";

/**
 * On-disk shape of the cache entry.
 *
 * SECURITY (FR-021): only the configuration blob, ETag, and fetch
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

/** Public cache root — `${Deno.env.get('TMPDIR') ?? '/tmp'}/confeature-cache-v1/`. */
export const CACHE_DIR_NAME = "confeature-cache-v1";

/**
 * Minimal structural typing for the slice of the `Deno` global the
 * cache actually uses. Keeping the surface narrow lets vitest stub
 * exactly what it needs without dragging the whole `@types/deno`
 * surface into the test scaffolding.
 *
 * We type `globalThis.Deno` as `unknown` and feature-detect at runtime
 * rather than `declare global { const Deno: ... }` so that:
 *  - the module typechecks under `@types/deno`, AND
 *  - the production code path tolerates `globalThis.Deno === undefined`
 *    (the case when running under Node — i.e. our vitest harness).
 */
interface DenoErrorClass extends ErrorConstructor {
  // marker class — instances are matched via `instanceof`
  prototype: Error;
}

interface DenoSubset {
  writeTextFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  env: { get: (name: string) => string | undefined };
  errors: {
    PermissionDenied: DenoErrorClass;
    NotCapable?: DenoErrorClass;
    NotFound: DenoErrorClass;
  };
}

function getDeno(): DenoSubset | undefined {
  const candidate = (globalThis as { Deno?: unknown }).Deno;
  if (!candidate || typeof candidate !== "object") return undefined;
  const d = candidate as Partial<DenoSubset>;
  if (
    typeof d.writeTextFile !== "function" ||
    typeof d.mkdir !== "function" ||
    !d.env ||
    typeof d.env.get !== "function" ||
    !d.errors
  ) {
    return undefined;
  }
  return d as DenoSubset;
}

/**
 * Resolve the default cache root: `${Deno.env.get('TMPDIR') ?? '/tmp'}/confeature-cache-v1/`.
 *
 * If `Deno.env.get` throws `PermissionDenied` (no `--allow-env`), we
 * default to `/tmp` (POSIX) — the actual write path will then itself
 * detect missing permissions and fall back to memory.
 */
export function resolveDefaultCacheRoot(): string {
  const deno = getDeno();
  if (deno === undefined) {
    return joinPath("/tmp", CACHE_DIR_NAME);
  }
  let tmp: string | undefined;
  try {
    tmp = deno.env.get("TMPDIR");
  } catch {
    // PermissionDenied on env access — fall back to POSIX default.
    tmp = undefined;
  }
  return joinPath(tmp ?? "/tmp", CACHE_DIR_NAME);
}

function joinPath(a: string, b: string): string {
  if (a.endsWith("/")) return `${a}${b}`;
  return `${a}/${b}`;
}

/**
 * Deno-flavoured cache. Wraps an in-memory cache for hot reads + a
 * `Deno.writeTextFile`-backed slot for persistence across processes.
 *
 * Behaviour (research §R3 + §R4):
 *  - Constructor hydrates synchronously from disk via `node:fs.readFileSync`
 *    (Deno supports node:fs at runtime, and tests run under Node where
 *    this works directly — same pattern as sdk-bun) so the very first
 *    `getValueAsync()` after `new ConfeatureClient(...)` returns the
 *    cached value without waiting for the network.
 *  - `set()` writes through to disk via `Deno.writeTextFile(...)`
 *    whenever the runtime is healthy AND the necessary permissions
 *    are granted. On any of:
 *      - `Deno.errors.PermissionDenied` (no `--allow-write` / `--allow-env`)
 *      - `Deno.errors.NotCapable` (Deno Deploy sandbox)
 *      - `Deno.errors.NotFound` on directory creation
 *      - `globalThis.Deno === undefined` (running under raw Node — our
 *        vitest harness)
 *    the cache demotes silently to memory-only AND emits exactly ONE
 *    warn log per process lifetime (research §R3 + §R4). Subsequent
 *    writes skip the FS without re-logging (the SC-009 contract).
 *  - When `cacheKind === "memory"`, the disk path is bypassed entirely
 *    and the cache behaves as a pure in-memory store.
 *
 * The cache filename is derived elsewhere (via `deriveCacheKey` in the
 * shared sdk-key utilities) — keeping the SDK-key → key hashing in one
 * place. The raw SDK key never appears on disk (FR-020).
 */
export class DenoFileConfigCache {
  private readonly memory = new InMemoryConfigCache();
  private filesystemEnabled: boolean;
  private fallbackWarned = false;
  private readonly cachePath: string | null;
  private readonly logger: LoggerWrapper;
  private readonly deno: DenoSubset | undefined;

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
    cacheRoot: string = resolveDefaultCacheRoot(),
  ) {
    this.logger = logger;
    this.deno = getDeno();
    this.filesystemEnabled = cacheKind === "filesystem";
    if (!this.filesystemEnabled) {
      this.cachePath = null;
      return;
    }
    if (this.deno === undefined) {
      // Running under Node (vitest) or a runtime without the Deno
      // global — drop to memory immediately with the one-warn policy.
      this.cachePath = null;
      this.demoteToMemory("globalThis.Deno is undefined in this runtime");
      return;
    }
    const safeBaseName = cacheFileBaseName.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.cachePath = joinPath(cacheRoot, `${safeBaseName}.json`);

    // Hydrate synchronously BEFORE attempting the (async) mkdir +
    // write — this matches sdk-bun's posture (synchronous hydrate via
    // node:fs.readFileSync so the first getValueAsync resolves from
    // cache without a network wait — research §R13 inherited from
    // spec 031).
    this.hydrate();

    // Trigger directory creation (fire-and-forget). On failure, demote
    // to memory + emit one warn log.
    const mkdirOut = this.deno.mkdir(cacheRoot, { recursive: true });
    if (mkdirOut && typeof mkdirOut.catch === "function") {
      mkdirOut.catch((err: unknown) => {
        if (this.isPermissionLike(err)) {
          this.demoteToMemory(
            `cannot create cache directory (${describeError(err)}); needs --allow-write`,
          );
        } else if (this.isNotFoundLike(err)) {
          // NotFound on mkdir(recursive) is unusual but documented as
          // possible on some filesystems — same fallback policy.
          this.demoteToMemory(`cannot create cache directory (${describeError(err)})`);
        } else {
          this.demoteToMemory(`cannot create cache directory (${describeError(err)})`);
        }
      });
    }
  }

  /** Currently-held config. Never null; `ProjectConfig.empty()` if no data. */
  getCurrent(): ProjectConfig {
    return this.memory.getCurrent();
  }

  /**
   * Atomic in-memory swap + write-through to `Deno.writeTextFile`. Disk
   * failure (no `--allow-write`, sandbox, quota, read-only) is
   * non-fatal: the in-memory copy is always updated; the disk slot
   * stays stale silently after one warn-level log.
   */
  set(next: ProjectConfig): void {
    this.memory.set(next);
    if (!this.filesystemEnabled || this.cachePath === null || next.configJson === null) return;
    if (this.deno === undefined) {
      this.demoteToMemory("globalThis.Deno is unavailable in this runtime");
      return;
    }
    const entry: CachedEntry = {
      config: next.configJson,
      etag: next.eTag,
      fetchedAt: next.fetchTime,
    };
    let out: Promise<void>;
    try {
      out = this.deno.writeTextFile(this.cachePath, JSON.stringify(entry));
    } catch (err) {
      // Deno.writeTextFile is async — synchronous throws here are
      // unusual but possible (e.g. when a stub rejects synchronously).
      if (this.isPermissionLike(err)) {
        this.demoteToMemory(
          `Deno.writeTextFile denied (${describeError(err)}); needs --allow-write`,
        );
      } else {
        this.demoteToMemory(`Deno.writeTextFile threw synchronously (${describeError(err)})`);
      }
      return;
    }
    if (out && typeof out.catch === "function") {
      out.catch((err: unknown) => {
        if (this.isPermissionLike(err)) {
          this.demoteToMemory(
            `Deno.writeTextFile denied (${describeError(err)}); needs --allow-write`,
          );
        } else {
          this.demoteToMemory(`Deno.writeTextFile failed asynchronously (${describeError(err)})`);
        }
      });
    }
  }

  private hydrate(): void {
    if (!this.filesystemEnabled || this.cachePath === null) return;
    let raw: string;
    try {
      // `node:fs.readFileSync` works under both Deno (via its node
      // compat layer) and Node (our vitest harness). Same posture as
      // sdk-bun's hydrate path.
      raw = readFileSync(this.cachePath, "utf8");
    } catch (err) {
      // ENOENT / NotFound is normal on first run — no warn-log, just
      // no hydrate.
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
   * after a single warn-level log (research §R3 + §R7).
   *
   * **One warn-log per process lifetime** — subsequent demote calls
   * are silent. This is the SC-009 contract.
   */
  private demoteToMemory(reason: string): void {
    this.filesystemEnabled = false;
    if (this.fallbackWarned) return;
    this.fallbackWarned = true;
    this.logger.configWarn(`Filesystem cache unavailable; falling back to memory. (${reason})`);
  }

  /**
   * `err instanceof Deno.errors.PermissionDenied` (or NotCapable —
   * Deno Deploy sandbox). Falls back to a name-string check when
   * the prototype chain is unavailable (e.g. stubbed in tests).
   */
  private isPermissionLike(err: unknown): boolean {
    if (this.deno !== undefined) {
      if (err instanceof this.deno.errors.PermissionDenied) return true;
      if (this.deno.errors.NotCapable && err instanceof this.deno.errors.NotCapable) return true;
    }
    if (err instanceof Error) {
      if (err.name === "PermissionDenied") return true;
      if (err.name === "NotCapable") return true;
    }
    return false;
  }

  private isNotFoundLike(err: unknown): boolean {
    if (this.deno !== undefined && err instanceof this.deno.errors.NotFound) return true;
    if (err instanceof Error && err.name === "NotFound") return true;
    return false;
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
  if (code === "ENOENT") return true;
  // Deno's `node:fs` shim may surface the NotFound name on the Error.
  if (err instanceof Error && err.name === "NotFound") return true;
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
