// SPDX-License-Identifier: MIT

/**
 * WranglerHost — wraps a wrangler `unstable_dev` instance hosting the upstream
 * Worker (the reference origin by default, the private CDN Worker on opt-in, #861),
 * plus a `getPlatformProxy` that exposes KV bindings for in-process
 * seeding from the harness's admin endpoints.
 *
 * Why two wrangler entry points?
 *   - `unstable_dev` runs the Worker on a real Miniflare instance on a
 *     known port. This is what SDK tests target over HTTP.
 *   - `getPlatformProxy` (used transiently per admin call) opens KV
 *     bindings against the SAME persist directory; when the namespace
 *     ID matches the preview_id from wrangler.toml, the two layers see
 *     the same KV store.
 *
 * Seeds are written under the KV key the CDN Worker reads, computed by the
 * harness's own copy of `configKey()` below. The upstream's source is NEVER
 * modified (FR-011).
 */

import { unstable_dev, unstable_readConfig } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { spawn } from "node:child_process";
import type { SeededKey } from "./types.js";

/**
 * Resolve `npx` to an absolute path by scanning `PATH` once at startup,
 * instead of spawning the bare command name (#340, supply-chain hardening).
 * Pinning the resolved path at boot means a `PATH` entry that is shadowed or
 * mutated mid-run can't swap the binary the harness executes on every seed.
 * Throws a clear error if no `npx` is found — the harness refuses to guess.
 *
 * Exported for unit-testing the resolution-failure path with a crafted env.
 */
export function resolveNpx(env: NodeJS.ProcessEnv = process.env): string {
  const pathVar = env.PATH ?? env.Path ?? "";
  // Windows resolves command names against PATHEXT; cover the common npx shims.
  const names = process.platform === "win32" ? ["npx.cmd", "npx.exe", "npx"] : ["npx"];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // not in this dir — keep scanning
      }
    }
  }
  throw new Error(
    "WranglerHost: could not resolve `npx` to an absolute path on PATH — refusing to " +
      "spawn a bare `npx` (#340, supply-chain hardening). Ensure Node/npm is installed and on PATH.",
  );
}

/**
 * Compute the KV key the CDN Worker reads for a given SDK key. A copy of
 * `configKey` in packages/contract/src/kv-keys.ts, which the private API and
 * CDN Workers import. DO NOT import it: the harness moves to the public repo
 * and that source stays private (ADR 0006). The copy must stay byte-equal;
 * packages/contract/tests/contract.test.ts compares the two (#811).
 */
function configKey(sdkKey: string): string {
  return `sdk:${sdkKey}:config_v6`;
}

/**
 * The `wrangler kv` flags that reach the namespace `unstable_dev --local`
 * binds as CONFIG_KV, read from the upstream's wrangler.toml (#861):
 *   - a config with a `preview_id` (the CDN Worker's): `--binding=CONFIG_KV --preview`,
 *     the namespace `unstable_dev --local` reads;
 *   - a config with no id at all (the reference origin, which must carry none,
 *     ADR 0006 Q1): local dev names the namespace after its binding, so
 *     `--namespace-id=CONFIG_KV`.
 * Anything else (no CONFIG_KV binding, or an `id` with no `preview_id`) is
 * refused rather than guessed: a seed written to the wrong namespace makes
 * every request a miss while /admin/reset answers ok.
 */
export function kvNamespaceArgs(configPath: string): string[] {
  const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  const namespaces: Array<{ binding: string; id?: string; preview_id?: string }> =
    config.kv_namespaces;
  const ns = namespaces.find((n) => n.binding === "CONFIG_KV");
  if (!ns) throw new Error(`WranglerHost: ${configPath} declares no CONFIG_KV binding`);
  if (ns.preview_id) return ["--binding=CONFIG_KV", "--preview"];
  if (ns.id === undefined) return ["--namespace-id=CONFIG_KV"];
  throw new Error(
    `WranglerHost: ${configPath} gives CONFIG_KV an id but no preview_id; ` +
      "declare both, or neither (a local-only upstream)",
  );
}

