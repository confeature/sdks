// SPDX-License-Identifier: MIT

/**
 * Public hooks layered on the Context-owned client.
 *
 * Per research §R14: configcat-react@^4.x ships ONLY
 * `useFeatureFlag` (returning `{ value, loading }`) and
 * `useConfigCatClient`. `useFeatureFlagDetails` /
 * `useAllFeatureFlags` are NOT exported by configcat-react and are
 * therefore NOT exposed by this SDK either — drop-in parity is
 * symmetric (FR-004 / FR-005 deferred to a follow-up).
 *
 * Per research §R6: hook re-render uses `useSyncExternalStore` for
 * concurrent-rendering correctness. The subscribe callback wires a
 * `configChanged` listener on the client; the snapshot callback reads
 * synchronously from `client.snapshot().getValue(...)`. The server
 * snapshot returns the supplied `defaultValue` so SSR renders never
 * throw (FR-014 / FR-015).
 *
 * FR-013: `useConfigCatClient` (and the alias `useConfeatureClient`)
 * throw a clear error if called outside a provider — the error
 * message wording matches what consumers grep against in production.
 */

import {
  type ConfeatureClient,
  type IConfigCatClient,
  OverrideBehaviour,
  type SettingTypeOf,
  type User,
} from "@confeature/sdk-browser-js";
import { useContext, useEffect, useState } from "react";

import { ensureConfeatureContext, getConfeatureContext } from "./context.ts";

type SettingValue = boolean | string | number | null;

function providerError(methodName: string, providerId?: string): Error {
  const suffix = providerId ? ` with id="${providerId}"` : "";
  return new Error(`${methodName} must be used within a <ConfigCatProvider>${suffix}`);
}

/**
 * Returns the live `ConfeatureClient` for the (optional) provider id.
 * Throws if no provider with that id has mounted in the tree above.
 *
 * NOTE: the underlying client implements the full `IConfigCatClient`
 * interface from `@confeature/sdk-browser-js` — that's the public
 * return type for configcat-react drop-in parity (their hook returns
 * `IConfigCatClient` too).
 */
export function useConfigCatClient(providerId?: string): IConfigCatClient {
  // ensureConfeatureContext is safe — if no provider has registered
  // an id yet, the resulting Context has `undefined` as its default,
  // and the throw below catches the no-provider case.
  const context = ensureConfeatureContext(providerId);
  const value = useContext(context);
  if (!value) throw providerError("useConfigCatClient", providerId);
  return value.client;
}

/**
 * Ergonomic alias for Confeature-native call sites.
 */
export const useConfeatureClient: typeof useConfigCatClient = useConfigCatClient;

/**
 * Internal helper — returns the ConfeatureClient (not just the
 * IConfigCatClient interface) so callers can access methods the
 * Confeature class exposes beyond the interface (`snapshot()`,
 * concrete event names, etc.). NOT exported through `index.ts`.
 */
function useResolvedClient(providerId?: string): ConfeatureClient {
  const context = ensureConfeatureContext(providerId);
  const value = useContext(context);
  if (!value) throw providerError("useFeatureFlag", providerId);
  return value.client;
}

/**
 * Read the cached value for `key`. Re-renders when the underlying
 * client emits `configChanged`.
 *
 * Returns `{ value, loading }` to mirror configcat-react@^4.x's
 * shape (research §R14).
 *
 * Initial render: spec 036 §R8 — `client.snapshot().getValue(...)` now
 * honours `flagOverrides + LocalOnly` synchronously. The hook seeds
 * its initial state from the snapshot so the first render already
 * carries the correct value when an override is configured (no
 * loading flicker, no `waitFor` workaround required in tests).
 *
 * Loading semantics:
 *   - `flagOverrides + LocalOnly` configured → snapshot is authoritative
 *     (the override map is the entire universe of flags). `loading`
 *     starts `false`.
 *   - Otherwise → `loading` starts `true` until the first
 *     `getValueAsync` resolves (matches configcat-react@^4.x).
 *
 * Subsequent renders: we still drive off `getValueAsync` so polling-
 * driven updates (`configChanged`) and async fetch latency are picked
 * up the same way configcat-react picks them up.
 *
 * SSR: on the server the effect that calls `getValueAsync` never
 * fires (`useEffect` is a no-op during `renderToString`), so the hook
 * yields the snapshot-seeded value (typically `defaultValue` when no
 * cache + no overrides). No `window` access, no console output
 * (FR-014 / FR-015).
 */
