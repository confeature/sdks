// SPDX-License-Identifier: MIT

import { TestBed } from "@angular/core/testing";
import { ConfeatureProvider } from "@confeature/openfeature-browser";
import { PollingMode } from "@confeature/sdk-browser-js";
import { FeatureFlagService, provideOpenFeature } from "@openfeature/angular-sdk";
import { OpenFeature } from "@openfeature/web-sdk";
import type { Subscription } from "rxjs";
import { expect, it, vi } from "vitest";

import {
  admin,
  installFixtureTransport,
  targetedFlag,
} from "../../sdk-browser-openfeature/tests/fixture.mjs";

const domain = "confeature-angular-fixture";
const viewer = { targetingKey: "fixture-viewer", Custom1: "viewer" };

it("emits flag changes for the initialized named domain", async () => {
  const fixture = installFixtureTransport();
  const sdk = fixture.createClient();
  const on = vi.spyOn(sdk, "on");
  const off = vi.spyOn(sdk, "off");
  const dispose = vi.spyOn(sdk, "dispose");
  let providerDisposedSdk = false;
  const provider = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
  const values: string[] = [];
  let subscription: Subscription | undefined;

  try {
    await fixture.reseed("admin");
    await sdk.forceRefreshAsync();
    TestBed.configureTestingModule({
      providers: [
        provideOpenFeature({ domainBoundProviders: { [domain]: provider }, context: admin }),
      ],
    });
    const service = TestBed.inject(FeatureFlagService);
    subscription = service
      .getStringDetails(targetedFlag, "Fallback", domain)
      .subscribe(({ value }) => {
        values.push(value);
      });
    await vi.waitFor(() => expect(values.at(-1)).toBe("Dog"));

    await OpenFeature.setContext(domain, viewer);
    await vi.waitFor(() => expect(values.at(-1)).toBe("Cat"));

    await fixture.reseed();
    await sdk.forceRefreshAsync();
    await vi.waitFor(() => expect(values.at(-1)).toBe("Dog"));
    expect(fixture.transport).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledExactlyOnceWith("configChanged", expect.any(Function));
  } finally {
    try {
      subscription?.unsubscribe();
      TestBed.resetTestingModule();
      await OpenFeature.close();
      providerDisposedSdk = dispose.mock.calls.length > 0;
    } finally {
      sdk.dispose();
      vi.unstubAllGlobals();
    }
  }
  expect(off).toHaveBeenCalledExactlyOnceWith("configChanged", on.mock.calls[0]?.[1]);
  expect(providerDisposedSdk).toBe(false);
});
