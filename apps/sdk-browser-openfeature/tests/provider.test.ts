// SPDX-License-Identifier: MIT

import {
  ClientCacheState,
  ConfigCatClient,
  createFlagOverridesFromMap,
  OverrideBehaviour,
  PollingMode,
  type IOptions,
} from "@confeature/sdk-browser-js";
import {
  ErrorCode,
  OpenFeature,
  ProviderEvents,
  ProviderStatus,
  StandardResolutionReasons,
} from "@openfeature/web-sdk";
import { afterEach, expect, it, vi } from "vitest";

import { ConfeatureProvider } from "../src/index.ts";

const clients: ConfigCatClient[] = [];

afterEach(async () => {
  try {
    await OpenFeature.clearProviders();
  } finally {
    for (const client of clients.splice(0)) client.dispose();
    vi.useRealTimers();
  }
});

function client(mode: PollingMode, options: IOptions = {}) {
  const sdk = new ConfigCatClient("openfeature-browser-unit", mode, { ...options, offline: true });
  clients.push(sdk);
  return sdk;
}

function locallyOverriddenClient() {
  return client(PollingMode.ManualPoll, {
    flagOverrides: createFlagOverridesFromMap(
      { enabled: true, treatment: "test", amount: 42 },
      OverrideBehaviour.LocalOnly,
    ),
  });
}

it("serves supported scalar types and accepts equality with the caller default", async () => {
  const sdk = locallyOverriddenClient();
  const forceRefresh = vi.spyOn(sdk, "forceRefreshAsync");
  const native = sdk.snapshot();
  const evaluate = vi.spyOn(native, "getValueDetails");
  const snapshot = vi.spyOn(sdk, "snapshot").mockReturnValue(native);
  const provider = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
  await OpenFeature.setProviderAndWait(provider);
  snapshot.mockClear();

  const flags = OpenFeature.getClient();
  expect(flags.getBooleanDetails("enabled", true)).toMatchObject({ value: true });
  expect(flags.getStringValue("treatment", "")).toBe("test");
  expect(flags.getNumberValue("amount", 0)).toBe(42);
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(forceRefresh).not.toHaveBeenCalled();
  expect(flags.getBooleanDetails("enabled", true).errorCode).toBeUndefined();
});

it("rejects the SDK null sentinel from local overrides and refuses object resolution", async () => {
  const sdk = locallyOverriddenClient();
  const native = sdk.snapshot();
  expect(native.getValueDetails("absent", null)).toMatchObject({
    value: null,
    isDefaultValue: false,
  });

  const evaluate = vi.spyOn(native, "getValueDetails");
  vi.spyOn(sdk, "snapshot").mockReturnValue(native);
  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk, PollingMode.ManualPoll));
  const flags = OpenFeature.getClient();

  expect(flags.getStringDetails("absent", "Fallback")).toMatchObject({
    value: "Fallback",
    errorCode: ErrorCode.GENERAL,
    reason: StandardResolutionReasons.ERROR,
  });
  expect(flags.getBooleanDetails("treatment", false)).toMatchObject({
    value: false,
    errorCode: ErrorCode.TYPE_MISMATCH,
  });
  const fallback = { disabled: true };
  expect(flags.getObjectDetails("object", fallback)).toMatchObject({
    value: fallback,
    errorCode: ErrorCode.TYPE_MISMATCH,
  });
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("preserves variants but strips SDK diagnostic, rule, and exception contents", async () => {
  const sdk = locallyOverriddenClient();
  const native = sdk.snapshot();
  const evaluate = vi.spyOn(native, "getValueDetails");
  vi.spyOn(sdk, "snapshot").mockReturnValue(native);

  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk, PollingMode.ManualPoll));
  const flags = OpenFeature.getClient();
  const sentinel = "private-fixture-diagnostic";
  evaluate.mockReturnValueOnce({
    key: "enabled",
    value: true,
    isDefaultValue: false,
    variationId: "fixture-variation",
    matchedPercentageOption: { p: 100, v: { b: true }, i: "fixture-variation" },
    errorMessage: sentinel,
    errorException: new Error(sentinel),
  });
  evaluate.mockReturnValueOnce({
    key: "enabled",
    value: true,
    isDefaultValue: true,
    variationId: sentinel,
    errorMessage: sentinel,
  });
  evaluate.mockImplementationOnce(() => {
    throw new Error(sentinel);
  });

  const served = flags.getBooleanDetails("enabled", false);
  expect(served).toMatchObject({
    value: true,
    reason: StandardResolutionReasons.SPLIT,
    variant: "fixture-variation",
  });
  expect(served.errorCode).toBeUndefined();
  for (const result of [
    flags.getBooleanDetails("enabled", false),
    flags.getBooleanDetails("enabled", false),
  ]) {
    expect(result).toMatchObject({ value: false, errorCode: ErrorCode.GENERAL });
    expect(result.variant).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  }
  expect(JSON.stringify(served)).not.toContain(sentinel);
});

