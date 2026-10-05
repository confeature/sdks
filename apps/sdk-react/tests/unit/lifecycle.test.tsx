// SPDX-License-Identifier: MIT

/**
 * Unit tier — provider lifecycle on identity-bearing prop changes
 * (FR-010 / T023).
 *
 * When the consumer re-renders the provider with a new `sdkKey`,
 * `pollingMode`, `options`, or `id`, the provider MUST dispose the
 * previous client and construct a fresh one in its place — keeping
 * cache state isolated per key.
 *
 * We observe construction via `options.setupHooks` (runs once per
 * construction, synchronously) and disposal via a spy on the
 * captured client instance.
 */

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigCatProvider, PollingMode, useConfigCatClient } from "../../src/index.ts";

const SDK_KEY_A =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SDK_KEY_B =
  "configcat-sdk-1-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type ClientShape = { dispose: () => void };
type SpyMarker = { __spyDisposed?: boolean };

function ClientProbe(props: { onClient: (client: ClientShape) => void }): React.ReactElement {
  const client = useConfigCatClient();
  React.useEffect(() => {
    props.onClient(client as unknown as ClientShape);
  }, [client, props]);
  return <span data-testid="probe">ok</span>;
}

describe("Provider lifecycle on prop change (FR-010 / T023)", () => {
  test("disposes the old client + constructs a new one when sdkKey changes", () => {
    let constructionCount = 0;
    const observedClients: Array<ClientShape & SpyMarker> = [];

    function harness(sdkKey: string): React.ReactElement {
      return (
        <ConfigCatProvider
          sdkKey={sdkKey}
          pollingMode={PollingMode.ManualPoll}
          options={{
            setupHooks: (): void => {
              constructionCount += 1;
            },
          }}
        >
          <ClientProbe
            onClient={(client): void => {
              const marked = client as ClientShape & SpyMarker;
              // Wrap dispose to mark the slot — once per unique
              // instance so we can count distinct constructions.
              if (!observedClients.includes(marked)) {
                const original = marked.dispose.bind(marked);
                marked.dispose = (): void => {
                  marked.__spyDisposed = true;
                  original();
                };
                observedClients.push(marked);
              }
            }}
          />
        </ConfigCatProvider>
      );
    }

    const { rerender, unmount } = render(harness(SDK_KEY_A));
    const constructionAfterFirstRender = constructionCount;
    const firstObserved = observedClients[0];
    expect(firstObserved).toBeDefined();
    expect(firstObserved?.__spyDisposed).toBeUndefined();

    // Identity-bearing prop change — the provider should swap clients.
    rerender(harness(SDK_KEY_B));

    expect(constructionCount).toBeGreaterThan(constructionAfterFirstRender);
    expect(firstObserved?.__spyDisposed).toBe(true);

    unmount();
  });
});
