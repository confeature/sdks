# `@confeature/sdk-node`

The Confeature Node.js SDK — **drop-in compatible** with [`configcat-node`](https://github.com/configcat/node-sdk).
Switch from ConfigCat by changing one import line (and your SDK key).

- Constitution Principle II: ConfigCat API drop-in compatibility (NON-NEGOTIABLE).
- MIT.
- Node ≥ 18, ESM-only, zero runtime dependencies (relies on global `fetch` + `AbortController`).

---

## Install

```bash
pnpm add @confeature/sdk-node
# or
npm install @confeature/sdk-node
```

Requires Node ≥ 18.

---

## First flag (greenfield)

```ts
import { getClient } from "@confeature/sdk-node";

const client = getClient("configcat-sdk-1/<your-22-char>/<your-22-char>");

const enabled = await client.getValueAsync("feature.dark-mode", false);
if (enabled) {
  // …
}
```

That's it. The client polls the Confeature CDN every 60 seconds in the background.
Every `getValueAsync` call is served from an in-memory cache — sub-millisecond.

Confeature mints SDK keys in ConfigCat's own shape,
`configcat-sdk-1/<22 chars>/<22 chars>`. Keys minted before that change
(`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

When your service shuts down:

```ts
client.dispose();
```

---

## Migrating from `configcat-node` (drop-in)

### Public-surface parity table

| Concept         | `configcat-node`                                                       | `@confeature/sdk-node`                                                                               |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Import          | `import * as configcat from "configcat-node";`                         | `import * as configcat from "@confeature/sdk-node";`                                                 |
| Create client   | `getClient(sdkKey)`                                                    | identical                                                                                            |
| Polling modes   | `PollingMode.AutoPoll/LazyLoad/ManualPoll`                             | identical (v1: LazyLoad/ManualPoll route to AutoPoll internally; full implementation in a follow-up) |
| Get value       | `getValueAsync(key, def, user?)`                                       | identical (v1: boolean only; non-bool returns default + Warn log)                                    |
| Get all keys    | `getAllKeysAsync()`                                                    | identical                                                                                            |
| Force refresh   | `forceRefreshAsync()`                                                  | identical                                                                                            |
| Dispose         | `dispose()`                                                            | identical                                                                                            |
| Logger          | `IConfigCatLogger`, `createConsoleLogger(level)`                       | identical                                                                                            |
| Data governance | `DataGovernance.Global/EuOnly`                                         | accepted; both map to Confeature's global CDN today                                                  |
| Options         | `IAutoPollOptions/IManualPollOptions/ILazyLoadingOptions`              | identical shape                                                                                      |
| Hooks           | `on('clientReady'\|'clientError'\|'configChanged'\|'flagEvaluated')`   | `clientReady` + `clientError` emit; others wired but unused in v1                                    |
| User targeting  | `new User(id, email?, country?, custom?)` + `getValueAsync(..., user)` | signature accepted; v1 evaluator ignores                                                             |

### Migration steps

1. **Swap imports**:

   ```diff
   - import { getClient, PollingMode } from "configcat-node";
   + import { getClient, PollingMode } from "@confeature/sdk-node";
   ```

2. **Set the base URL** (one of two equivalent options):
   - Provide your Confeature SDK key directly:
     ```ts
     const client = getClient("configcat-sdk-1/...");
     ```
   - Or keep your ConfigCat SDK key for now and override `baseUrl`:
     ```ts
     const client = getClient("your-configcat-sdk-key", PollingMode.AutoPoll, {
       baseUrl: "https://cdn.confeature.io",
     });
     ```

3. **Done**. Your existing code that calls `getValueAsync`, `getAllKeysAsync`,
   `forceRefreshAsync`, `dispose` continues to compile and run unchanged.

---

## What the v1 SDK deliberately does NOT do

These are accepted in the API surface (signature-compatible) but not yet
exercised; they ship in follow-up plans.

- `PollingMode.LazyLoad` and `PollingMode.ManualPoll` — accepted; v1 routes them to AutoPoll. Logged once at construction at Warn.
- `User`-based targeting — accepted; evaluator does not consume it (no segments, no rollout rules in v1 payloads).
- Non-boolean flag types (string/int/double) — accepted in the type system; eval returns default + TYPE_MISMATCH log.
- External cache (`IConfigCatCache`) — accepted in options; v1 uses in-memory only.
- `proxy` option — accepted; ignored.
- `dataGovernance: EuOnly` — accepted; uses the same CDN.

---

## Fail-closed contract

`getValueAsync` ALWAYS returns the supplied default value if anything goes wrong.
The SDK NEVER throws from a public method. Failures surface via the optional logger:

```ts
import { getClient, createConsoleLogger, LogLevel } from "@confeature/sdk-node";

const client = getClient("configcat-sdk-1/...", undefined, {
  logger: createConsoleLogger(LogLevel.Warn, "\n"),
});
```

Common log events you might see:

| Event             | Meaning                                               | What to do                                                       |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `FETCH_FAILED`    | Network error reaching the CDN                        | Check connectivity. Cached values continue to serve.             |
| `INVALID_SDK_KEY` | CDN returned 403 or 404                               | Verify the SDK key in your Confeature dashboard.                 |
| `PARSE_FAILED`    | Malformed config payload                              | File an issue; usually a server-side problem.                    |
| `KEY_NOT_FOUND`   | Eval for a flag that doesn't exist                    | Check the flag key + that the config has been published.         |
| `TYPE_MISMATCH`   | Asked for boolean, payload had string (or vice-versa) | v1 supports boolean only. Track non-bool support in the backlog. |

---

## Polling behaviour

- Default: poll every **60 seconds**.
- Configurable via `pollIntervalSeconds`:
  ```ts
  getClient(sdkKey, PollingMode.AutoPoll, { pollIntervalSeconds: 30 });
  ```
- Minimum 1 second (lower values clamped + Warn log).
- Background-only — `getValueAsync` never blocks on a fetch.
- ETag-aware — `304 Not Modified` responses skip parsing.
- Stale-on-error — if a poll fails, the previously-fetched config continues to serve.

---

## Performance

- p95 of cache-served `getValueAsync` < 1 ms (measured by `tests/parity/microbench.test.ts`).
- One CDN fetch per `pollIntervalSeconds` interval, plus the initial cold-start fetch.
- Zero allocations on `304 Not Modified` responses.

---

## Tests

Three tiers, all required (constitution Principle VI + agent definition):

- **Unit** — `tests/unit/`: evaluator, polling timer, cache, logger, SDK-key redaction.
- **Contract** — `tests/contract/`: verifies the request URL and headers against ConfigCat's wire contract. (The round-trip of the API's published `config_v6.json` through the engine is tested on the API side.)
- **Parity** — `tests/parity/`: spins up both `@confeature/sdk-node` and `configcat-node` against a shared stubbed `fetch`, asserts identical return values. **Required on every CI build.**

Run from the repo root:

```bash
vp run -r test
```

---

## License & support

MIT. Source: <https://github.com/confeature/sdks/tree/main/apps/sdk-node>.
Issues: same repo's issue tracker.

The SDK is owned by the `sdk-node` agent. Constitution Principle IV — every SDK
has one owning specialist, and this is hers.