it("maps a fresh SDK user with typed attributes for every evaluation", async () => {
  const sdk = locallyOverriddenClient();
  const native = sdk.snapshot();
  const evaluate = vi.spyOn(native, "getValueDetails");
  vi.spyOn(sdk, "snapshot").mockReturnValue(native);
  const roles = ["first", "second"];
  const date = new Date(0);
  const context = {
    targetingKey: "profile",
    Identifier: "ignored",
    Email: "profile@example.test",
    Country: "FR",
    visits: 3,
    active: true,
    roles,
    date,
    nested: { ignore: true },
    mixed: ["kept-only-in-the-context", 5],
  };

  await OpenFeature.setProviderAndWait(
    "mapping",
    new ConfeatureProvider(sdk, PollingMode.ManualPoll),
    context,
  );
  const flags = OpenFeature.getClient("mapping");
  expect(flags.getStringValue("treatment", "Fallback")).toBe("test");
  expect(flags.getStringValue("treatment", "Fallback")).toBe("test");

  const firstUser = evaluate.mock.calls[0]?.[2];
  const secondUser = evaluate.mock.calls[1]?.[2];
  expect(firstUser).toMatchObject({
    identifier: "profile",
    email: "profile@example.test",
    country: "FR",
    custom: { visits: 3, active: true, roles, date },
  });
  expect(Object.keys(firstUser?.custom ?? {})).toEqual(["visits", "active", "roles", "date"]);
  expect(firstUser?.custom.roles).not.toBe(roles);
  expect(firstUser?.custom.date).not.toBe(date);
  expect(firstUser).not.toBe(secondUser);
});

it.each([
  { mode: PollingMode.ManualPoll, offline: false },
  { mode: PollingMode.AutoPoll, offline: true },
  { mode: PollingMode.LazyLoad, offline: true },
])(
  "rejects cold clients without waiting in mode $mode (offline: $offline)",
  async ({ mode, offline }) => {
    const sdk = client(mode);
    vi.spyOn(sdk, "isOffline", "get").mockReturnValue(offline);
    const wait = vi.spyOn(sdk, "waitForReady");

    await expect(
      OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk, mode)),
    ).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_NOT_READY,
      message: "Confeature has no available flag data.",
    });
    expect(wait).not.toHaveBeenCalled();
  },
);

it("bounds a never-settling initial readiness wait and recovers from later SDK data", async () => {
  vi.useFakeTimers();
  const sdk = client(PollingMode.AutoPoll);
  vi.spyOn(sdk, "isOffline", "get").mockReturnValue(false);
  vi.spyOn(sdk, "waitForReady").mockReturnValue(new Promise(() => {}));
  const native = sdk.snapshot();
  vi.spyOn(sdk, "snapshot").mockReturnValue(native);
  const on = vi.spyOn(sdk, "on");

  const provider = new ConfeatureProvider(sdk, PollingMode.AutoPoll);
  const flags = OpenFeature.getClient("timed");
  let settled = false;
  const registration = OpenFeature.setProviderAndWait("timed", provider).finally(() => {
    settled = true;
  });
  const assertion = expect(registration).rejects.toMatchObject({
    code: ErrorCode.PROVIDER_NOT_READY,
  });
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(flags.providerStatus).toBe(ProviderStatus.ERROR);

  native.cacheState = ClientCacheState.HasUpToDateFlagData;
  on.mock.calls[0]?.[1]({ p: { u: "", r: 0, s: "" }, f: {}, s: [] });
  await vi.runOnlyPendingTimersAsync();
  expect(flags.providerStatus).toBe(ProviderStatus.READY);
});

it("cancels pending provider work on replacement and rejects stale listener callbacks", async () => {
  vi.useFakeTimers();
  const sdk = client(PollingMode.AutoPoll);
  vi.spyOn(sdk, "isOffline", "get").mockReturnValue(false);
  const native = sdk.snapshot();
  vi.spyOn(sdk, "snapshot").mockReturnValue(native);
  let finishSdkReadiness: ((state: ClientCacheState) => void) | undefined;
  const pending = new Promise<ClientCacheState>((resolve) => {
    finishSdkReadiness = resolve;
  });
  vi.spyOn(sdk, "waitForReady").mockReturnValueOnce(pending);
  const on = vi.spyOn(sdk, "on");
  const off = vi.spyOn(sdk, "off");
  const baselineTimers = vi.getTimerCount();

  const provider = new ConfeatureProvider(sdk, PollingMode.AutoPoll);
  const emit = vi.spyOn(provider.events, "emit");
  const registration = OpenFeature.setProviderAndWait("replacement", provider);
  const cancelled = expect(registration).rejects.toMatchObject({
    code: ErrorCode.PROVIDER_NOT_READY,
  });
  expect(vi.getTimerCount()).toBe(baselineTimers + 1);

  // Create the replacement before comparing timers so the SDK's own timers stay out of the count.
  const replacement = locallyOverriddenClient();
  const beforeReplacement = vi.getTimerCount();
  await OpenFeature.setProviderAndWait(
    "replacement",
    new ConfeatureProvider(replacement, PollingMode.ManualPoll),
  );
  expect(vi.getTimerCount()).toBe(beforeReplacement - 1);
  await cancelled;
  expect(off.mock.calls).toEqual(on.mock.calls);

  native.cacheState = ClientCacheState.HasUpToDateFlagData;
  await OpenFeature.setProviderAndWait("reused", provider);
  finishSdkReadiness?.(ClientCacheState.HasUpToDateFlagData);
  on.mock.calls[0]?.[1]({ p: { u: "", r: 0, s: "" }, f: {}, s: [] });
  expect(emit).not.toHaveBeenCalled();
  on.mock.calls[1]?.[1]({ p: { u: "", r: 0, s: "" }, f: {}, s: [] });
  expect(emit).toHaveBeenCalledExactlyOnceWith(ProviderEvents.ConfigurationChanged);
});
