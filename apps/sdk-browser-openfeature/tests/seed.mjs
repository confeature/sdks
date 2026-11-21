// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rules = require("@confeature/test-fixtures-sdk-parity/fixtures/config-v6.rules.json");

export const fixtureKey = "openfeature-browser-fixture";
export const targetedFlag = "stringIsInDogDefaultCat";

export function createSeed(attribute = "admin") {
  const payload = structuredClone(rules);
  payload.p.u = "";
  payload.f[targetedFlag].r[1].c[0].u.l = [attribute];
  return { schemaVersion: "1.0", keys: [{ sdkKey: fixtureKey, payload }] };
}
