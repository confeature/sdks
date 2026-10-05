// SPDX-License-Identifier: MIT

/**
 * `provideConfeature(config)` — the standalone-component registration
 * path (FR-009).
 *
 * Returns an `EnvironmentProviders` carrying a single binding for
 * `CONFEATURE_CONFIG`. Drop it into the `providers` array of any
 * standalone bootstrap (`bootstrapApplication(App, { providers: [
 * provideConfeature({ sdkKey: '...' }) ] })`) or feature route.
 *
 * The companion legacy path is `ConfeatureModule.forRoot(config)` —
 * both converge on the same token, so the root injector ends up with
 * a single `ConfeatureService` singleton regardless of which path the
 * consumer picks (FR-021).
 */

import { type EnvironmentProviders, makeEnvironmentProviders } from "@angular/core";

import type { ConfeatureConfig } from "./config";
import { CONFEATURE_CONFIG } from "./internal/confeature-config.token";

/**
 * Standalone-component registration entry point. Binds the supplied
 * `ConfeatureConfig` to the `CONFEATURE_CONFIG` injection token,
 * which `ConfeatureService` reads on construction.
 *
 * @param config Immutable configuration record (sdk key, polling
 *   mode, overrides, logger, …).
 * @returns `EnvironmentProviders` ready to splice into
 *   `bootstrapApplication`'s providers list or any environment
 *   injector.
 */
export function provideConfeature(config: ConfeatureConfig): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: CONFEATURE_CONFIG, useValue: config }]);
}
