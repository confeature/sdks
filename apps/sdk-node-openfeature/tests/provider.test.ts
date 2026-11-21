// SPDX-License-Identifier: MIT

import { ClientCacheState, ConfigCatClient, PollingMode } from "@confeature/sdk-node";
import { ErrorCode, OpenFeature, StandardResolutionReasons } from "@openfeature/server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfeatureProvider } from "../src/index.ts";

describe("ConfeatureProvider", () => {
  let sdk: ConfigCatClient;
  let provider: ConfeatureProvider;

  beforeEach(() => {
    sdk = new ConfigCatClient("offline-unit-fixture", PollingMode.AutoPoll, { offline: true });
    provider = new ConfeatureProvider(sdk);
  });

  afterEach(async () => {
    await OpenFeature.close();
    sdk.dispose();
    vi.useRealTimers();
  });

  it.each([
    ClientCacheState.HasLocalOverrideFlagDataOnly,
    ClientCacheState.HasCachedFlagDataOnly,
    ClientCacheState.HasUpToDateFlagData,
  ])("accepts usable cache state %s without waiting", async (cacheState) => {
    const snapshot = sdk.snapshot();
    vi.spyOn(sdk, "snapshot").mockReturnValue({ ...snapshot, cacheState });
    const wait = vi.spyOn(sdk, "waitForReady");
    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails immediately when offline without data", async () => {
    const wait = vi.spyOn(sdk, "waitForReady");
    await expect(provider.initialize()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_READY,
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("reports an SDK initialization rejection without its contents", async () => {
    vi.spyOn(sdk, "isOffline", "get").mockReturnValue(false);
    vi.spyOn(sdk, "waitForReady").mockRejectedValue(new Error("secret-readiness-diagnostic"));
    await expect(provider.initialize()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_READY,
      message: "Confeature has no available flag data.",
      cause: undefined,
    });
  });

  it("bounds a pending SDK initialization", async () => {
    vi.useFakeTimers();
    vi.spyOn(sdk, "isOffline", "get").mockReturnValue(false);
    vi.spyOn(sdk, "waitForReady").mockReturnValue(new Promise(() => {}));
    const outcome = expect(provider.initialize()).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_READY,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await outcome;
  });

  it("returns the original default and hides opaque fallback diagnostics", async () => {
    vi.spyOn(sdk, "snapshot").mockReturnValue({
      ...sdk.snapshot(),
      cacheState: ClientCacheState.HasUpToDateFlagData,
    });
    const evaluate = vi.spyOn(sdk, "getValueDetailsAsync").mockResolvedValue({
      key: "flag",
      value: "discard",
      isDefaultValue: true,
      variationId: "discard",
      errorMessage: "secret-sdk-key",
      errorException: new Error("secret-url"),
    });
    await OpenFeature.setProviderAndWait(provider);
    const result = await OpenFeature.getClient().getStringDetails("flag", "fallback", {
      targetingKey: "secret-context",
    });
    expect(result).toMatchObject({
      value: "fallback",
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: "Confeature could not evaluate the flag.",
    });
    expect(result.variant).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/discard|secret-/);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("sanitizes exceptions thrown by a borrowed client", async () => {
    vi.spyOn(sdk, "getValueDetailsAsync").mockRejectedValue(new Error("secret-sdk-key"));
    await expect(provider.resolveStringEvaluation("flag", "fallback", {})).resolves.toEqual({
      value: "fallback",
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: "Confeature could not evaluate the flag.",
    });
  });

  it("copies typed attributes and skips nested and reserved fields", async () => {
    const evaluate = vi.spyOn(sdk, "getValueDetailsAsync").mockResolvedValue({
      key: "flag",
      value: true,
      isDefaultValue: false,
    });
    const date = new Date(0);
    const tags = ["one", "two"];
    const context = Object.freeze({
      targetingKey: "subject",
      Identifier: "competing-id",
      Email: "synthetic-address",
      Country: "CA",
      date,
      tags,
      typed: 7,
      enabled: false,
      mixed: ["one", 3],
      unsupported: { private: "sentinel" },
    });
    await provider.resolveBooleanEvaluation("flag", false, context);
    const user = evaluate.mock.calls[0]?.[2];
    expect(user).toMatchObject({
      identifier: "subject",
      email: "synthetic-address",
      country: "CA",
      custom: { date, tags, typed: 7, enabled: false },
    });
    expect(Object.keys(user!.custom).sort()).toEqual(["date", "enabled", "tags", "typed"]);
    expect(user!.custom.date).not.toBe(date);
    expect(user!.custom.tags).not.toBe(tags);
  });
});
