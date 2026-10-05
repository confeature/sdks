// SPDX-License-Identifier: MIT

import type { IAutoPollOptions, ILazyLoadingOptions, IManualPollOptions } from "./options.ts";
import { PollingMode } from "./options.ts";

/**
 * Map a `PollingMode` to its option shape — mirrors `configcat-common`'s
 * `OptionsForPollingMode` conditional. Used at `getClient`'s public
 * boundary so option types narrow against the mode.
 *
 * `SdkErrorCode` was extracted to `@confeature/sdk-shared`. Re-export it
 * here for backward-compatible imports inside `apps/sdk-node`.
 */
export type OptionsForPollingMode<TMode extends PollingMode | undefined> = TMode extends
  | typeof PollingMode.AutoPoll
  | undefined
  ? IAutoPollOptions
  : TMode extends typeof PollingMode.LazyLoad
    ? ILazyLoadingOptions
    : TMode extends typeof PollingMode.ManualPoll
      ? IManualPollOptions
      : IAutoPollOptions;

export { SdkErrorCode } from "@confeature/sdk-shared";
