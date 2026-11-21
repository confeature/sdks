// SPDX-License-Identifier: MIT

import {
  ConfigCatClient,
  CONFEATURE_SDK_VERSION,
  PollingMode,
  type IOptions,
} from "@confeature/sdk-browser-js";
import { vi } from "vitest";

import { createSeed, fixtureKey } from "./seed.mjs";

export { targetedFlag } from "./seed.mjs";

export const admin = { targetingKey: "synthetic-admin", Custom1: "admin" };
export const viewer = { targetingKey: "synthetic-viewer", Custom1: "viewer" };

export const configPath = `/configuration-files/${fixtureKey}/config_v6.json?sdk=${CONFEATURE_SDK_VERSION}`;

export function checkedFixtureOrigin(origin: string | undefined): string {
  if (
    !origin ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) ||
    new URL(origin).origin !== origin
  ) {
    throw new Error("Expected the bound HTTP loopback fixture origin.");
  }
  return origin;
}

/** Refuse other URLs before fetching and stop redirects at the first response. */
export function guardedFetch(expected: string, transport: typeof fetch): typeof fetch {
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
    createClient: (mode: PollingMode = PollingMode.ManualPoll, options: IOptions = {}) =>
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
