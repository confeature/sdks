// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ConfigCatClient, disposeAllClients } from "../../src/client.ts";

import fixturePayload from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.boolean.json" with { type: "json" };

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE_URL = "https://cdn.example.test";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"bench-etag"' },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  disposeAllClients();
  vi.unstubAllGlobals();
});

describe("Microbench — cache-served getValueAsync (SC-002)", () => {
  test("p95 of 1000 getValueAsync calls < 1ms; exactly 1 fetch", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(fixturePayload));
    vi.stubGlobal("fetch", spy);

    const client = new ConfigCatClient(SDK_KEY, 0, { baseUrl: BASE_URL });
    const refresh = await client.forceRefreshAsync();
    expect(refresh.isSuccess).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Warm-up (JIT, monomorphisation).
    for (let i = 0; i < 200; i++) {
      await client.getValueAsync("feature.dark-mode", false);
    }

    const samples: number[] = Array.from({ length: 1000 }, () => 0);
    for (let i = 0; i < samples.length; i++) {
      const t0 = performance.now();
      await client.getValueAsync("feature.dark-mode", false);
      const t1 = performance.now();
      samples[i] = t1 - t0;
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    // Surface the measurement so the report shows a real number.
    // eslint-disable-next-line no-console
    console.log(`microbench p95: ${p95.toFixed(4)}ms`);

    expect(p95).toBeLessThan(1);
    expect(spy).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
