// SPDX-License-Identifier: MIT

/**
 * Confeature SDK version stamped into the `?sdk=<version>` query string
 * of every CDN fetch. Re-exports the shared default from
 * `@confeature/sdk-shared` so per-runtime telemetry can be overridden
 * here when a runtime ships a divergent build.
 *
 * Keep in sync with `apps/sdk-node/package.json:version`.
 */
export { CONFEATURE_SDK_VERSION } from "@confeature/sdk-shared";
