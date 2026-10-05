// SPDX-License-Identifier: MIT

import type { FaultMarker } from "./types.js";

/**
 * Attach `fault` to `sdkKey` in `faults`, where `"none"` means "no fault" and
 * removes the entry. The one spelling of that rule: AdminState.setFault
 * (admin-routes.ts) and applySeed (seed-applier.ts) both call it. A module of
 * its own so neither of those two imports the other at run time.
 * Returns the previous fault.
 */
export function setFaultIn(
  faults: Map<string, FaultMarker>,
  sdkKey: string,
  fault: FaultMarker,
): FaultMarker | null {
  const prev = faults.get(sdkKey) ?? null;
  if (fault === "none") faults.delete(sdkKey);
  else faults.set(sdkKey, fault);
  return prev;
}
