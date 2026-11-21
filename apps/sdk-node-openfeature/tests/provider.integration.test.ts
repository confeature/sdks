// SPDX-License-Identifier: MIT

import { User, type ConfigCatClient } from "@confeature/sdk-node";
import { ErrorCode, OpenFeature, StandardResolutionReasons } from "@openfeature/server-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConfeatureProvider } from "../src/index.ts";
import { admin, installFixtureTransport, targetedFlag } from "./fixture.ts";

let fixture: ReturnType<typeof installFixtureTransport>;
let clients: ConfigCatClient[];

beforeEach(() => {
  fixture = installFixtureTransport();
  clients = [];
});

afterEach(async () => {
  try {
    await OpenFeature.close();
  } finally {
    for (const client of clients) client.dispose();
    vi.unstubAllGlobals();
  }
});

function borrowedClient(offline = false) {
  const client = fixture.createClient(offline);
  clients.push(client);
  return client;
}

it("delegates the first targeted evaluation with the same traffic as direct AutoPoll", async () => {
  const sdk = borrowedClient();
  const evaluate = vi.spyOn(sdk, "getValueDetailsAsync");
  const forceRefresh = vi.spyOn(sdk, "forceRefreshAsync");
  const on = vi.spyOn(sdk, "on");
  const once = vi.spyOn(sdk, "once");
  const off = vi.spyOn(sdk, "off");
  const setDefaultUser = vi.spyOn(sdk, "setDefaultUser");
  const dispose = vi.spyOn(sdk, "dispose");

  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  const flags = OpenFeature.getClient();
  const result = await flags.getStringDetails(targetedFlag, "Fallback", admin);
  expect(result).toMatchObject({
    value: "Dog",
    variant: "5b64d9b4",
    reason: StandardResolutionReasons.TARGETING_MATCH,
  });
  expect(result.errorCode).toBeUndefined();
  expect(evaluate).toHaveBeenCalledExactlyOnceWith(
    targetedFlag,
    null,
    expect.objectContaining({ identifier: admin.targetingKey, custom: { Custom1: "admin" } }),
  );

  expect(fixture.transport).toHaveBeenCalledTimes(1);
  const direct = borrowedClient();
  await direct.waitForReady();
  const native = await direct.getValueDetailsAsync(
    targetedFlag,
    "Fallback",
    new User(admin.targetingKey, undefined, undefined, { Custom1: admin.Custom1 }),
  );
  expect(native).toMatchObject({ value: result.value, variationId: result.variant });
  expect(fixture.transport).toHaveBeenCalledTimes(2);

  await OpenFeature.close();
  expect(forceRefresh).not.toHaveBeenCalled();
  expect(on).not.toHaveBeenCalled();
  expect(once).not.toHaveBeenCalled();
  expect(off).not.toHaveBeenCalled();
  expect(setDefaultUser).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  await expect(sdk.getValueAsync(targetedFlag, "Fallback")).resolves.toBe("Cat");
  expect(fixture.transport).toHaveBeenCalledTimes(2);
});

it("keeps concurrent targeting isolated and accepts a result equal to the caller default", async () => {
  const sdk = borrowedClient();
  await sdk.waitForReady();
  sdk.setOffline();
  const evaluate = vi.spyOn(sdk, "getValueDetailsAsync");

  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  const flags = OpenFeature.getClient();
  const guest = { targetingKey: "synthetic-guest", Custom1: "guest" };
  const results = await Promise.all([
    flags.getStringDetails(targetedFlag, "Fallback", admin),
    flags.getStringDetails(targetedFlag, "Cat", guest),
    flags.getStringDetails(targetedFlag, "Fallback"),
  ]);

  expect(results).toMatchObject([
    { value: "Dog", variant: "5b64d9b4" },
    { value: "Cat", variant: "83372510" },
    { value: "Cat", variant: "83372510" },
  ]);
  expect(results.every(({ errorCode }) => errorCode === undefined)).toBe(true);
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(evaluate.mock.calls[0]?.[2]).not.toBe(evaluate.mock.calls[1]?.[2]);
  expect(evaluate.mock.calls.map((args) => args[2]?.identifier)).toEqual([
    admin.targetingKey,
    guest.targetingKey,
    undefined,
  ]);
  expect(fixture.transport).toHaveBeenCalledTimes(1);
});

