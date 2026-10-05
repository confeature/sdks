// SPDX-License-Identifier: MIT

/**
 * The migration promise, proven with the REAL ConfigCat SDK (#802).
 *
 * "Keep your ConfigCat SDK, change baseUrl": a stock `configcat-node` client,
 * given a Confeature SDK key and the CDN's address, must evaluate the flag
 * value Confeature published — not fall back to the default. Until #802 it
 * could not even be constructed: `configcat-common` rejects a key that is not
 * ConfigCat-shaped (`Invalid 'sdkKey' value`), and the CDN had no route for
 * the three-segment path a ConfigCat-shaped key produces.
 *
 * `configcat-node` carries the same `configcat-common` key validation as
 * `configcat-js` (which needs a browser runtime), so this covers both; the
 * Python case lives in sdk-python's live suite.
 *
 * It runs against the live-contract harness (the reference origin of the CDN
 * read path) through
 * the agreed boot, `live-contract-harness --corpus-seed --exec -- …`, and it
 * asserts that the harness actually recorded the request — so it cannot pass
 * without the SDK having reached the CDN.
 *
 * GATING (fail closed), as `wire-cases.live.test.ts`: skipped only when
 * `CONFEATURE_LIVE` is unset; set without `LIVE_HARNESS_URL`, it throws.
 */

import { afterAll, describe, expect, test } from "vitest";
import * as configcat from "configcat-node";

import shapes from "@confeature/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json" with { type: "json" };
import booleanConfig from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.boolean.json" with { type: "json" };

const LIVE = process.env.CONFEATURE_LIVE === "1";
const HARNESS_URL = (process.env.LIVE_HARNESS_URL ?? "").replace(/\/$/, "");
if (LIVE && !HARNESS_URL) {
  throw new Error(
    "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through " +
      "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping",
  );
}

/** A key in the shape Confeature now mints (`configcat-sdk-1/<22>/<22>`). */
const KEY = shapes.valid.find((v) => v.key.startsWith("configcat-sdk-1/"))!.key;

const clients: configcat.IConfigCatClient[] = [];
afterAll(() => {
  for (const c of clients) c.dispose();
});

describe.skipIf(!LIVE)("a stock ConfigCat SDK against Confeature (#802)", () => {
  test("configcat-node, given a Confeature key and the CDN, evaluates the published value", async () => {
    const seeded = await fetch(`${HARNESS_URL}/admin/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [{ sdkKey: KEY, payload: booleanConfig }] }),
    });
    expect(seeded.status, await seeded.clone().text()).toBe(200);

    // Constructing the client is the first thing that failed before #802.
    const client = configcat.getClient(KEY, configcat.PollingMode.ManualPoll, {
      baseUrl: HARNESS_URL,
    });
    clients.push(client);
    await client.forceRefreshAsync();

    // The fixture publishes `feature.dark-mode` = true; the default is false,
    // so a failed fetch cannot pass.
    expect(await client.getValueAsync("feature.dark-mode", false)).toBe(true);

    const log = (await (
      await fetch(`${HARNESS_URL}/admin/requests?sdkKey=${encodeURIComponent(KEY)}`)
    ).json()) as { requests: Array<{ url: string }> };
    expect(log.requests.length, "the harness saw the SDK's request").toBeGreaterThan(0);
  });
});
