// SPDX-License-Identifier: MIT

/**
 * Per-SDK version constant. Appended to the `?sdk=` query parameter on
 * every CDN fetch so server-side telemetry can break down traffic by
 * runtime + version.
 *
 * The shared default (`CONFEATURE_SDK_VERSION` in `@confeature/sdk-shared`)
 * stamps every SDK at `confeature-sdk-shared/<version>`; per-SDK files
 * like this one specialise the marker so traffic is attributable.
 */
export const CONFEATURE_SDK_VERSION = "confeature-sdk-bun/0.1.0";
