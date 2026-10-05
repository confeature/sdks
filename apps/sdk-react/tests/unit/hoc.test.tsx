// SPDX-License-Identifier: MIT

/**
 * Unit tier — `withConfigCatClient` HOC (FR-007).
 *
 * Wraps a minimal class component, asserts the HOC injects all three
 * `WithConfigCatClientProps` (`configCatClient`, `getValue`,
 * `lastUpdated`) per the configcat-react@^4.x parity contract
 * (research §R14).
 */

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test } from "vitest";

afterEach(() => {
  cleanup();
});

import {
  ConfigCatProvider,
  PollingMode,
  withConfigCatClient,
  type WithConfigCatClientProps,
} from "../../src/index.ts";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

interface LegacyProps extends WithConfigCatClientProps {
  label: string;
}

class LegacyComponent extends React.Component<LegacyProps> {
  override render(): React.ReactNode {
    return (
      <div>
        <span data-testid="label">{this.props.label}</span>
        <span data-testid="has-client">
          {typeof this.props.configCatClient?.getValueAsync === "function" ? "yes" : "no"}
        </span>
        <span data-testid="has-getvalue">
          {typeof this.props.getValue === "function" ? "yes" : "no"}
        </span>
        <span data-testid="lastUpdated">
          {this.props.lastUpdated === undefined ? "undefined" : "defined"}
        </span>
      </div>
    );
  }
}

const Wrapped = withConfigCatClient(LegacyComponent);

describe("withConfigCatClient", () => {
  test("injects configCatClient, getValue, and lastUpdated props", () => {
    const { getByTestId } = render(
      <ConfigCatProvider sdkKey={SDK_KEY} pollingMode={PollingMode.ManualPoll}>
        <Wrapped label="hello" />
      </ConfigCatProvider>,
    );
    expect(getByTestId("label").textContent).toBe("hello");
    expect(getByTestId("has-client").textContent).toBe("yes");
    expect(getByTestId("has-getvalue").textContent).toBe("yes");
    // Initial render: no configChanged fired yet, so lastUpdated is undefined.
    expect(getByTestId("lastUpdated").textContent).toBe("undefined");
  });
});
