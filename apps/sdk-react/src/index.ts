// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/sdk-react`.
 *
 * The React SDK re-exports every symbol from `@confeature/sdk-browser-js`
 * so consumers can `import { ConfeatureClient, PollingMode, User }
 * from "@confeature/sdk-react"` without a separate runtime-SDK install
 * (research §R7). On top of that base it layers the React-specific
 * additions: `<ConfigCatProvider>` / `<ConfeatureProvider>`, the hooks,
 * and the `withConfigCatClient` HOC.
 *
 * Reference for the parity surface: see
 * `node_modules/.pnpm/configcat-react@^4.x/node_modules/configcat-react/lib/types/index.d.ts`
 * — the actual `configcat-react` shape, captured in research §R14.
 */

// ---- Re-exports from the runtime SDK -------------------------------
export * from "@confeature/sdk-browser-js";

// ---- React-specific additions --------------------------------------
export {
  ConfeatureProvider,
  ConfigCatProvider,
  type IConfigCatProviderProps,
} from "./provider.tsx";

export { useConfeatureClient, useConfigCatClient, useFeatureFlag } from "./hooks.ts";

export { type GetValueType, type WithConfigCatClientProps, withConfigCatClient } from "./hoc.tsx";

// ---- Version (React layer) -----------------------------------------
// The runtime SDK's `CONFEATURE_SDK_VERSION` already comes through via
// the `export *` above. The React-layer version is intentionally NOT
// re-exported here so consumers don't import two same-named constants.
