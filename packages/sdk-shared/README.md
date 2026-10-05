# @confeature/sdk-shared

Runtime-agnostic core shared by every Confeature SDK. Holds:

- The **rule-matching evaluator** (`RolloutEvaluator`).
- The **wire types** for `config_v6.json` (`IConfig`, `ISetting`, …).
- **SDK-key parsing + redaction** helpers (`isValidConfeatureKeyFormat`,
  `redactSdkKey`, `deriveCacheKey`).
- The **logger interface** + `LoggerWrapper` (event-id-stamped helpers
  every SDK uses internally) + `ConfigCatConsoleLogger`.
- The **User** class (flag-targeting context).
- Shared internal **types** (`SdkErrorCode`).

> License: MIT. SPDX headers on every file.

## What lives here vs. in each SDK package

| In `@confeature/sdk-shared`                                       | In each `apps/sdk-*`                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Evaluator + wire types + User + SDK-key utils + logger primitives | Runtime-specific orchestration (fetcher, cache backend, poll service, public client class) |

Each SDK package re-exports the symbols it surfaces publicly (per
constitution Principle II's "drop-in" rule). Internal SDK code imports
the implementations directly from `@confeature/sdk-shared`.

## How `apps/sdk-bun` (#42) / `apps/sdk-deno` (#43) consume this

The architectural-leverage clause (FR-033 / FR-034 / SC-007) requires
that the next browser-runtime-adjacent SDKs land **without touching this
package**. Verification gesture at #42 PR time:

```bash
# From the #42 branch — must show 0 lines changed:
git diff --stat origin/main packages/sdk-shared/ packages/test-fixtures-sdk-parity/
```

If non-zero, the Bun SDK has duplicated or extended shared code —
SC-BROWSER-01 fails — block the PR.

A new SDK consumes the package like this:

```ts
// apps/sdk-bun/src/client.ts (example)
import {
  RolloutEvaluator,
  LoggerWrapper,
  NullLogger,
  ProjectConfig,
  User,
  isValidConfeatureKeyFormat,
  deriveCacheKey,
  type IConfig,
} from "@confeature/sdk-shared";
```

The runtime-specific glue (fetcher, cache, poll service, logger
defaults) stays inside `apps/sdk-bun/src/`.

## Adding a new shared utility

1. The utility MUST be runtime-agnostic (no `node:*`, no DOM globals,
   no Cloudflare bindings).
2. Add it under `packages/sdk-shared/src/`.
3. Re-export from `packages/sdk-shared/src/index.ts`.
4. Update the **Architectural Extraction Manifest**, the `MOVED_TO_*`
   constants of `tools/verify-sdk-extraction-manifest.mjs`, so the
   verification stays accurate.

## Build / test

```bash
cd packages/sdk-shared
vp run build
vp run test
```