/** One KV record as `wrangler kv bulk put` takes it. */
export type KvRecord = { key: string; value: string; metadata?: Record<string, string> };

export type WranglerHostConfig = {
  /** Absolute path to the upstream Worker's entry (the reference origin by default). */
  scriptPath: string;
  /** Absolute path to that Worker's wrangler.toml. */
  configPath: string;
};

export class WranglerHost {
  private readonly config: WranglerHostConfig;
  private worker: Unstable_DevWorker | null = null;
  private persistDir = "";
  private bulkSeq = 0;
  /** Absolute path to `npx`, resolved once at start() (#340). */
  private npxPath = "";
  /** The `wrangler kv` namespace flags, resolved once at start() (#861). */
  private kvArgs: string[] = [];

  constructor(config: WranglerHostConfig) {
    this.config = config;
  }

  /**
   * Boot wrangler dev. Returns when the Worker is ready to receive
   * fetches.
   */
  async start(): Promise<void> {
    // Pin npx to an absolute path before any subprocess can run, and log it
    // once for auditability (#340).
    this.npxPath = resolveNpx();
    console.warn(`[lc-harness] resolved npx → ${this.npxPath}`);
    this.kvArgs = kvNamespaceArgs(this.config.configPath);
    this.persistDir = await mkdtemp(join(tmpdir(), "lc-harness-"));
    this.worker = await unstable_dev(this.config.scriptPath, {
      config: this.config.configPath,
      ip: "127.0.0.1",
      port: 0,
      local: true,
      persist: true,
      persistTo: this.persistDir,
      experimental: { disableExperimentalWarning: true },
      logLevel: "warn",
    });
  }

  /** "127.0.0.1:<port>" of the wrangler-managed Worker. */
  workerUrl(): string {
    if (!this.worker) throw new Error("WranglerHost not started");
    return `http://${this.worker.address}:${this.worker.port}`;
  }

