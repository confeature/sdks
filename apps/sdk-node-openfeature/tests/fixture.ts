// SPDX-License-Identifier: MIT

import { ConfigCatClient, PollingMode } from "@confeature/sdk-node";
import { vi } from "vitest";

import { fixtureKey } from "./seed.mjs";

export const targetedFlag = "stringIsInDogDefaultCat";
export const admin = { targetingKey: "synthetic-admin", Custom1: "admin" };

export function checkedFixtureOrigin(base: string | undefined): string {
  if (
    !base ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(base) ||
    new URL(base).origin !== base
  ) {
    throw new Error("Expected the bound HTTP loopback fixture origin.");
  }
  return base;
}

/** Refuse any other origin and disable redirect following before reaching real fetch. */
export function guardedFetch(origin: string, transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("Fixture request refused outside the bound origin.");
    }
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
  const transport = vi.fn(guardedFetch(baseUrl, globalThis.fetch));
  vi.stubGlobal("fetch", transport);
  return {
    transport,
    createClient: (offline = false) =>
      new ConfigCatClient(fixtureKey, PollingMode.AutoPoll, {
        baseUrl,
        offline,
      }),
  };
}
