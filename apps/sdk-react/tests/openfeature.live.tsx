// SPDX-License-Identifier: MIT

import { ConfeatureProvider } from "@confeature/openfeature-browser";
import { PollingMode } from "@confeature/sdk-browser-js";
import { OpenFeatureProvider, useStringFlagDetails } from "@openfeature/react-sdk";
import { OpenFeature } from "@openfeature/web-sdk";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import {
  admin,
  installFixtureTransport,
  targetedFlag,
} from "../../sdk-browser-openfeature/tests/fixture.mjs";

const domain = "confeature-react-fixture";
const viewer = { targetingKey: "fixture-viewer", Custom1: "viewer" };

function Flag() {
  const flag = useStringFlagDetails(targetedFlag, "Fallback");
  return <output>{flag.value}</output>;
}

it("re-renders the named domain after context and configuration changes", async () => {
  const fixture = installFixtureTransport();
  const sdk = fixture.createClient();
  const on = vi.spyOn(sdk, "on");
  const off = vi.spyOn(sdk, "off");
  const dispose = vi.spyOn(sdk, "dispose");
  let providerDisposedSdk = false;
  const provider = new ConfeatureProvider(sdk, PollingMode.ManualPoll);
  let view: ReturnType<typeof render> | undefined;
  try {
    await fixture.reseed("admin");
    await sdk.forceRefreshAsync();
    await OpenFeature.setContext(domain, admin);
    await OpenFeature.setProviderAndWait(domain, provider);
    view = render(
      <OpenFeatureProvider domain={domain}>
        <Flag />
      </OpenFeatureProvider>,
    );
    expect((await screen.findByText("Dog")).textContent).toBe("Dog");

    await act(async () => OpenFeature.setContext(domain, viewer));
    expect((await screen.findByText("Cat")).textContent).toBe("Cat");

    await fixture.reseed();
    await act(async () => {
      await sdk.forceRefreshAsync();
    });
    expect((await screen.findByText("Dog")).textContent).toBe("Dog");
    expect(fixture.transport).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledExactlyOnceWith("configChanged", expect.any(Function));
  } finally {
    try {
      view?.unmount();
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
