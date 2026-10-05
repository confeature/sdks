// SPDX-License-Identifier: MIT

/**
 * DI token carrying the `ConfeatureConfig` record from the consumer's
 * registration call (`provideConfeature(config)` or
 * `ConfeatureModule.forRoot(config)`) to `ConfeatureService`'s
 * constructor.
 *
 * Internal to the package — consumers never reference the token
 * directly. Two registration paths (`provideConfeature` and
 * `ConfeatureModule.forRoot`) both bind a value to this same token,
 * which is what makes them resolve to the same `ConfeatureService`
 * singleton (FR-021).
 */

import { InjectionToken } from "@angular/core";

import type { ConfeatureConfig } from "../config";

export const CONFEATURE_CONFIG = new InjectionToken<ConfeatureConfig>("CONFEATURE_CONFIG");
