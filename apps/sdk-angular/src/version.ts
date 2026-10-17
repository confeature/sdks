// SPDX-License-Identifier: MIT

/**
 * Angular-layer version stamp. Kept in lockstep with `package.json`
 * `"version"` — bump both together when cutting a release.
 *
 * The runtime SDK's `CONFEATURE_SDK_VERSION` is what surfaces in the
 * `X-ConfigCat-UserAgent` header — that comes from
 * `@confeature/sdk-browser-js`. The Angular layer's own version is
 * exposed for adopters who want to introspect which adapter version
 * they pulled.
 */
export const SDK_VERSION = "0.1.1";
