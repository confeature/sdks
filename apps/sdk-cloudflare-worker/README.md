# @confeature/sdk-cloudflare-worker

<!-- SPDX-License-Identifier: MIT -->

Confeature Cloudflare Worker SDK — drop-in compatible with
[`@configcat/cloudflare-worker-client`](https://www.npmjs.com/package/@configcat/cloudflare-worker-client).
Thin wrapper on top of [`@confeature/sdk-browser-js`](../sdk-browser-js)
that adds a `workersKvCache` adapter for Cloudflare KV.

> **License**: MIT. SPDX header on every source file.

## Install

```bash
pnpm add @confeature/sdk-cloudflare-worker @confeature/sdk-browser-js
```

`@confeature/sdk-browser-js` is a **peer dependency** — bring your own version.

## Quickstart

```ts
// src/worker.ts
import {
  getConfeatureClient,
  workersKvCache,
  PollingMode,
  type User,
} from "@confeature/sdk-cloudflare-worker";

export interface Env {
  KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = getConfeatureClient({
      sdkKey: "YOUR_SDK_KEY",
      cache: workersKvCache(env.KV),
      pollingMode: "manualPoll",
    });

    const user: User = { identifier: "alice@example.com" };
    const enabled = await client.getValue("new-checkout-flow", false, user);

    return new Response(enabled ? "new flow" : "old flow");
  },
};
```

**SDK key.** Copy it from the Confeature dashboard. It has ConfigCat's own
shape, `configcat-sdk-1/<22 chars>/<22 chars>`; keys minted before that
change (`confeature-sdk-1-<32 chars>-<32 chars>`) are still accepted.

## Migrating from `@configcat/cloudflare-worker-client`

```diff
- import { getClient, configCatKvCache } from "@configcat/cloudflare-worker-client";
+ import { getConfeatureClient, workersKvCache } from "@confeature/sdk-cloudflare-worker";

  const client = getConfeatureClient({
    sdkKey: "YOUR_SDK_KEY",
-   cache: configCatKvCache(env.KV),
+   cache: workersKvCache(env.KV),
  });
```

## `wrangler.toml` example

```toml
name = "my-worker"
main = "src/worker.ts"
compatibility_date = "2024-09-23"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

## ConfigCat parity

| Surface                                           | Status                  |
| ------------------------------------------------- | ----------------------- |
| `getClient`-style factory (`getConfeatureClient`) | ✅                      |
| KV cache adapter (`workersKvCache`)               | ✅                      |
| `getValue<T>(key, default, user?)`                | ✅ (via sdk-browser-js) |
| Polling modes (auto/lazy/manual)                  | ✅ (via sdk-browser-js) |
| `flagOverrides` (LocalOnly)                       | ✅ (via sdk-browser-js) |
| `LocalOverRemote` / `RemoteOverLocal`             | ⏳ SDK-wide deferral    |

## Architecture

This package is a **thin wrapper** — every wire/eval/cache primitive
beyond the KV adapter comes from
[`@confeature/sdk-browser-js`](../sdk-browser-js). 100% of the parity
corpus (58 tuples) is gated through sdk-browser-js's test suite, not
duplicated here.

## License

[MIT](./LICENSE).
