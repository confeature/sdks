// SPDX-License-Identifier: MIT

/**
 * Outcome of a refresh attempt (`forceRefreshAsync`) — type-compatible
 * with `configcat-common`'s `RefreshResult`. Success = HTTP 200 with a
 * parsed payload OR 304 Not Modified. Failure carries an error message
 * and the underlying exception if any.
 */
export class RefreshResult {
  private constructor(
    public readonly errorMessage: string | null,
    public readonly errorException: unknown,
  ) {}

  /** True iff the refresh succeeded (either 200 with parse, or 304). */
  get isSuccess(): boolean {
    return this.errorMessage === null;
  }

  /** Factory for the happy path. */
  static success(): RefreshResult {
    return new RefreshResult(null, undefined);
  }

  /** Factory matching configcat-common's `RefreshResult.from`. */
  static from(errorMessage: string | null, errorException?: unknown): RefreshResult {
    return new RefreshResult(errorMessage, errorException);
  }

  /** Factory for failure. */
  static failure(errorMessage: string, errorException?: unknown): RefreshResult {
    return new RefreshResult(errorMessage, errorException);
  }
}

/**
 * Snapshot freshness — surfaced via `IConfigCatClient.waitForReady` and
 * `IConfigCatClientSnapshot.cacheState`. Names AND numeric values match
 * `configcat-common` (4 members, `NoFlagData=0`,
 * `HasLocalOverrideFlagDataOnly=1`, `HasCachedFlagDataOnly=2`,
 * `HasUpToDateFlagData=3`). Spec 076 / #271.
 */
export const ClientCacheState = {
  NoFlagData: 0,
  HasLocalOverrideFlagDataOnly: 1,
  HasCachedFlagDataOnly: 2,
  HasUpToDateFlagData: 3,
} as const;
export type ClientCacheState = (typeof ClientCacheState)[keyof typeof ClientCacheState];
