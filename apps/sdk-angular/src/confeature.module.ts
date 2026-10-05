// SPDX-License-Identifier: MIT

/**
 * `ConfeatureModule` — the legacy NgModule registration path (FR-010).
 *
 * Pre-standalone Angular apps register dependencies through NgModule
 * imports. `ConfeatureModule.forRoot(config)` returns a
 * `ModuleWithProviders` shaped exactly like ConfigCat's
 * `ConfigCatModule.forRoot(config)` so a migrating consumer can swap
 * the import line and keep going.
 *
 * Both `provideConfeature` and `ConfeatureModule.forRoot` bind the
 * same `CONFEATURE_CONFIG` injection token, so the root injector
 * ends up with one `ConfeatureService` instance regardless of which
 * path the consumer picks (FR-021).
 */

import { type ModuleWithProviders, NgModule } from "@angular/core";

import type { ConfeatureConfig } from "./config";
import { CONFEATURE_CONFIG } from "./internal/confeature-config.token";

@NgModule({})
export class ConfeatureModule {
  /**
   * Legacy NgModule registration entry point. Use from `AppModule`'s
   * `imports` array:
   *
   * ```ts
   * @NgModule({
   *   imports: [ConfeatureModule.forRoot({ sdkKey: '...' })],
   *   …,
   * })
   * export class AppModule {}
   * ```
   *
   * @param config Immutable configuration record (sdk key, polling
   *   mode, overrides, logger, …).
   * @returns `ModuleWithProviders<ConfeatureModule>` carrying the
   *   `CONFEATURE_CONFIG` binding.
   */
  static forRoot(config: ConfeatureConfig): ModuleWithProviders<ConfeatureModule> {
    return {
      ngModule: ConfeatureModule,
      providers: [{ provide: CONFEATURE_CONFIG, useValue: config }],
    };
  }
}
