// SPDX-License-Identifier: MIT

/**
 * Unit tier — `<ConfigCatProvider>` mount surface (FR-001 / FR-002).
 *
 * Asserts both the primary name (`ConfigCatProvider`) and the
 * ergonomic alias (`ConfeatureProvider`) render their children and
 * publish a live client on the Context.
 *
 * Also confirms the SDK key never appears in any console output —
 * an explicit cross-check for SC-006 / FR-028 (the redactSdkKey
 * promise is inherited from sdk-browser-js; the React layer must add
 * no new log surfaces).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ConfeatureProvider,
  ConfigCatProvider,
  PollingMode,
  useConfigCatClient,
} from "../../src/index.ts";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function ClientProbe(): JSX.Element {
  const client = useConfigCatClient();
  return <span data-testid="probe">{client ? "ready" : "missing"}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ConfigCatProvider>", () => {
  test("renders children and publishes a live client on the Context", () => {
    render(
      <ConfigCatProvider sdkKey={TEST_SDK_KEY} pollingMode={PollingMode.ManualPoll}>
        <ClientProbe />
      </ConfigCatProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("ready");
  });

  test("does NOT log the SDK key during provider mount", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ConfigCatProvider sdkKey={TEST_SDK_KEY} pollingMode={PollingMode.ManualPoll}>
        <ClientProbe />
      </ConfigCatProvider>,
    );

    const haystack = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
    ]
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(haystack).not.toContain(TEST_SDK_KEY);
  });
});

describe("<ConfeatureProvider> alias", () => {
  test("renders identically to <ConfigCatProvider>", () => {
    render(
      <ConfeatureProvider sdkKey={TEST_SDK_KEY} pollingMode={PollingMode.ManualPoll}>
        <ClientProbe />
      </ConfeatureProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("ready");
  });
});
