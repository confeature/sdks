// SPDX-License-Identifier: MIT

import { ConfigCatClient, CONFEATURE_SDK_VERSION, PollingMode } from "@confeature/sdk-browser-js";
import { vi } from "vitest";

import { createSeed, fixtureKey } from "./seed.mjs";

export { targetedFlag } from "./seed.mjs";

export const admin = { targetingKey: "synthetic-admin", Custom1: "admin" };
export const viewer = { targetingKey: "synthetic-viewer", Custom1: "viewer" };

export const configPath = `/configuration-files/${fixtureKey}/config_v6.json?sdk=${CONFEATURE_SDK_VERSION}`;

/** @param {string | undefined} origin */
export function checkedFixtureOrigin(origin) {
  if (
    !origin ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) ||
    new URL(origin).origin !== origin
  ) {
    throw new Error("Expected the bound HTTP loopback fixture origin.");
  }
  return origin;
}

/**
 * Refuse other URLs before fetching and stop redirects at the first response.
 * @param {string} expected
 * @param {typeof fetch} transport
 * @returns {typeof fetch}
 */
export function guardedFetch(expected, transport) {
  return async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url !== expected) throw new Error("Unexpected fixture request URL.");

    const response = await transport(input, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("Fixture redirect refused.");
    }
    return response;
  };
}

export function installFixtureTransport() {
  const baseUrl = checkedFixtureOrigin(process.env.LIVE_HARNESS_URL);
  const seed = guardedFetch(`${baseUrl}/admin/seed`, globalThis.fetch);
  const transport = vi.fn(guardedFetch(`${baseUrl}${configPath}`, globalThis.fetch));
  vi.stubGlobal("fetch", transport);

  return {
    transport,
    /**
     * @param {import("@confeature/sdk-browser-js").PollingMode} [mode]
     * @param {import("@confeature/sdk-browser-js").IOptions} [options]
     */
    createClient: (mode = PollingMode.ManualPoll, options = {}) =>
      new ConfigCatClient(fixtureKey, mode, { ...options, baseUrl }),
    async reseed(attribute = "viewer") {
      const response = await seed(`${baseUrl}/admin/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createSeed(attribute)),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error("Fixture reseed failed.");
    },
  };
}
