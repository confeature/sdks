// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/sdk-angular`.
 *
 * The Angular SDK layers an Angular-idiomatic facade (Service +
 * Provider + Module + Directive + Pipe) on top of
 * `@confeature/sdk-browser-js` (peer dep) and re-exports the wire /
 * domain types from the runtime SDK so consumers can
 * `import { User, OverrideBehaviour } from "@confeature/sdk-angular"`
 * without a separate install.
 *
 * Reference for the parity surface: `@configcat/ng-client`'s public
 * surface (per spec 040 / data-model.md).
 */

// ---- Version stamp -------------------------------------------------
export { SDK_VERSION } from "./version";

// ---- Angular-flavoured configuration -------------------------------
export type { ConfeatureConfig, ConfeaturePollingMode } from "./config";
export {
  DEFAULT_POLLING_MODE,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_CACHE_REFRESH_INTERVAL_SECONDS,
} from "./config";
export { CONFEATURE_CONFIG } from "./internal/confeature-config.token";

// ---- Service ------------------------------------------------------
export { ConfeatureService, type ConfeatureSnapshot } from "./confeature.service";

// ---- Registration paths -------------------------------------------
export { provideConfeature } from "./provider";
export { ConfeatureModule } from "./confeature.module";

// ---- Declarables --------------------------------------------------
export { ConfeatureFlagDirective } from "./confeature-flag.directive";
export { ConfeatureFlagPipe } from "./confeature-flag.pipe";

// ---- Re-exports from @confeature/sdk-browser-js -------------------
// (per data-model.md §"Re-exports from @confeature/sdk-browser-js")
export {
  ConfeatureClient,
  ConfigOverrideDataSource,
  createFlagOverridesFromConfig,
  createFlagOverridesFromMap,
  FlagOverrides,
  type IConfigCatLogger as IConfeatureLogger,
  type IEvaluationDetails,
  LogLevel,
  MapOverrideDataSource,
  OverrideBehaviour,
  PollingMode,
  User,
} from "@confeature/sdk-browser-js";
