// SPDX-License-Identifier: MIT

/**
 * Shared default Confeature SDK version constant.
 *
 * Each per-runtime SDK package (`apps/sdk-*`) ships its own `version.ts`
 * that overrides this string for the `?sdk=<version>` query string of
 * every CDN fetch. Keeping a shared default lets the fetcher inside
 * `sdk-shared` compile in isolation; it never appears in a real
 * request stream because every SDK orchestrator passes its own version
 * down explicitly.
 *
 * Keep in sync with the major version of `apps/sdk-*` packages on
 * Confeature CDN telemetry rollovers.
 */
export const CONFEATURE_SDK_VERSION = "0.1.0";
