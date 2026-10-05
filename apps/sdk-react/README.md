# `@confeature/sdk-react`

Confeature React SDK — a Provider + hooks layer that wraps
[`@confeature/sdk-browser-js`](../sdk-browser-js/) for React 18+
applications. Drop-in compatible with
[`configcat-react@^4.x`](https://www.npmjs.com/package/configcat-react)
at the API surface level (constitution Principle II): switch one import
and one base URL, ship.

**License**: MIT.

---

## Install

```bash
npm i @confeature/sdk-react
# react + react-dom are peer deps; bring your own (^18 || ^19)
```

The runtime SDK (`@confeature/sdk-browser-js`) is bundled — you do not
need to install it separately. React itself is a peer dependency to
avoid the classic "Invalid Hook Call" duplicate-React footgun.

---

## Quickstart

```tsx
import { ConfigCatProvider, useFeatureFlag, PollingMode } from "@confeature/sdk-react";

function App() {
  return (
    <ConfigCatProvider
      sdkKey="YOUR_SDK_KEY"
      pollingMode={PollingMode.AutoPoll}
      options={{ pollIntervalSeconds: 60, baseUrl: "https://cdn.confeature.io" }}
    >
      <Dashboard />
    </ConfigCatProvider>
  );
}

function Dashboard() {
  const user = { identifier: "alice@example.com" };
  const isEnabled = useFeatureFlag("new-checkout-flow", false, user);
  return <div>{isEnabled ? "New checkout" : "Classic checkout"}</div>;
}
```

The hook re-renders automatically when the config updates (via the
polling mechanism inherited from `@confeature/sdk-browser-js`).

**SDK key.** Copy it from the Confeature dashboard. It has ConfigCat's own
shape, `configcat-sdk-1/<22 chars>/<22 chars>`; keys minted before that
change (`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

---

## ConfigCat parity table

Every public export from `configcat-react@^4.x` is enumerated below.
✅ means present and parity-tested; links point to a
`research.md §R-N` rationale for divergences.

| `configcat-react@^4.x` export                                                    | Kind      | `@confeature/sdk-react`                                             | Status                                                                                                                                     |
| -------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConfigCatProvider`                                                              | component | `ConfigCatProvider`                                                 | OK                                                                                                                                         |
| `useFeatureFlag`                                                                 | hook      | `useFeatureFlag`                                                    | OK — returns `{ value, loading }`                                                                                                          |
| `useConfigCatClient`                                                             | hook      | `useConfigCatClient`                                                | OK                                                                                                                                         |
| `withConfigCatClient`                                                            | HOC       | `withConfigCatClient`                                               | OK — same `WithConfigCatClientProps`                                                                                                       |
| `WithConfigCatClientProps`                                                       | type      | `WithConfigCatClientProps`                                          | OK                                                                                                                                         |
| `GetValueType`                                                                   | type      | `GetValueType`                                                      | OK                                                                                                                                         |
| `createFlagOverridesFromMap`                                                     | function  | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `createFlagOverridesFromQueryParams`                                             | function  | —                                                                   | deferred (see research §R8 (spec 035, not published))                                                                                      |
| `createConsoleLogger`                                                            | function  | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `PollingMode`                                                                    | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `LogLevel`                                                                       | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `DataGovernance`                                                                 | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `OverrideBehaviour`                                                              | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `SettingType`                                                                    | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `UserComparator`                                                                 | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `PrerequisiteFlagComparator`                                                     | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `SegmentComparator`                                                              | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `ClientCacheState`                                                               | enum      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `RefreshResult`                                                                  | class     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `User`                                                                           | class     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `SettingKeyValue`                                                                | class     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `FormattableLogMessage`                                                          | class     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IConfigCatClient`                                                               | type      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IConfigCatClientSnapshot`                                                       | type      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IOptions` / `IAutoPollOptions` / `IManualPollOptions` / `ILazyLoadingOptions`   | types     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IReactAutoPollOptions` / `IReactLazyLoadingOptions` / `IReactManualPollOptions` | types     | —                                                                   | aliased to the runtime SDK's types — drop the `IReact*` prefix                                                                             |
| `IReactConfigCatLogger`                                                          | type      | use `IConfigCatLogger`                                              | aliased to the runtime SDK's type                                                                                                          |
| `IConfigCatLogger`                                                               | type      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IConfigCatCache`                                                                | type      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IConfig` / `ISegment` / `ISetting` / `ITargetingRule` / `IPercentageOption`     | types     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `ISettingValue` (`SettingValue`)                                                 | type      | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `SettingTypeOf` / `IEvaluationDetails`                                           | types     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `IProvidesHooks` / `HookEvents`                                                  | types     | re-exported from sdk-browser-js                                     | OK                                                                                                                                         |
| `FlagOverrides` / `IQueryStringProvider`                                         | types     | `FlagOverrides` via sdk-browser-js; `IQueryStringProvider` deferred | partial — query-string provider deferred (see research §R8 (spec 035, not published))                                                      |
| Suspense-aware hooks (`useFeatureFlagSuspense`)                                  | hook      | —                                                                   | deferred — configcat-react does NOT ship these in v4.x (would be a Confeature-only divergence); see research §R8 (spec 035, not published) |
| `ConfeatureProvider`                                                             | component | `ConfeatureProvider`                                                | additive — ergonomic alias for `ConfigCatProvider`                                                                                         |
| `useConfeatureClient`                                                            | hook      | `useConfeatureClient`                                               | additive — ergonomic alias for `useConfigCatClient`                                                                                        |

---

## Migrating from `configcat-react`

Drop-in promise — change two lines, ship.

```diff
- import { ConfigCatProvider, useFeatureFlag, PollingMode } from "configcat-react";
+ import { ConfigCatProvider, useFeatureFlag, PollingMode } from "@confeature/sdk-react";

  <ConfigCatProvider
    sdkKey="YOUR_NEW_SDK_KEY"
    pollingMode={PollingMode.AutoPoll}
    options={{
      pollIntervalSeconds: 60,
+     baseUrl: "https://cdn.confeature.io",
    }}
  >
```

Every call site of `useFeatureFlag`, `useFeatureFlagDetails`,
`useAllFeatureFlags`, `useConfigCatClient`, `withConfigCatClient`
continues to work without changes.

---

## SSR safety (Next.js / Remix)

The provider is safe to render on the server. `@confeature/sdk-browser-js`
detects the missing `window` / `localStorage` and falls back to a
memory cache (spec 031 FR-016). Hooks return their `defaultValue`
server-side, then re-render with cached values after hydration.

```tsx
// app/layout.tsx (Next.js App Router)
"use client"; // the provider uses Context + state — Client Component required

import { ConfigCatProvider } from "@confeature/sdk-react";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ConfigCatProvider sdkKey="..." options={{ baseUrl: "https://cdn.confeature.io" }}>
      {children}
    </ConfigCatProvider>
  );
}
```

**Note**: For React Server Component (RSC) flag reads, defer to the
forthcoming server-only helper (out of scope for v0.1).

---

## Hooks reference

| Hook                       | Signature                    | Returns                               |
| -------------------------- | ---------------------------- | ------------------------------------- |
| `useFeatureFlag<T>`        | `(key, defaultValue, user?)` | The synchronously-cached value        |
| `useFeatureFlagDetails<T>` | `(key, defaultValue, user?)` | `IEvaluationDetails<T>` with metadata |
| `useAllFeatureFlags`       | `(user?)`                    | `Record<string, SettingValue>`        |
| `useConfigCatClient`       | `()`                         | The underlying `ConfeatureClient`     |
| `useConfeatureClient`      | `()`                         | Alias for `useConfigCatClient`        |

---

## React version matrix

| React | Supported | Notes                                               |
| ----- | --------- | --------------------------------------------------- |
| 19.x  | yes       | Forward-compatible with the hooks the SDK uses.     |
| 18.x  | yes       | Minimum supported. `useSyncExternalStore` required. |
| 17.x  | no        | Lacks `useSyncExternalStore` + automatic batching.  |

Pinned via `peerDependencies.react: "^18.0.0 || ^19.0.0"`.

---

## Strict Mode + dev double-mount

React Strict Mode (enabled by default in Vite + Next.js App Router)
double-mounts components in development. This SDK is Strict-Mode safe:

- Exactly one `ConfeatureClient` per logical mount (a `useRef` guard
  prevents Strict Mode's double-invocation from creating two clients).
- Exactly one `dispose()` per real unmount.

No special configuration required.

---

## Common errors

- **`Invalid Hook Call. Hooks can only be called inside of the body of a function component.`**
  Two copies of React in the tree. Run `npm ls react` — there should
  be one. The SDK uses peer-dep React; the consumer's React is the
  only one.
- **`useFeatureFlag must be used within a <ConfigCatProvider>`**
  The hook is called outside the provider. Wrap the component tree.
- **Bundle exceeds 30 KB gzipped**
  A transitive dep grew. Inspect with `vp pack --analyze`. If
  sdk-browser-js grew, the cause is upstream.
- **Tests fail with `ReferenceError: window is not defined`**
  Vitest config missing `environment: "happy-dom"`. Check
  `vite.config.ts`.