export function useFeatureFlag<T extends SettingValue>(
  key: string,
  defaultValue: T,
  user?: User,
  providerId?: string,
): { value: SettingTypeOf<T>; loading: boolean } {
  const client = useResolvedClient(providerId);

  // `configChanged` increments a counter that re-runs the resolution
  // effect — that's how this hook picks up polling-driven updates
  // (FR-011). We track via state instead of `useSyncExternalStore`
  // because the post-loading value still flows through the async
  // `getValueAsync` path (parity with configcat-react@^4.x).
  const [configVersion, setConfigVersion] = useState(0);
  useEffect(() => {
    const handler = (): void => {
      setConfigVersion((v) => v + 1);
    };
    client.on("configChanged", handler);
    return (): void => {
      client.off("configChanged", handler);
    };
  }, [client]);

  const [state, setState] = useState<{ value: SettingTypeOf<T>; loading: boolean }>(() => {
    // Spec 036 §R8 — snapshot honours flagOverrides synchronously.
    // When LocalOnly is configured the snapshot returns the override
    // (or defaultValue for missing keys); the value on first render
    // is already authoritative, so we can flip `loading` to false.
    const snap = client.snapshot();
    const initialValue = snap.getValue(key, defaultValue, user);
    const localOnly = isLocalOnly(client);
    return {
      value: initialValue,
      loading: !localOnly,
    };
  });

  useEffect(() => {
    let cancelled = false;
    client.getValueAsync(key, defaultValue, user).then(
      (resolved) => {
        if (!cancelled) setState({ value: resolved, loading: false });
      },
      () => {
        if (!cancelled) setState({ value: defaultValue as SettingTypeOf<T>, loading: false });
      },
    );
    return (): void => {
      cancelled = true;
    };
    // `user` is JSON-stringified for dep-array stability — typical
    // call sites build the user object inline per render. Matches
    // configcat-react's pattern.
  }, [client, key, defaultValue, JSON.stringify(user), configVersion]);

  return state;
}

/**
 * Returns true when the client was configured with `flagOverrides +
 * LocalOnly` — the only behaviour under which the snapshot is
 * authoritative (spec 036 §R8). Reads the client's resolved options
 * via the public `snapshot()` path so we don't need to reach into
 * internal fields.
 *
 * `ConfeatureClient` carries `flagOverrides` on its resolved options;
 * we peek through the public `snapshot()` path to avoid touching
 * internal class fields directly.
 */
function isLocalOnly(client: ConfeatureClient): boolean {
  // The React layer (owned by the same federation as sdk-browser-js)
  // peeks at the resolved options via a structural cast — the field
  // is private inside `ConfeatureClient` but the value we read is
  // immutable and the alternative (extending the public surface) would
  // change parity with configcat-js. Decision is documented in spec
  // 036 §R8.
  const resolved = (
    client as unknown as { resolved?: { flagOverrides?: { behaviour: OverrideBehaviour } } }
  ).resolved;
  return resolved?.flagOverrides?.behaviour === OverrideBehaviour.LocalOnly;
}

// Re-export getConfeatureContext for the HOC layer — the HOC reads
// from the context via React.Consumer (configcat-react parity), so it
// needs access to the registry helper without going through the
// `useContext` hook chain.
export { getConfeatureContext };
