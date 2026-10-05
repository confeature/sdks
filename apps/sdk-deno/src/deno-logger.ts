// SPDX-License-Identifier: MIT

/**
 * Default Deno logger — re-exports `ConfigCatConsoleLogger` from
 * `@confeature/sdk-shared` so customers get a working logger out of
 * the box. The shared `ConfigCatConsoleLogger` writes to
 * `console.debug/info/warn/error` and is filtered by `LogLevel` — which
 * is exactly the contract `configcat-js`'s bundle exposes.
 *
 * Re-exporting (instead of subclassing) keeps the per-runtime bundle
 * minimal: every byte saved counts against the SC-002 25 KB ceiling.
 *
 * Deno supports `globalThis.console.*` natively — no runtime guard
 * required.
 */
export { ConfigCatConsoleLogger as DenoLogger } from "@confeature/sdk-shared";
