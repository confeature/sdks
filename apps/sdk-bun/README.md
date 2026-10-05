# @confeature/sdk-bun

Confeature Bun SDK — drop-in compatible with
[`configcat-js`](https://www.npmjs.com/package/configcat-js) on the
[Bun](https://bun.sh) runtime. Reads `config_v6.json` from
`cdn.confeature.io`, evaluates flags entirely client-side, caches via
`Bun.file()`. ESM-only.

> **License**: MIT. Carry the SPDX header on every
> source file you add.

## Install

```bash
bun add @confeature/sdk-bun
```

## Quickstart

```ts
import { ConfeatureClient, PollingMode } from "@confeature/sdk-bun";

const client = new ConfeatureClient("YOUR_SDK_KEY", PollingMode.AutoPoll, {
  pollIntervalSeconds: 60,
});

const user = { identifier: "alice@example.com", email: "alice@example.com" };
const isEnabled = await client.getValueAsync("new-checkout-flow", false, user);
```

**SDK key.** Copy it from the Confeature dashboard. It has ConfigCat's own
shape, `configcat-sdk-1/<22 chars>/<22 chars>`; keys minted before that
change (`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

## Migrating from `configcat-js`

The drop-in promise: change two things, ship.

```diff
- import { getClient, PollingMode } from "configcat-js";
+ import { getClient, PollingMode } from "@confeature/sdk-bun";

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

| ConfigCat surface                                                                        | Confeature equivalent                                       | Status                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `getClient(sdkKey, mode?, opts?)`                                                        | `getClient(sdkKey, mode?, opts?)`                           | ✅                                                               |
| `disposeAllClients()`                                                                    | `disposeAllClients()`                                       | ✅                                                               |
| `ConfigCatClient` class                                                                  | `ConfeatureClient` class (alias `ConfigCatClient` exported) | ✅                                                               |
| `PollingMode.AutoPoll`                                                                   | `PollingMode.AutoPoll`                                      | ✅                                                               |
| `PollingMode.LazyLoad`                                                                   | `PollingMode.LazyLoad`                                      | ✅                                                               |
| `PollingMode.ManualPoll`                                                                 | `PollingMode.ManualPoll`                                    | ✅                                                               |
| `IAutoPollOptions { pollIntervalSeconds, maxInitWaitTimeSeconds }`                       | same                                                        | ✅                                                               |
| `ILazyLoadingOptions { cacheTimeToLiveSeconds }`                                         | same                                                        | ✅                                                               |
| `IManualPollOptions`                                                                     | same                                                        | ✅                                                               |
| `User(identifier, email?, country?, custom?)`                                            | same                                                        | ✅                                                               |
| `getValueAsync(key, default, user?)`                                                     | same                                                        | ✅                                                               |
| `getValueDetailsAsync(...)`                                                              | same                                                        | ✅                                                               |
| `getAllKeysAsync()`                                                                      | same                                                        | ✅                                                               |
| `getAllValuesAsync(user?)`                                                               | same                                                        | ✅                                                               |
| `getAllValueDetailsAsync(user?)`                                                         | same                                                        | ✅                                                               |
| `getKeyAndValueAsync(variationId)`                                                       | same                                                        | ✅                                                               |
| `forceRefreshAsync()`                                                                    | same                                                        | ✅                                                               |
| `waitForReady()`                                                                         | same                                                        | ✅                                                               |
| `snapshot()`                                                                             | same                                                        | ✅                                                               |
| `setDefaultUser(user)`                                                                   | same                                                        | ✅                                                               |
| `clearDefaultUser()`                                                                     | same                                                        | ✅                                                               |
| `isOffline()` / `setOnline()` / `setOffline()`                                           | same                                                        | ✅                                                               |
| `dispose()`                                                                              | same                                                        | ✅                                                               |
| `on/off/once("clientReady" \| "clientError" \| "configChanged" \| "flagEvaluated", ...)` | same                                                        | ✅                                                               |
| `IConfigCatLogger`                                                                       | re-exported from `@confeature/sdk-shared`                   | ✅                                                               |
| `LogLevel`                                                                               | re-exported                                                 | ✅                                                               |
| `ConfigCatConsoleLogger` / `createConsoleLogger(level, eol?)`                            | re-exported; default logger writes to `console.*`           | ✅                                                               |
| `IConfigCatCache`                                                                        | re-exported                                                 | ⚠ v1 uses `Bun.file()` (filesystem) + memory fallback by default |
| `FlagOverrides` / `createFlagOverridesFromMap(...)` / `OverrideBehaviour`                | re-exported; `OverrideBehaviour.LocalOnly` fully wired      | ✅                                                               |
| `DataGovernance`                                                                         | same                                                        | ✅                                                               |
| `RefreshResult` / `ClientCacheState`                                                     | re-exported                                                 | ✅                                                               |
| `IEvaluationDetails<T>`                                                                  | re-exported                                                 | ✅                                                               |
| `SettingKeyValue`                                                                        | same                                                        | ✅                                                               |
| `ProjectConfig` (advanced)                                                               | re-exported                                                 | ✅                                                               |
| Wire types (`IConfig`, `ISetting`, …)                                                    | re-exported                                                 | ✅                                                               |

If a row is missing, the SDK either does not surface it (and we'll
add it on demand) or it is one of the documented divergences. See
the parity tier (`tests/parity/parity-corpus.test.ts`) for the
byte-identical proof against `configcat-js`.

## Polling modes

- **AutoPoll** (default): the background timer ticks every
  `pollIntervalSeconds` (default 60). Each tick refreshes the cache
  on the SDK's behalf. The first `getValueAsync` call after
  construction serves the synchronously-hydrated cached config — no
  network wait.
- **LazyLoad**: cache TTL via `cacheTimeToLiveSeconds` (default 60).
  `getValueAsync` triggers a background refresh when the cache age
  exceeds the TTL.
- **ManualPoll**: no implicit fetches; an explicit
  `forceRefreshAsync()` is the only trigger.

## Caching

By default the SDK persists the config payload to
`${os.tmpdir()}/confeature-cache-v1/<hashed-sdk-key>.json` via
`Bun.file()`. If the filesystem is unwritable (read-only FS, quota,
permission), or when `options.cache === "memory"` is set explicitly,
the SDK auto-falls back to an in-memory cache and emits one
warn-level log via the configured `IConfigCatLogger`.

The cache file's name uses
`deriveCacheKey(sdkKey)` from `@confeature/sdk-shared` — the raw SDK
key never touches disk in plaintext.

## Bun version matrix

| Bun       | Supported                                       |
| --------- | ----------------------------------------------- |
| 1.0 – 1.x | ✅                                              |
| < 1.0     | ❌ (pre-stable; `Bun.file()` semantics shifted) |
| Node.js   | ❌ — use `@confeature/sdk-node` instead         |
| Deno      | ❌ — use `@confeature/sdk-deno` (forthcoming)   |

`engines.bun >= 1.0`; no `engines.node` is declared so `npm install`
from a Node project surfaces a meaningful warning.

## Bundle size

SC-002 budget: the gzipped ESM bundle MUST stay ≤ 25 KB. The
post-build step (`scripts/check-bundle-size.mjs`) asserts the budget
on every CI run.

## Architecture

The runtime-agnostic evaluator + wire types + sdk-key helpers + User
class + FlagOverrides live in `@confeature/sdk-shared`. This SDK is
the Bun-flavoured orchestration on top of the shared core. See
`tools/verify-sdk-extraction-manifest.mjs` for the
"Architectural Extraction Manifest" and
spec 032's `research.md` (not published) for the Bun-specific
deltas.

## Tests

```bash
cd apps/sdk-bun
vp run test          # all three tiers (unit + contract + parity)
```

Three test tiers (matching every other SDK in the federation):

1. **Unit** — pure logic with `vi.useFakeTimers()`; fetcher with
   mocked `globalThis.fetch`; cache fallback paths; SDK-key leak
   audit (SC-006).
2. **Contract** — types compile against `@confeature/sdk-shared`'s
   re-export of `packages/contract`; canonical config_v6 fixture
   parses + evaluates deterministically.
3. **Parity** — byte-identical evaluation vs `configcat-js@^9.4.0`
   across the 58 tuples in `@confeature/test-fixtures-sdk-parity`.

## License

MIT. See `LICENSE` at the repo root.
