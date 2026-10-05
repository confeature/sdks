# @confeature/sdk-browser-js

Confeature Browser JS SDK — drop-in compatible with
[`configcat-js`](https://www.npmjs.com/package/configcat-js). Reads
`config_v6.json` from `cdn.confeature.io`, evaluates flags entirely
client-side, ships ESM + CJS + IIFE bundles.

> **License**: MIT. Carry the SPDX header on every source
> file you add.

## Install

### npm / pnpm / yarn

```bash
npm install @confeature/sdk-browser-js
# or:
pnpm add @confeature/sdk-browser-js
yarn add @confeature/sdk-browser-js
```

### CDN `<script>` tag

```html
<script src="https://unpkg.com/@confeature/sdk-browser-js@latest/dist/confeature.iife.js"></script>
<script>
  const client = new Confeature.ConfeatureClient("YOUR_SDK_KEY");
  const isEnabled = client.getValue("flag-a", false);
</script>
```

## Quickstart

```ts
import { ConfeatureClient, AutoPoll } from "@confeature/sdk-browser-js";

const client = new ConfeatureClient("YOUR_SDK_KEY", {
  pollingMode: new AutoPoll({ pollIntervalSeconds: 60 }),
});

const user = { identifier: "alice@example.com", email: "alice@example.com" };
const isEnabled = client.getValue("new-checkout-flow", false, user);
```

**SDK key.** Copy it from the Confeature dashboard. It has ConfigCat's own
shape, `configcat-sdk-1/<22 chars>/<22 chars>`; keys minted before that
change (`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

## Migrating from `configcat-js`

The drop-in promise: change two things, ship.

```diff
- import { getClient, PollingMode } from "configcat-js";
+ import { getClient, PollingMode } from "@confeature/sdk-browser-js";

  const client = getClient("YOUR_NEW_SDK_KEY", PollingMode.AutoPoll, {
    pollIntervalSeconds: 60,
+   baseUrl: "https://cdn.confeature.io",
  });
```

Every call site of `getValueAsync`, `getValueDetailsAsync`,
`getAllKeysAsync`, `getAllValuesAsync`, `forceRefreshAsync`, and the
hook `on("configChanged", ...)` continues to work without changes.

## ConfigCat parity table

Reference: `configcat-js@^9.4.0`. Status column: ✅ = same shape and
semantics, ⚠ = accepted but routed to a v1 simplification, link = see
the linked `research.md §R-N` rationale.

| ConfigCat surface                                                                        | Confeature equivalent                            | Status                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `getClient(sdkKey, mode?, opts?)`                                                        | `getClient(sdkKey, mode?, opts?)`                | ✅                                                    |
| `disposeAllClients()`                                                                    | `disposeAllClients()`                            | ✅                                                    |
| `ConfigCatClient` class                                                                  | `ConfeatureClient` class (namespace rename)      | ✅                                                    |
| `PollingMode.AutoPoll`                                                                   | `PollingMode.AutoPoll`                           | ✅                                                    |
| `PollingMode.LazyLoad`                                                                   | `PollingMode.LazyLoad`                           | ⚠ v1 routed to AutoPoll                               |
| `PollingMode.ManualPoll`                                                                 | `PollingMode.ManualPoll`                         | ⚠ v1 routed to AutoPoll                               |
| `AutoPoll({ pollIntervalSeconds })`                                                      | `AutoPoll({ pollIntervalSeconds })`              | ✅                                                    |
| `LazyLoad({ cacheTimeToLiveSeconds })`                                                   | `LazyLoad({ cacheTimeToLiveSeconds })`           | ✅                                                    |
| `ManualPoll()`                                                                           | `ManualPoll()`                                   | ✅                                                    |
| `User(identifier, email?, country?, custom?)`                                            | `User(identifier, email?, country?, custom?)`    | ✅                                                    |
| `getValueAsync(key, default, user?)`                                                     | `getValueAsync(key, default, user?)`             | ✅                                                    |
| `getValueDetailsAsync(...)`                                                              | `getValueDetailsAsync(...)`                      | ✅                                                    |
| `getAllKeysAsync()`                                                                      | `getAllKeysAsync()`                              | ✅                                                    |
| `getAllValuesAsync(user?)`                                                               | `getAllValuesAsync(user?)`                       | ✅                                                    |
| `getAllValueDetailsAsync(user?)`                                                         | `getAllValueDetailsAsync(user?)`                 | ✅                                                    |
| `getKeyAndValueAsync(variationId)`                                                       | `getKeyAndValueAsync(variationId)`               | ✅                                                    |
| `forceRefreshAsync()`                                                                    | `forceRefreshAsync()`                            | ✅                                                    |
| `waitForReady()`                                                                         | `waitForReady()`                                 | ✅                                                    |
| `snapshot()`                                                                             | `snapshot()`                                     | ✅                                                    |
| `setDefaultUser(user)`                                                                   | `setDefaultUser(user)`                           | ✅                                                    |
| `clearDefaultUser()`                                                                     | `clearDefaultUser()`                             | ✅                                                    |
| `isOffline()` / `setOnline()` / `setOffline()`                                           | `isOffline()` / `setOnline()` / `setOffline()`   | ✅                                                    |
| `dispose()`                                                                              | `dispose()`                                      | ✅                                                    |
| `on/off/once("clientReady" \| "clientError" \| "configChanged" \| "flagEvaluated", ...)` | same                                             | ✅                                                    |
| `IConfigCatLogger`                                                                       | `IConfigCatLogger` re-exported                   | ✅                                                    |
| `LogLevel`                                                                               | `LogLevel`                                       | ✅                                                    |
| `ConfigCatConsoleLogger`                                                                 | `ConfigCatConsoleLogger` (writes to `console.*`) | ✅                                                    |
| `createConsoleLogger(level, eol?)`                                                       | `createConsoleLogger(level, eol?)`               | ✅                                                    |
| `IConfigCatCache`                                                                        | `IConfigCatCache` re-exported                    | ⚠ accepted, v1 uses localStorage+memory by default    |
| `FlagOverrides`                                                                          | `FlagOverrides`                                  | ⚠ shape parity, v1 evaluator does not apply overrides |
| `createFlagOverridesFromMap(...)`                                                        | `createFlagOverridesFromMap(...)`                | ⚠ shape parity (see above)                            |
| `OverrideBehaviour`                                                                      | `OverrideBehaviour`                              | ✅                                                    |
| `DataGovernance`                                                                         | `DataGovernance`                                 | ✅                                                    |
| `RefreshResult` / `ClientCacheState`                                                     | `RefreshResult` / `ClientCacheState`             | ✅                                                    |
| `IEvaluationDetails<T>`                                                                  | `IEvaluationDetails<T>`                          | ✅                                                    |
| `SettingKeyValue`                                                                        | `SettingKeyValue`                                | ✅                                                    |
| `ProjectConfig` (advanced)                                                               | `ProjectConfig`                                  | ✅                                                    |
| Wire types (`IConfig`, `ISetting`, …)                                                    | Wire types (`IConfig`, `ISetting`, …)            | ✅                                                    |

If a row is missing, the SDK either does not surface it (and we'll
add it on demand) or it is one of the documented divergences. See the
parity tier (`tests/parity/parity-corpus.test.ts`) for the
byte-identical proof against `configcat-js`.

## Polling modes

- **AutoPoll** (default): the background timer ticks every
  `pollIntervalSeconds` (default 60). Each tick refreshes the cache
  on the SDK's behalf. The first `getValue` call after construction
  serves the synchronously-hydrated cached config — no network wait
  (per `research.md §R13`).
- **LazyLoad**: shape-compat with `configcat-js`. v1 ships the same
  AutoPoll timer under the hood.
- **ManualPoll**: shape-compat. v1 ships the same AutoPoll timer; an
  explicit `forceRefresh()` is still honoured.

## Browser support

Last 2 versions of Chrome, Firefox, Safari, Edge. No IE11. The SDK
assumes `globalThis.fetch`, `AbortController`, `Promise`, and
`localStorage` (with auto-fallback to memory if the host blocks it —
private-mode Safari, embedded WebViews, etc.).

## Bundle size

SC-002 budget: the gzipped ESM bundle MUST stay ≤ 25 KB. The post-
build step (`scripts/check-bundle-size.mjs`) asserts the budget on
every CI run.

## Architecture

The runtime-agnostic evaluator + wire types + sdk-key helpers + User
class live in `@confeature/sdk-shared`. This SDK is the
browser-flavoured orchestration on top of the shared core.
`tools/verify-sdk-extraction-manifest.mjs` holds the full
"Architectural Extraction Manifest".

## Tests

```bash
cd apps/sdk-browser-js
vp run test                        # all three tiers
pnpm test:unit                     # logic correctness, fake timers
pnpm test:contract                 # parsed config against packages/contract types
pnpm test:parity                   # byte-identical output vs configcat-js
```

## License

MIT. See `LICENSE` at the repo root.
