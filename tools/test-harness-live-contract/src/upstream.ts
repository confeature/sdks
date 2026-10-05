// SPDX-License-Identifier: MIT

/**
 * The harness's default upstream: the reference origin (ADR 0006 Q1, #861), a
 * local-only Worker under `reference-origin/` that serves exactly the config
 * read path recorded in packages/contract/read-path-transcript.json.
 *
 * The private CDN Worker stays an explicit opt-in until #795: the CLI takes
 * `CDN_ENTRY` and `CDN_CONFIG` (both, or neither) and `startHarness()` takes
 * any `cdnEntry` / `cdnConfigPath`. Nothing falls back to it silently.
 */

import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Upstream = { cdnEntry: string; cdnConfigPath: string };

/** Absolute paths of the reference origin. This file sits in `src/` and `dist/` alike. */
export function referenceOrigin(): Upstream {
  const pkgRoot = pathResolve(fileURLToPath(import.meta.url), "../..");
  return {
    cdnEntry: pathResolve(pkgRoot, "reference-origin/src/index.ts"),
    cdnConfigPath: pathResolve(pkgRoot, "reference-origin/wrangler.toml"),
  };
}

/**
 * The upstream the CLI boots: the reference origin, unless `CDN_ENTRY` and
 * `CDN_CONFIG` name another Worker (the private live run's CDN Worker opt-in).
 * One of the two without the other is refused: half an opt-in would boot one
 * Worker with another's bindings.
 */
export function resolveUpstream(env: NodeJS.ProcessEnv = process.env): Upstream {
  const entry = env["CDN_ENTRY"];
  const config = env["CDN_CONFIG"];
  if (entry && config) return { cdnEntry: entry, cdnConfigPath: config };
  if (entry || config) {
    throw new Error(
      "CDN_ENTRY and CDN_CONFIG opt into another upstream together: set both, or neither",
    );
  }
  return referenceOrigin();
}
