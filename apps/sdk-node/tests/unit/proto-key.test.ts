// SPDX-License-Identifier: MIT

/**
 * #826 — `getValueAsync` keeps a flag keyed `__proto__` end to end: from the
 * served config_v6 bytes (`fetch` → parse → cache → evaluate) and from a local
 * flag-overrides map. ConfigCat reserves no key names, so the key is valid.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigCatClient, disposeAllClients } from "../../src/client.ts";
import { createFlagOverridesFromMap, OverrideBehaviour } from "../../src/index.ts";

const VALID_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SERVED =
  '{"p":{"u":"https://cdn.example.test","r":0,"s":"salt"},' +
  '"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}';

afterEach(() => {
  disposeAllClients();
  vi.unstubAllGlobals();
});

describe("#826 — getValueAsync and a flag keyed __proto__", () => {
  test("a served __proto__ flag returns its served value, not the default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(SERVED)));
    const client = new ConfigCatClient(VALID_KEY, 0, { baseUrl: "https://cdn.example.test" });
    await client.waitForReady();
    expect(await client.getValueAsync("__proto__", false)).toBe(true);
    expect(await client.getAllKeysAsync()).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).t).toBeUndefined();
  });

  test("a LocalOnly override keyed __proto__ returns the override value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    const map = JSON.parse('{"__proto__": true}') as Record<string, boolean>;
    const client = new ConfigCatClient(VALID_KEY, 0, {
      baseUrl: "https://cdn.example.test",
      flagOverrides: createFlagOverridesFromMap(map, OverrideBehaviour.LocalOnly),
    });
    expect(await client.getValueAsync("__proto__", false)).toBe(true);
    expect(({} as Record<string, unknown>).b).toBeUndefined();
  });
});