  /**
   * Forward a request to the Worker via wrangler's `fetch`.
   * Caller owns the returned Response (body must be read).
   */
  async dispatchFetch(req: Request): Promise<Response> {
    if (!this.worker) throw new Error("WranglerHost not started");
    // unstable_dev's worker.fetch uses undici's RequestInit shape which
    // differs subtly from Node's lib.dom types. Cast through `unknown`
    // since the shape we pass is structurally identical at runtime.
    const init = {
      method: req.method,
      headers: req.headers,
    } as unknown as Parameters<Unstable_DevWorker["fetch"]>[1];
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      (init as { body?: unknown; duplex?: string }).body = req.body;
      (init as { body?: unknown; duplex?: string }).duplex = "half";
    }
    return this.worker.fetch(req.url, init) as unknown as Response;
  }

  /**
   * Seed (or overwrite) the listed KV records — ONE `wrangler kv bulk put`
   * for every non-null payload, ONE `bulk delete` for every null payload,
   * regardless of how many keys (plan 680, decision row 10). Each wrangler
   * subprocess costs ~700-1000 ms, and the harness suite runs twice per
   * pre-push, so a per-key loop was the dominant cost of every reset.
   *
   * Uses subprocess rather than getPlatformProxy: getPlatformProxy writes to
   * the production-id KV namespace, whereas `unstable_dev --local` reads from
   * the preview-id namespace; `wrangler kv ... --preview` writes to the one
   * `unstable_dev --local` reads from. `bulk put` carries per-entry metadata
   * (etag / lastModified — the management API's ConfigKvMetadata), verified 2026-09-26 on wrangler
   * 4.100.0.
   */
  async seed(keys: SeededKey[]): Promise<void> {
    if (!this.persistDir) throw new Error("WranglerHost not started");
    const puts: KvRecord[] = [];
    const deletes: string[] = [];
    for (const k of keys) {
      const kvKey = configKey(k.sdkKey);
      if (k.payload === null) {
        deletes.push(kvKey);
        continue;
      }
      const metadata: Record<string, string> = {};
      if (k.etag) metadata["etag"] = k.etag;
      if (k.lastModified) metadata["lastModified"] = k.lastModified;
      puts.push({
        key: kvKey,
        value: JSON.stringify(k.payload),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }
    await this.putRecords(puts);
    if (deletes.length > 0) await this.runBulk("delete", deletes);
  }

  /**
   * Write KV records exactly as given — key, value bytes and metadata — in
   * one `wrangler kv bulk put`. `seed()` computes its records and lands here;
   * tests/reference-origin-transcript.test.ts writes the transcript's recorded
   * records through it unchanged (#861).
   */
  async putRecords(records: KvRecord[]): Promise<void> {
    if (!this.persistDir) throw new Error("WranglerHost not started");
    if (records.length > 0) await this.runBulk("put", records);
  }

  /** Drop all keys: one `list`, then one `bulk delete`. */
  async clear(): Promise<void> {
    if (!this.persistDir) throw new Error("WranglerHost not started");
    const listed = await this.runWranglerKv(["key", "list"], { captureStdout: true });
    let names: string[];
    try {
      const parsed = JSON.parse(listed ?? "[]") as Array<{ name: string }>;
      names = parsed.map((k) => k.name);
    } catch (err) {
      // Never "best effort": an unread listing treated as empty leaves stale
      // keys in KV while /admin/reset answers ok — the reset would lie.
      throw new Error(
        `wrangler kv key list returned unparseable output: ${JSON.stringify((listed ?? "").slice(0, 200))}`,
        { cause: err },
      );
    }
    if (names.length > 0) await this.runBulk("delete", names);
  }

  /**
   * Write `entries` to a per-call file in the persist dir and hand it to
   * `wrangler kv bulk <verb>`. The name comes from a counter, never from a
   * key, so no sdkKey reaches the filesystem and two concurrent writes never
   * share a file.
   */
  private async runBulk(verb: "put" | "delete", entries: unknown[]): Promise<void> {
    const file = join(this.persistDir, `_bulk-${verb}-${++this.bulkSeq}.json`);
    await writeFile(file, JSON.stringify(entries));
    await this.runWranglerKv(
      verb === "delete" ? ["bulk", verb, file, "--force"] : ["bulk", verb, file],
    );
  }

  /**
   * Invoke `wrangler kv <group> <verb>` (group: `key` | `bulk`) <kvNamespaceArgs> --local
   * --persist-to=<persistDir>` with sane defaults. cwd is the directory
   * containing the wrangler.toml so wrangler picks it up automatically.
   */
  private async runWranglerKv(
    args: string[],
    opts?: { captureStdout?: boolean },
  ): Promise<string | null> {
    const cwd = dirname(this.config.configPath);
    const fullArgs = [
      "wrangler",
      "kv",
      ...args,
      ...this.kvArgs,
      "--local",
      `--persist-to=${this.persistDir}`,
    ];
    // wrangler kv key list already emits JSON by default; no extra flag needed.
    if (!this.npxPath) throw new Error("WranglerHost not started (npx unresolved)");
    return await new Promise<string | null>((resolve, reject) => {
      const proc = spawn(this.npxPath, fullArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf-8");
      });
      proc.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf-8");
      });
      proc.once("error", reject);
      proc.once("close", (code) => {
        if (code === 0) resolve(opts?.captureStdout ? stdout : null);
        else reject(new Error(`wrangler kv ${args.join(" ")} exited ${code}: ${stderr}`));
      });
    });
  }

  async dispose(): Promise<void> {
    // Both steps always run, and neither failure hides the other: a worker
    // that failed to stop AND a temp dir that failed to go are two leaks.
    const worker = this.worker;
    const dir = this.persistDir;
    this.worker = null;
    this.persistDir = "";
    const errors: unknown[] = [];
    try {
      await worker?.stop();
    } catch (err) {
      errors.push(err);
    }
    if (dir) {
      try {
        // `force: true` already ignores a missing directory, so a rejection
        // here is a real failure (a leaked temp dir), never swallowed.
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "WranglerHost dispose failed");
  }
}
