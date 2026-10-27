// SPDX-License-Identifier: MIT

/**
 * Harness orchestrator — `startHarness(config)` boots Miniflare,
 * applies the initial seed, then opens the proxy server.
 *
 * Returns `{ url, stop }`. `stop()` is idempotent and runs Miniflare
 * dispose + server close in parallel with a `shutdownGrace` deadline.
 */

import { WranglerHost } from "./wrangler-host.js";
import { AdminState } from "./admin-routes.js";
import { startProxyServer, type ProxyServer } from "./proxy-server.js";
import { applySeed } from "./seed-applier.js";
import type { HarnessConfig, HarnessHandle } from "./types.js";

const DEFAULT_SHUTDOWN_GRACE = 5_000;

export class HarnessShutdownTimeout extends Error {
  constructor(ms: number) {
    super(`harness teardown exceeded ${ms} ms`);
    this.name = "HarnessShutdownTimeout";
  }
}

/**
 * A `HarnessConfig` that cannot name its upstream Worker. Typed, so a caller
 * can tell a configuration mistake from a boot failure, and carrying the
 * missing field's name.
 *
 * Why it exists (#858): the harness no longer depends on the private CDN
 * Worker, so nothing may stand in for a missing `cdnEntry`. Left unchecked,
 * Wrangler would boot whatever the wrangler.toml's `main` names, which is a
 * silent default under another name.
 */
export class HarnessConfigError extends Error {
  readonly field: "cdnEntry" | "cdnConfigPath";

  constructor(field: "cdnEntry" | "cdnConfigPath", what: string) {
    super(`HarnessConfig.${field} is required (${what}); referenceOrigin() supplies both.`);
    this.name = "HarnessConfigError";
    this.field = field;
  }
}

/** Both upstream paths are given and non-empty, before anything boots. */
function assertUpstream(config: HarnessConfig): void {
  if (!config.cdnEntry) throw new HarnessConfigError("cdnEntry", "the upstream Worker's entry");
  if (!config.cdnConfigPath) {
    throw new HarnessConfigError("cdnConfigPath", "the upstream Worker's wrangler.toml");
  }
}

export async function startHarness(config: HarnessConfig): Promise<HarnessHandle> {
  const port = config.bindPort ?? 0;
  const shutdownGrace = config.shutdownGrace ?? DEFAULT_SHUTDOWN_GRACE;
  const cwd = process.cwd();

  assertUpstream(config);

  const host = new WranglerHost({
    scriptPath: config.cdnEntry,
    configPath: config.cdnConfigPath,
  });
  // The fault state exists before the proxy so the boot seed is applied the
  // same way a reset applies one — KV and faults together (plan 680). Seeding
  // sits inside the try: ANY start failure disposes the host, instead of
  // leaking a worker or a temp dir.
  const state = new AdminState();
  let proxy: ProxyServer;
  try {
    // start() is inside the try as well: it creates the temp dir before it
    // boots the worker, so a failed boot must still dispose it.
    await host.start();
    if (config.initialSeed) {
      await applySeed({ host, state }, config.initialSeed.keys, "boot");
    }
    proxy = await startProxyServer(host, cwd, port, state);
  } catch (err) {
    return await failAfterCleanup(err, [host.dispose()]);
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const teardown = settleTeardown([proxy.close(), host.dispose()], "harness teardown failed");
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new HarnessShutdownTimeout(shutdownGrace)), shutdownGrace).unref();
    });
    await Promise.race([teardown, deadline]);
  };

  // What the boot seed declares a suite must exercise: every key it seeds.
  const declared = (config.initialSeed?.keys ?? []).map((k) => k.sdkKey);
  return {
    url: proxy.url,
    stop,
    served: () => state.served,
    unserved: () => state.unserved(declared),
  };
}

/**
 * Wait for every teardown step, then report every failure at once. A teardown
 * error was previously swallowed (`.catch(() => undefined)`), which hid a
 * leaked worker or port behind a clean stop().
 */
export async function settleTeardown(steps: Promise<unknown>[], message: string): Promise<void> {
  const results = await Promise.allSettled(steps);
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

/**
 * Rethrow a start failure after cleaning up. The start error stays first; a
 * cleanup failure is reported beside it rather than swallowed.
 */
export async function failAfterCleanup(err: unknown, cleanup: Promise<unknown>[]): Promise<never> {
  try {
    await settleTeardown(cleanup, "cleanup failed");
  } catch (cleanupErr) {
    throw new AggregateError([err, cleanupErr], "harness failed to start, and cleanup failed too");
  }
  throw err;
}
