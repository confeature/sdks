// SPDX-License-Identifier: MIT

import { ConfeatureProvider } from "@confeature/openfeature-browser";
import { PollingMode, User, type ConfigCatClient } from "@confeature/sdk-browser-js";
import {
  ErrorCode,
  OpenFeature,
  ProviderEvents,
  ProviderStatus,
  StandardResolutionReasons,
} from "@openfeature/web-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { admin, configPath, installFixtureTransport, targetedFlag, viewer } from "./fixture.mjs";

let fixture: ReturnType<typeof installFixtureTransport>;
let clients: ConfigCatClient[];

beforeEach(() => {
  fixture = installFixtureTransport();
  clients = [];
});

afterEach(async () => {
  try {
    await OpenFeature.clearProviders();
  } finally {
    for (const client of clients) client.dispose();
    vi.unstubAllGlobals();
  }
});

function borrowedClient(mode: PollingMode, offline = false) {
  const client = fixture.createClient(mode, { offline });
  clients.push(client);
  return client;
}

it.each([PollingMode.AutoPoll, PollingMode.LazyLoad])(
  "registers a cold online client in mode %s using only its initial fetch",
  async (mode) => {
    const sdk = borrowedClient(mode);
    const forceRefresh = vi.spyOn(sdk, "forceRefreshAsync");
    const provider = new ConfeatureProvider(sdk, mode);
    const ready = vi.fn();
    const changed = vi.fn();
    const flags = OpenFeature.getClient("cold");
    flags.addHandler(ProviderEvents.Ready, ready);
    flags.addHandler(ProviderEvents.ConfigurationChanged, changed);
    try {
      await OpenFeature.setProviderAndWait("cold", provider, admin);
      const result = flags.getStringDetails(targetedFlag, "Fallback");
      expect(result).toMatchObject({
        value: "Dog",
        variant: "5b64d9b4",
        reason: StandardResolutionReasons.TARGETING_MATCH,
      });
      expect(ready).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
      expect(forceRefresh).not.toHaveBeenCalled();
      expect(fixture.transport).toHaveBeenCalledTimes(1);
      expect(fixture.transport.mock.calls[0]?.[0]).toBe(
        `${process.env.LIVE_HARNESS_URL}${configPath}`,
      );

      const direct = borrowedClient(mode);
      await direct.waitForReady();
      const native = direct
        .snapshot()
        .getValueDetails(
          targetedFlag,
          "Fallback",
          new User(admin.targetingKey, undefined, undefined, { Custom1: admin.Custom1 }),
        );
      expect(native).toMatchObject({ value: result.value, variationId: result.variant });
      expect(fixture.transport).toHaveBeenCalledTimes(2);
    } finally {
      flags.removeHandler(ProviderEvents.Ready, ready);
      flags.removeHandler(ProviderEvents.ConfigurationChanged, changed);
    }
  },
);

it("uses current domain contexts on an offline warm client without changing the borrowed SDK", async () => {
  const sdk = borrowedClient(PollingMode.ManualPoll);
  expect((await sdk.forceRefreshAsync()).isSuccess).toBe(true);
  sdk.setOffline();
  const wait = vi.spyOn(sdk, "waitForReady");
  const setDefaultUser = vi.spyOn(sdk, "setDefaultUser");
  const clearDefaultUser = vi.spyOn(sdk, "clearDefaultUser");
  const dispose = vi.spyOn(sdk, "dispose");
  const on = vi.spyOn(sdk, "on");
  const off = vi.spyOn(sdk, "off");
  const first = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
  const second = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
  await OpenFeature.setProviderAndWait("first", first, admin);
  await OpenFeature.setProviderAndWait("second", second, viewer);

  await expect(OpenFeature.setProviderAndWait("third", first)).rejects.toThrow(
    "Cannot bind domain-scoped provider",
  );
  const firstFlags = OpenFeature.getClient("first");
  const secondFlags = OpenFeature.getClient("second");
  expect(firstFlags.getStringValue(targetedFlag, "Fallback")).toBe("Dog");
  expect(secondFlags.getStringDetails(targetedFlag, "Cat")).toMatchObject({
    value: "Cat",
    variant: "83372510",
  });
  await OpenFeature.setContext("first", viewer);
  await OpenFeature.setContext("second", admin);
  expect(firstFlags.getStringValue(targetedFlag, "Fallback")).toBe("Cat");
  expect(secondFlags.getStringValue(targetedFlag, "Fallback")).toBe("Dog");

  await OpenFeature.clearProviders();
  expect(wait).not.toHaveBeenCalled();
  expect(setDefaultUser).not.toHaveBeenCalled();
  expect(clearDefaultUser).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(sdk.snapshot().getValue(targetedFlag, "Fallback")).toBe("Cat");
  expect(on.mock.calls.map(([event]) => event)).toEqual(["configChanged", "configChanged"]);
  expect(off.mock.calls).toEqual(on.mock.calls);
  expect(fixture.transport).toHaveBeenCalledTimes(1);
});

it(
  "recovers a still-bound cold ManualPoll provider on SDK refresh and emits sanitized updates",
  { timeout: 15_000 },
  async () => {
    const sdk = borrowedClient(PollingMode.ManualPoll);
    const provider = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
    const flags = OpenFeature.getClient("refresh");
    const ready = vi.fn();
    const change = vi.fn();
    const error = vi.fn();
    flags.addHandler(ProviderEvents.Ready, ready);
    flags.addHandler(ProviderEvents.ConfigurationChanged, change);
    flags.addHandler(ProviderEvents.Error, error);
    try {
      await expect(
        OpenFeature.setProviderAndWait("refresh", provider, admin),
      ).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_NOT_READY,
      });
      expect(flags.providerStatus).toBe(ProviderStatus.ERROR);
      expect(flags.getStringDetails(targetedFlag, "Fallback")).toMatchObject({
        value: "Fallback",
        errorCode: ErrorCode.PROVIDER_NOT_READY,
      });
      expect(fixture.transport).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(ready).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();

      expect((await sdk.forceRefreshAsync()).isSuccess).toBe(true);
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(change).toHaveBeenCalledTimes(1);
      expect(ready.mock.invocationCallOrder[0]).toBeLessThan(change.mock.invocationCallOrder[0]!);
      expect(flags.providerStatus).toBe(ProviderStatus.READY);
      expect(flags.getStringValue(targetedFlag, "Fallback")).toBe("Dog");

      await fixture.reseed();
      expect((await sdk.forceRefreshAsync()).isSuccess).toBe(true);
      expect(flags.getStringValue(targetedFlag, "Fallback")).toBe("Cat");
      expect(change).toHaveBeenCalledTimes(2);
      expect(ready).toHaveBeenCalledTimes(1);
      const envelope = { clientName: "refresh", domain: "refresh", providerName: "Confeature" };
      expect(ready).toHaveBeenCalledExactlyOnceWith(envelope);
      expect(change.mock.calls).toEqual([[envelope], [envelope]]);
      expect(fixture.transport).toHaveBeenCalledTimes(2);

      await OpenFeature.clearProviders();
      await fixture.reseed("admin");
      expect((await sdk.forceRefreshAsync()).isSuccess).toBe(true);
      expect(change).toHaveBeenCalledTimes(2);
    } finally {
      flags.removeHandler(ProviderEvents.Ready, ready);
      flags.removeHandler(ProviderEvents.ConfigurationChanged, change);
      flags.removeHandler(ProviderEvents.Error, error);
    }
  },
);
