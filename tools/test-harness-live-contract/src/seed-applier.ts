// SPDX-License-Identifier: MIT

/**
 * Applying a seed — the ONE place KV records, fault markers and the
 * seeded-key count are written together (plan 680, decision row 9). Boot,
 * `/admin/reset` and `/admin/seed` all call `applySeed`; none of them writes
 * KV or faults on its own.
 *
 * Until plan 680 a seed's `fault` field was never applied anywhere: boot,
 * reset and seed wrote KV only, so every fault seed was decorative.
 *
 * Order matters: the next fault map is computed first, KV is written second,
 * and the map is swapped in only once KV succeeded — a failed KV write leaves
 * the harness serving exactly what it served before.
 */

import type { AdminState } from "./admin-routes.js";
import { setFaultIn } from "./fault-state.js";
import type { FaultMarker, SeededKey } from "./types.js";
import type { WranglerHost } from "./wrangler-host.js";

export type SeedTarget = {
  host: Pick<WranglerHost, "seed" | "clear">;
  state: AdminState;
};

/**
 * - `boot`    — the store is freshly created and empty: write KV, replace faults.
 * - `replace` — `/admin/reset`: clear KV, write KV, replace faults. A reset is
 *               a full state replacement, so previously injected faults go too.
 * - `merge`   — `/admin/seed`: write KV additively. A key carrying a `fault`
 *               sets it (`"none"` clears it); a key without one keeps its own.
 */
export type SeedMode = "boot" | "replace" | "merge";

export async function applySeed(
  target: SeedTarget,
  keys: readonly SeededKey[],
  mode: SeedMode,
): Promise<void> {
  const next =
    mode === "merge"
      ? new Map<string, FaultMarker>(target.state.faults)
      : new Map<string, FaultMarker>();
  for (const key of keys) {
    if (key.fault !== undefined) setFaultIn(next, key.sdkKey, key.fault);
  }

  if (mode === "replace") await target.host.clear();
  await target.host.seed([...keys]);

  target.state.replaceFaults(next);
  if (mode !== "merge") {
    target.state.keys.clear();
    target.state.requests.clear();
  }
  // A key is a case the harness serves when it has a payload or a fault left
  // AFTER this seed — judged on the resulting fault state, so `fault: "none"`
  // (a clear) on a null payload removes it, and a merge that omits `fault`
  // keeps a fault attached earlier.
  //
  // A replacing seed (boot, reset) is the exception, for a null payload with
  // no fault (#918): it declares the whole case set over an empty store, so
  // naming a key there can only mean "absent from KV, answered by the
  // upstream's own miss" — the unknown-key 403 that wire-case http-403 pins.
  // Only a merge can remove a key, and there the same shape still does.
  for (const key of keys) {
    if (mode === "merge" && key.payload === null && !target.state.faults.has(key.sdkKey)) {
      target.state.keys.delete(key.sdkKey);
    } else {
      target.state.keys.add(key.sdkKey);
    }
  }
  target.state.seededKeys = mode === "merge" ? target.state.seededKeys + keys.length : keys.length;
}