it("preserves a numeric percentage option and its variation ID", async () => {
  const sdk = borrowedClient();
  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  const result = await OpenFeature.getClient().getNumberDetails("decimal", -1, admin);
  const direct = await sdk.getValueDetailsAsync("decimal", -1, new User(admin.targetingKey));
  expect(direct.matchedPercentageOption).toBeDefined();
  expect([1, 2]).toContain(result.value);
  expect(result).toMatchObject({
    value: direct.value,
    variant: direct.variationId,
    reason: StandardResolutionReasons.SPLIT,
  });
  expect(result.errorCode).toBeUndefined();
  expect(fixture.transport).toHaveBeenCalledTimes(1);
});

it("keeps success diagnostics private and distinguishes fallback from an incompatible value", async () => {
  const sdk = borrowedClient();
  const evaluate = vi.spyOn(sdk, "getValueDetailsAsync");
  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  const flags = OpenFeature.getClient();

  const diagnostic = await flags.getStringDetails("datetimeBeforeDogDefaultCat", "Fallback", {
    targetingKey: "synthetic-identity",
    Date: "synthetic-invalid-date",
  });
  const sdkDetails = await evaluate.mock.results[0]?.value;
  expect(sdkDetails?.errorMessage).toBeTruthy();
  expect(sdkDetails?.isDefaultValue).toBe(false);
  expect(diagnostic).toMatchObject({ value: "default", variant: "d1a7be01" });
  expect(diagnostic.errorCode).toBeUndefined();
  expect(diagnostic.errorMessage).toBeUndefined();
  expect(JSON.stringify(diagnostic)).not.toContain("synthetic-");

  const missing = await flags.getStringDetails("absent-flag", "Fallback");
  expect(missing).toMatchObject({ value: "Fallback", errorCode: ErrorCode.GENERAL });
  const wrongType = await flags.getBooleanDetails(targetedFlag, false, admin);
  expect(wrongType).toMatchObject({ value: false, errorCode: ErrorCode.TYPE_MISMATCH });
  const fallbackObject = { enabled: false };
  const object = await flags.getObjectDetails(targetedFlag, fallbackObject, admin);
  expect(object).toMatchObject({ value: fallbackObject, errorCode: ErrorCode.TYPE_MISMATCH });
  for (const result of [missing, wrongType, object]) {
    expect(result.reason).toBe(StandardResolutionReasons.ERROR);
    expect(result.variant).toBeUndefined();
  }
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(fixture.transport).toHaveBeenCalledTimes(1);
});

it("requires fresh provider registration when the SDK loads data after a failed initialization", async () => {
  const sdk = borrowedClient(true);
  const evaluate = vi.spyOn(sdk, "getValueDetailsAsync");
  const provider = new ConfeatureProvider(sdk);
  await expect(OpenFeature.setProviderAndWait(provider)).rejects.toMatchObject({
    code: ErrorCode.PROVIDER_NOT_READY,
  });
  const flags = OpenFeature.getClient();
  expect(fixture.transport).not.toHaveBeenCalled();

  sdk.setOnline();
  await vi.waitFor(() => expect(sdk.snapshot().getValue(targetedFlag, "Fallback")).toBe("Cat"));
  expect(flags.providerStatus).toBe("ERROR");

  const fallback = { active: false };
  const blocked = [
    await flags.getStringDetails(targetedFlag, "Fallback", admin),
    await flags.getObjectDetails(targetedFlag, fallback),
  ];
  expect(blocked).toMatchObject([
    { value: "Fallback", errorCode: ErrorCode.PROVIDER_NOT_READY },
    { value: fallback, errorCode: ErrorCode.PROVIDER_NOT_READY },
  ]);
  expect(evaluate).not.toHaveBeenCalled();

  await OpenFeature.setProviderAndWait(new ConfeatureProvider(sdk));
  expect(flags.providerStatus).toBe("READY");
  await expect(flags.getStringDetails(targetedFlag, "Fallback", admin)).resolves.toMatchObject({
    value: "Dog",
    variant: "5b64d9b4",
  });
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.transport).toHaveBeenCalledTimes(1);
});
