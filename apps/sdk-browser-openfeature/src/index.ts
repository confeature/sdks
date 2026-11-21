// SPDX-License-Identifier: MIT

import { ClientCacheState, PollingMode, type IConfigCatClient } from "@confeature/sdk-browser-js";
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  OpenFeatureEventEmitter,
  type Provider,
  ProviderEvents,
  ProviderNotReadyError,
  type ResolutionDetails,
  StandardResolutionReasons,
} from "@openfeature/web-sdk";

import { toUser } from "./user.ts";

const NO_FLAG_DATA = "Confeature has no available flag data.";
const EVALUATION_FAILED = "Confeature could not evaluate the flag.";
const MAX_INIT_WAIT_MS = 5_000;

type Primitive = boolean | number | string;

interface Registration {
  listener: () => void;
  phase: "initializing" | "ready" | "failed";
  cancelWait?: () => void;
  recoveryTimer?: ReturnType<typeof setTimeout>;
}

/** An OpenFeature Web provider that evaluates against an application-owned client. */
export class ConfeatureProvider implements Provider {
  readonly runsOn = "client";
  readonly domainScoped = true;
  readonly metadata = { name: "Confeature" } as const;
  readonly events = new OpenFeatureEventEmitter();

  private registration?: Registration;

  /** Pass the client's configured polling mode and keep its default user unset. */
  constructor(
    private readonly client: IConfigCatClient,
    private readonly pollingMode: PollingMode,
  ) {}

  async initialize(): Promise<void> {
    if (this.registration) throw new ProviderNotReadyError("Confeature is already registered.");

    const registration: Registration = {
      phase: "initializing",
      listener: () => this.onConfigChanged(registration),
    };
    this.registration = registration;

    try {
      this.client.on("configChanged", registration.listener);
      if (!this.hasFlagData() && this.canWaitForInitialCache()) {
        await this.waitForInitialCache(registration);
      }
      if (this.registration !== registration || !this.hasFlagData()) {
        throw new ProviderNotReadyError(NO_FLAG_DATA);
      }
      // OpenFeature emits the initial Ready event after initialize resolves.
      registration.phase = "ready";
    } catch {
      registration.phase = "failed";
      throw new ProviderNotReadyError(NO_FLAG_DATA);
    }
  }

  async onClose(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;

    // The SDK may already be dispatching a copy of its listeners.
    this.registration = undefined;
    registration.cancelWait?.();
    clearTimeout(registration.recoveryTimer);
    try {
      this.client.off("configChanged", registration.listener);
    } catch {
      throw new Error("Confeature could not remove its configuration listener.");
    }
  }

  resolveBooleanEvaluation(
    key: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): ResolutionDetails<boolean> {
    return this.resolve(key, defaultValue, context);
  }

  resolveStringEvaluation(
    key: string,
    defaultValue: string,
    context: EvaluationContext,
  ): ResolutionDetails<string> {
    return this.resolve(key, defaultValue, context);
  }

  resolveNumberEvaluation(
    key: string,
    defaultValue: number,
    context: EvaluationContext,
  ): ResolutionDetails<number> {
    return this.resolve(key, defaultValue, context);
  }

  resolveObjectEvaluation<T extends JsonValue>(
    _key: string,
    defaultValue: T,
  ): ResolutionDetails<T> {
    if (!this.ready) return failure(defaultValue, ErrorCode.PROVIDER_NOT_READY, NO_FLAG_DATA);
    return failure(defaultValue, ErrorCode.TYPE_MISMATCH, "Confeature flags are scalar values.");
  }

  private get ready(): boolean {
    return this.registration?.phase === "ready";
  }

  private resolve<T extends Primitive>(
    key: string,
    defaultValue: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    if (!this.ready) return failure(defaultValue, ErrorCode.PROVIDER_NOT_READY, NO_FLAG_DATA);
    try {
      // A null default lets the provider classify the SDK value with one snapshot read.
      const details = this.client.snapshot().getValueDetails<unknown>(key, null, toUser(context));
      // A flat local override can return the null default with isDefaultValue set to false.
      if (details.isDefaultValue || details.value === null) {
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

  private hasFlagData(): boolean {
    const state = this.client.snapshot().cacheState;
    return (
      state === ClientCacheState.HasUpToDateFlagData ||
      state === ClientCacheState.HasCachedFlagDataOnly ||
      state === ClientCacheState.HasLocalOverrideFlagDataOnly
    );
  }

  private canWaitForInitialCache(): boolean {
    return (
      !this.client.isOffline &&
      (this.pollingMode === PollingMode.AutoPoll || this.pollingMode === PollingMode.LazyLoad)
    );
  }

  private async waitForInitialCache(registration: Registration): Promise<void> {
    const deadline = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, MAX_INIT_WAIT_MS);
      registration.cancelWait = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    try {
      await Promise.race([this.client.waitForReady(), deadline]);
    } finally {
      registration.cancelWait?.();
      registration.cancelWait = undefined;
    }
  }

  private onConfigChanged(registration: Registration): void {
    if (this.registration !== registration || registration.phase === "initializing") return;
    if (registration.phase === "ready") {
      this.events.emit(ProviderEvents.ConfigurationChanged);
      return;
    }
    if (registration.recoveryTimer !== undefined) return;

    // Run after OpenFeature has delivered any pending initialization rejection.
    registration.recoveryTimer = setTimeout(() => {
      registration.recoveryTimer = undefined;
      if (this.registration !== registration) return;

      // The SDK emits this hook only after writing usable data to its cache.
      registration.phase = "ready";
      this.events.emit(ProviderEvents.Ready);
      if (this.registration === registration) {
        this.events.emit(ProviderEvents.ConfigurationChanged);
      }
    }, 0);
  }
}

function failure<T>(value: T, errorCode: ErrorCode, errorMessage: string): ResolutionDetails<T> {
  return { value, errorCode, errorMessage, reason: StandardResolutionReasons.ERROR };
}
