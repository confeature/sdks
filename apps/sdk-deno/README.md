# @confeature/sdk-deno

Confeature Deno SDK — drop-in compatible with
[`configcat-js`](https://www.npmjs.com/package/configcat-js) on the
[Deno](https://deno.com) runtime (≥ 1.40). Reads `config_v6.json` from
`cdn.confeature.io`, evaluates flags entirely client-side, caches via
`Deno.writeTextFile` with a permission-aware in-memory fallback.
ESM-only.

> **License**: MIT. Carry the SPDX header on every
> source file you add.

## Install

Deno consumes the package via the `npm:` specifier:

```ts
import { ConfeatureClient, PollingMode } from "npm:@confeature/sdk-deno";
```

No `deno.json` import map required — Deno reads `package.json`
natively.

## Quickstart

```ts
// Save as `app.ts`:
import { ConfeatureClient, PollingMode } from "npm:@confeature/sdk-deno";

const client = new ConfeatureClient("YOUR_SDK_KEY", PollingMode.AutoPoll, {
  pollIntervalSeconds: 60,
});

const user = { identifier: "alice@example.com", email: "alice@example.com" };
const isEnabled = await client.getValueAsync("new-checkout-flow", false, user);
console.log("flag value:", isEnabled);
```

```bash
deno run \
  --allow-net=cdn.confeature.io \
  --allow-read=$TMPDIR \
  --allow-write=$TMPDIR \
  --allow-env=TMPDIR \
  app.ts
```

**SDK key.** Copy it from the Confeature dashboard. It has ConfigCat's own
shape, `configcat-sdk-1/<22 chars>/<22 chars>`; keys minted before that
change (`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

## Permission flags

Deno enforces a per-script permission model. The SDK works at three
levels — pick the strictness your operator needs:

| Level                  | Flags                                                                                         | Behaviour                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Full**               | `--allow-net=cdn.confeature.io --allow-read=$TMPDIR --allow-write=$TMPDIR --allow-env=TMPDIR` | Filesystem-cached config persists across runs.                                                             |
| **Net + cache-write**  | `--allow-net=cdn.confeature.io --allow-write=$TMPDIR --allow-env=TMPDIR`                      | Same as full; cache reads fail silently → next process re-fetches on cold start.                           |
| **Net-only (minimum)** | `--allow-net=cdn.confeature.io`                                                               | Memory cache only. Exactly one warn-level log fires on the first cache-write attempt (no spam on retries). |

The SDK auto-detects missing permissions via the thrown
`Deno.errors.PermissionDenied` / `Deno.errors.NotCapable` /
`Deno.errors.NotFound` and gracefully falls back without crashing.
**You never need to wrap SDK calls in try/catch for permission
errors.**

## Migrating from `configcat-js`

The drop-in promise: change two things, ship.

```diff
- import { ConfigCatClient, PollingMode } from "npm:configcat-js";
+ import { ConfeatureClient, PollingMode } from "npm:@confeature/sdk-deno";

  const client = new ConfeatureClient("YOUR_NEW_SDK_KEY", PollingMode.AutoPoll, {
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

| ConfigCat surface                                                                        | Confeature equivalent                                       | Status                                                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `getClient(sdkKey, mode?, opts?)`                                                        | `getClient(sdkKey, mode?, opts?)`                           | ✅                                                                                        |
| `disposeAllClients()`                                                                    | `disposeAllClients()`                                       | ✅                                                                                        |
| `ConfigCatClient` class                                                                  | `ConfeatureClient` class (alias `ConfigCatClient` exported) | ✅                                                                                        |
| `PollingMode.AutoPoll`                                                                   | `PollingMode.AutoPoll`                                      | ✅                                                                                        |
| `PollingMode.LazyLoad`                                                                   | `PollingMode.LazyLoad`                                      | ✅                                                                                        |
| `PollingMode.ManualPoll`                                                                 | `PollingMode.ManualPoll`                                    | ✅                                                                                        |
| `IAutoPollOptions { pollIntervalSeconds, maxInitWaitTimeSeconds }`                       | same                                                        | ✅                                                                                        |
| `ILazyLoadingOptions { cacheTimeToLiveSeconds }`                                         | same                                                        | ✅                                                                                        |
| `IManualPollOptions`                                                                     | same                                                        | ✅                                                                                        |
| `User(identifier, email?, country?, custom?)`                                            | same                                                        | ✅                                                                                        |
| `getValueAsync(key, default, user?)`                                                     | same                                                        | ✅                                                                                        |
| `getValueDetailsAsync(...)`                                                              | same                                                        | ✅                                                                                        |
| `getAllKeysAsync()`                                                                      | same                                                        | ✅                                                                                        |
| `getAllValuesAsync(user?)`                                                               | same                                                        | ✅                                                                                        |
| `getAllValueDetailsAsync(user?)`                                                         | same                                                        | ✅                                                                                        |
| `getKeyAndValueAsync(variationId)`                                                       | same                                                        | ✅                                                                                        |
| `forceRefreshAsync()`                                                                    | same                                                        | ✅                                                                                        |
| `waitForReady()`                                                                         | same                                                        | ✅                                                                                        |
| `snapshot()`                                                                             | same                                                        | ✅                                                                                        |
| `setDefaultUser(user)`                                                                   | same                                                        | ✅                                                                                        |
| `clearDefaultUser()`                                                                     | same                                                        | ✅                                                                                        |
| `isOffline()` / `setOnline()` / `setOffline()`                                           | same                                                        | ✅                                                                                        |
| `dispose()`                                                                              | same                                                        | ✅                                                                                        |
| `on/off/once("clientReady" \| "clientError" \| "configChanged" \| "flagEvaluated", ...)` | same                                                        | ✅                                                                                        |
| `IConfigCatLogger`                                                                       | re-exported from `@confeature/sdk-shared`                   | ✅                                                                                        |
| `LogLevel`                                                                               | re-exported                                                 | ✅                                                                                        |
| `ConfigCatConsoleLogger` / `createConsoleLogger(level, eol?)`                            | re-exported; default logger writes to `console.*`           | ✅                                                                                        |
| `IConfigCatCache`                                                                        | re-exported                                                 | ⚠ v1 uses `Deno.writeTextFile` (filesystem) + permission-aware memory fallback by default |
| `FlagOverrides` / `createFlagOverridesFromMap(...)` / `OverrideBehaviour`                | re-exported; `OverrideBehaviour.LocalOnly` fully wired      | ✅                                                                                        |
| `DataGovernance`                                                                         | same                                                        | ✅                                                                                        |
| `RefreshResult` / `ClientCacheState`                                                     | re-exported                                                 | ✅                                                                                        |
| `IEvaluationDetails<T>`                                                                  | re-exported                                                 | ✅                                                                                        |
| `SettingKeyValue`                                                                        | same                                                        | ✅                                                                                        |
| `ProjectConfig` (advanced)                                                               | re-exported                                                 | ✅                                                                                        |
| Wire types (`IConfig`, `ISetting`, …)                                                    | re-exported                                                 | ✅                                                                                        |

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
`${Deno.env.get('TMPDIR') ?? '/tmp'}/confeature-cache-v1/<hashed-sdk-key>.json`
via `Deno.writeTextFile`. The SDK auto-falls back to an in-memory
cache when:

- `Deno.writeTextFile` throws `Deno.errors.PermissionDenied` (missing
  `--allow-write`),
- `Deno.env.get` throws `PermissionDenied` (missing `--allow-env`),
- `Deno.mkdir` throws `Deno.errors.NotCapable` (sandboxed runtime),
- the cache directory cannot be created (read-only FS), or
- `options.cache === "memory"` is set explicitly.

On fallback the SDK emits **exactly one** warn-level log per process
lifetime via the configured `IConfigCatLogger`, naming the relevant
Deno permission flag where applicable. Subsequent writes silently
skip the FS without re-logging.

The cache file's name uses `deriveCacheKey(sdkKey)` from
`@confeature/sdk-shared` — the raw SDK key never touches disk in
plaintext.

## Deno version matrix

| Deno       | Supported                                         |
| ---------- | ------------------------------------------------- |
| 1.40 – 2.x | ✅                                                |
| < 1.40     | ❌ (`Deno.writeTextFile` + permissions API churn) |
| Node.js    | ❌ — use `@confeature/sdk-node` instead           |
| Bun        | ❌ — use `@confeature/sdk-bun` instead            |

`engines.deno >= 1.40`; no `engines.node`, no `engines.bun` declared.

## Bundle size

SC-002 budget: the gzipped ESM bundle MUST stay ≤ 25 KB. The
post-build step (`scripts/check-bundle-size.mjs`) asserts the budget
on every CI run.

## Architecture

The runtime-agnostic evaluator + wire types + sdk-key helpers + User
class + FlagOverrides live in `@confeature/sdk-shared`. This SDK is
the Deno-flavoured orchestration on top of the shared core. See
`tools/verify-sdk-extraction-manifest.mjs` for the
"Architectural Extraction Manifest" and
spec 033's `research.md` (not published) for the Deno-specific
deltas (cache backend + permission-aware fallback).

## Tests

```bash
cd apps/sdk-deno
vp run test          # all three tiers (unit + contract + parity)
```

Tests run under Node via vitest — the Deno runtime is **not** required
to run the test suite. Cache tests stub `globalThis.Deno` to exercise
the fs-path, permission-denied, and missing-Deno fallback paths
without a real Deno runtime in CI (research §R8).

Three test tiers (matching every other SDK in the federation):

1. **Unit** — pure logic with `vi.useFakeTimers()`; fetcher with
   mocked `globalThis.fetch`; cache fallback paths (including the
   SC-009 PermissionDenied path); SDK-key leak audit (SC-006).
2. **Contract** — types compile against `@confeature/sdk-shared`'s
   re-export of `packages/contract`; canonical config_v6 fixture
   parses + evaluates deterministically.
3. **Parity** — byte-identical evaluation vs `configcat-js@^9.4.0`
   across the 58 tuples in `@confeature/test-fixtures-sdk-parity`.

## License

MIT. See `LICENSE` at the repo root.
