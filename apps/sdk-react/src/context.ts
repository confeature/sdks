// SPDX-License-Identifier: MIT

/**
 * Internal React Context carrying the live client + last-update marker.
 *
 * NOT exported through `src/index.ts` — consumers reach into the
 * context via the public hooks (`useFeatureFlag`, `useConfigCatClient`)
 * rather than touching the Context object directly. This mirrors
 * `configcat-react@^4.x`'s posture (their `ConfigCatContext` is
 * package-private too).
 *
 * Multi-provider isolation: configcat-react supports an optional `id`
 * prop on the provider to allow several distinct provider trees in the
 * same app (e.g. per-tenant). We mirror that via a module-level
 * registry — `ensureConfigCatContext(id)` lazily creates a context
 * keyed by id (lowercased), so each provider tree gets its own
 * subscription channel.
 */

import type { ConfeatureClient } from "@confeature/sdk-browser-js";
import React from "react";

/**
 * Payload stored on the React Context. `lastUpdated` is bumped every
 * time the underlying client emits `configChanged`, which causes
 * subscribed consumers (hooks, HOC, `Consumer`) to re-render.
 */
export interface ConfeatureContextData {
  client: ConfeatureClient;
  lastUpdated?: Date;
}

const registry = new Map<string, React.Context<ConfeatureContextData | undefined>>();

function registryKey(providerId?: string): string {
  return providerId ? providerId.toLowerCase() : "";
}

/**
 * Returns the context for `providerId`, lazily creating one on first
 * access. Used by the provider's `render()` so a fresh provider tree
 * (with a new id) self-registers without any consumer-side wiring.
 */
export function ensureConfeatureContext(
  providerId?: string,
): React.Context<ConfeatureContextData | undefined> {
  const key = registryKey(providerId);
  let context = registry.get(key);
  if (!context) {
    context = React.createContext<ConfeatureContextData | undefined>(undefined);
    context.displayName = "ConfeatureContext" + (providerId ? "_" + providerId : "");
    registry.set(key, context);
  }
  return context;
}

/**
 * Returns the context for `providerId` if (and only if) a provider has
 * already mounted with that id. Hooks called outside a provider get
 * `undefined` from this lookup and throw the FR-013 error.
 */
export function getConfeatureContext(
  providerId?: string,
): React.Context<ConfeatureContextData | undefined> | undefined {
  return registry.get(registryKey(providerId));
}
