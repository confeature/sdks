// SPDX-License-Identifier: MIT

/**
 * `<ConfigCatProvider>` — mounts a single `ConfeatureClient` per
 * logical mount, wires its `configChanged` event to a per-provider
 * `lastUpdated` Date stamp on the Context, and disposes the client on
 * unmount.
 *
 * Strict-Mode safety (research §R5 + FR-008): the client is owned by a
 * `useRef`. The Strict-Mode double-invocation of mount effects does
 * NOT create a second client because we guard construction behind a
 * `if (!ref.current)` check that runs synchronously in render. The
 * `useEffect` cleanup (FR-009) disposes the client exactly once per
 * real unmount.
 *
 * SSR safety (research §R4 + FR-014 / FR-015): client construction is
 * synchronous — it doesn't touch `window` directly (the underlying
 * `BrowserConfigCache` detects the missing `localStorage` and falls
 * back to memory). The provider renders the Provider element with a
 * `lastUpdated: undefined` slot; consumer hooks see that as "no
 * snapshot yet" and return their `defaultValue`.
 *
 * Prop-change handling (FR-010): when `sdkKey` / `pollingMode` /
 * `options` / `id` change between renders, the `useEffect` re-runs
 * with the new deps. The cleanup disposes the previous client; the
 * effect body reconstructs a fresh one via the same ref-guard pattern.
 */

import {
  type ConfeatureClient as ConfeatureClientType,
  ConfeatureClient,
  type IAutoPollOptions,
  type ILazyLoadingOptions,
  type IManualPollOptions,
  PollingMode,
} from "@confeature/sdk-browser-js";
import { useEffect, useRef, useState, type PropsWithChildren, type ReactElement } from "react";

import { ensureConfeatureContext, type ConfeatureContextData } from "./context.ts";

export interface IConfigCatProviderProps {
  /** SDK key issued by the dashboard. Never logged. */
  sdkKey: string;
  /** Polling strategy — defaults to `PollingMode.AutoPoll` (parity with configcat-react). */
  pollingMode?: PollingMode;
  /** Per-strategy options. */
  options?: IAutoPollOptions | ILazyLoadingOptions | IManualPollOptions;
  /**
   * Optional provider identifier — when set, this provider's clients
   * are isolated in a separate Context (configcat-react parity). Two
   * provider trees with different ids may coexist in one app.
   */
  id?: string;
}

/**
 * Internal helper — builds a fresh client. Extracted so the
 * Strict-Mode + prop-change paths share the same construction logic.
 */
function createClient(
  sdkKey: string,
  pollingMode: PollingMode | undefined,
  options: IConfigCatProviderProps["options"],
): ConfeatureClientType {
  return new ConfeatureClient(sdkKey, pollingMode ?? PollingMode.AutoPoll, options);
}

export function ConfigCatProvider(props: PropsWithChildren<IConfigCatProviderProps>): ReactElement {
  const { sdkKey, pollingMode, options, id, children } = props;

  // Ref-owned client — survives Strict Mode's double-mount because the
  // initial value is computed once per render and guarded by the
  // `if (!current)` check on the effect side.
  const clientRef = useRef<ConfeatureClientType | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createClient(sdkKey, pollingMode, options);
  }

  // Subscribe to `configChanged` so hooks reading `lastUpdated` re-render
  // when the underlying config updates. `lastUpdated` is also the
  // snapshot identity used by `useSyncExternalStore` to detect change.
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>(undefined);

  useEffect(() => {
    // Strict-Mode re-mount path: the cleanup below ran with the ref
    // cleared, so re-create the client here. Normal-mount path: the
    // render-time guard above populated the ref; this branch is a
    // no-op. Prop-change path: the cleanup disposed the old client +
    // cleared the ref; we re-build with the new deps.
    if (clientRef.current === null) {
      clientRef.current = createClient(sdkKey, pollingMode, options);
    }

    const client = clientRef.current;
    const handler = (): void => {
      // Bump the snapshot identity so subscribed hooks re-render with
      // the latest cached value.
      setLastUpdated(new Date());
    };
    client.on("configChanged", handler);

    return (): void => {
      client.off("configChanged", handler);
      client.dispose();
      clientRef.current = null;
    };
    // Re-run when identity-bearing props change.
  }, [sdkKey, pollingMode, options, id]);

  const context = ensureConfeatureContext(id);
  const value: ConfeatureContextData = {
    client: clientRef.current,
    lastUpdated,
  };
  return <context.Provider value={value}>{children}</context.Provider>;
}

/**
 * Ergonomic alias — `<ConfeatureProvider>` reads more naturally inside
 * Confeature-flavoured code. Identical behaviour and props.
 */
export const ConfeatureProvider: typeof ConfigCatProvider = ConfigCatProvider;
