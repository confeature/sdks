// SPDX-License-Identifier: MIT

import { ClientCacheState, type IConfigCatClient } from "@confeature/sdk-node";
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  ProviderNotReadyError,
  type ResolutionDetails,
  StandardResolutionReasons,
} from "@openfeature/server-sdk";

import { toUser } from "./user.ts";

const NO_FLAG_DATA = "Confeature has no available flag data.";
const EVALUATION_FAILED = "Confeature could not evaluate the flag.";
type Primitive = boolean | number | string;

/** An OpenFeature provider backed by an application-owned Confeature client. */
export class ConfeatureProvider implements Provider {
  readonly runsOn = "server";
  readonly metadata = { name: "Confeature" } as const;
  private ready = false;

  /** The borrowed client must remain free of a default user while the provider uses it. */
  constructor(private readonly client: IConfigCatClient) {}

  async initialize(): Promise<void> {
    this.ready = false;
    try {
      let cacheState = this.client.snapshot().cacheState;
      // The Node SDK currently uses AutoPoll for all online polling options.
      // Check the live cache again because waitForReady remembers the first poll.
      if (!hasFlagData(cacheState) && !this.client.isOffline) {
        await waitAtMostFiveSeconds(this.client.waitForReady());
        cacheState = this.client.snapshot().cacheState;
      }
      this.ready = hasFlagData(cacheState);
    } catch {
      throw new ProviderNotReadyError(NO_FLAG_DATA);
    }
    if (!this.ready) throw new ProviderNotReadyError(NO_FLAG_DATA);
  }

  resolveBooleanEvaluation(key: string, defaultValue: boolean, context: EvaluationContext) {
    return this.resolve(key, defaultValue, context);
  }

  resolveStringEvaluation(key: string, defaultValue: string, context: EvaluationContext) {
    return this.resolve(key, defaultValue, context);
  }

  resolveNumberEvaluation(key: string, defaultValue: number, context: EvaluationContext) {
    return this.resolve(key, defaultValue, context);
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    _key: string,
    defaultValue: T,
  ): Promise<ResolutionDetails<T>> {
    if (!this.ready) return failure(defaultValue, ErrorCode.PROVIDER_NOT_READY, NO_FLAG_DATA);
    return failure(defaultValue, ErrorCode.TYPE_MISMATCH, "Confeature flags are scalar values.");
  }

  private async resolve<T extends Primitive>(
    key: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    if (!this.ready) return failure(defaultValue, ErrorCode.PROVIDER_NOT_READY, NO_FLAG_DATA);
    try {
      // A null SDK default bypasses the SDK's type check. This lets the provider
      // classify a served value's type with one call and no SDK message parsing.
      const details = await this.client.getValueDetailsAsync<unknown>(key, null, toUser(context));
      if (details.isDefaultValue) {
        return failure(defaultValue, ErrorCode.GENERAL, EVALUATION_FAILED);
      }
      const { value, variationId, matchedPercentageOption, matchedTargetingRule } = details;
      if (
        typeof value !== typeof defaultValue ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        return failure(
          defaultValue,
          ErrorCode.TYPE_MISMATCH,
          "Confeature flag type does not match.",
        );
      }
      const result: ResolutionDetails<T> = { value: value as T };
      if (variationId !== undefined) result.variant = variationId;
      if (matchedPercentageOption) result.reason = StandardResolutionReasons.SPLIT;
      else if (matchedTargetingRule) result.reason = StandardResolutionReasons.TARGETING_MATCH;
      return result;
    } catch {
      return failure(defaultValue, ErrorCode.GENERAL, EVALUATION_FAILED);
    }
  }
}

function failure<T>(value: T, errorCode: ErrorCode, errorMessage: string): ResolutionDetails<T> {
  return { value, errorCode, errorMessage, reason: StandardResolutionReasons.ERROR };
}

function hasFlagData(cacheState: ClientCacheState): boolean {
  return (
    cacheState === ClientCacheState.HasUpToDateFlagData ||
    cacheState === ClientCacheState.HasCachedFlagDataOnly ||
    cacheState === ClientCacheState.HasLocalOverrideFlagDataOnly
  );
}

async function waitAtMostFiveSeconds(ready: Promise<ClientCacheState>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, 5000);
  });
  try {
    await Promise.race([ready, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
