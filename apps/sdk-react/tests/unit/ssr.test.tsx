// SPDX-License-Identifier: MIT

/**
 * Unit tier — SSR safety (FR-014 / FR-015 / SC-009 / T025).
 *
 * On the server:
 *  - `window` and `localStorage` are absent — the runtime SDK's
 *    `BrowserConfigCache` falls back to its in-memory backend
 *    (spec 031 FR-016).
 *  - `useEffect` does NOT fire during `renderToString` — the hook's
 *    async resolution effect therefore stays unscheduled and the
 *    initial state (`{ value: defaultValue, loading: true }`) is what
 *    the consumer sees on the server.
 *  - No console.error / console.warn must fire.
 *
 * We use `vi.stubGlobal("window", undefined)` to simulate the SSR
 * environment AND assert `renderToString` does not throw.
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigCatProvider, PollingMode, useFeatureFlag } from "../../src/index.ts";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function FlagReadout(): React.ReactElement {
  const { value, loading } = useFeatureFlag("feature.dark-mode", false);
  return <span data-testid="readout">{loading ? "loading" : value ? "on" : "off"}</span>;
}

describe("SSR safety (FR-014 / FR-015 / SC-009 / T025)", () => {
  test("renderToString does not throw + does not write to console", () => {
    // Simulate the SSR environment — happy-dom would otherwise leak
    // a `window` global. Some sub-paths of the runtime SDK probe
    // `typeof window` at construction time; the fallback is exercised
    // when both are undefined.
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let html = "";
    expect(() => {
      html = renderToString(
        <ConfigCatProvider sdkKey={SDK_KEY} pollingMode={PollingMode.ManualPoll}>
          <FlagReadout />
        </ConfigCatProvider>,
      );
    }).not.toThrow();

    // The first server render returns the initial state — loading is
    // true, value is the default. The string-rendered output reflects
    // that.
    expect(html).toContain("loading");

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
