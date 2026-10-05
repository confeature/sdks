// SPDX-License-Identifier: MIT

/**
 * Default browser logger — re-exports `ConfigCatConsoleLogger` from
 * `@confeature/sdk-shared` so customers get a working logger out of the
 * box. The shared `ConfigCatConsoleLogger` writes to
 * `console.debug/info/warn/error` and is filtered by `LogLevel` — which
 * is exactly the contract `configcat-js`'s browser bundle exposes.
 *
 * Re-exporting (instead of subclassing) keeps the per-runtime bundle
 * minimal: every byte saved counts against the SC-002 25 KB ceiling.
 */
export { ConfigCatConsoleLogger as BrowserLogger } from "@confeature/sdk-shared";
