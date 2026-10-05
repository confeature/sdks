// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { sdkKeyFromUrl } from "../src/fault-injector.js";
import { SeededKeySchema } from "../src/seed-schema.js";
import { readFileSync } from "node:fs";

const shapes = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json",
      import.meta.url,
    ),
    "utf-8",
  ),
) as { valid: Array<{ name: string; key: string }> };

// #802: the harness's one path-to-key home must read every form the CDN Worker
// serves — a form it missed would make request recording and fault injection
// silently do nothing, and a live suite would pass without testing anything.

const url = (path: string) => new URL(`http://127.0.0.1${path}`);
const newShape = shapes.valid.find((v) => v.key.startsWith("configcat-sdk-1/"))!.key;
const legacy = shapes.valid.find((v) => v.key.startsWith("confeature-sdk-1-"))!.key;

describe("sdkKeyFromUrl (#802)", () => {
  it("reads a ConfigCat-shaped key sent raw, as stock ConfigCat SDKs send it", () => {
    expect(sdkKeyFromUrl(url(`/configuration-files/${newShape}/config_v6.json`))).toBe(newShape);
  });

  it("reads a ConfigCat-shaped key sent %2F-encoded, as the Confeature SDKs send it", () => {
    const encoded = encodeURIComponent(newShape);
    expect(sdkKeyFromUrl(url(`/configuration-files/${encoded}/config_v6.json`))).toBe(newShape);
  });

  it("still reads a legacy key", () => {
    expect(sdkKeyFromUrl(url(`/configuration-files/${legacy}/config_v6.json`))).toBe(legacy);
  });

  it.each([
    "/configuration-files/a/b/config_v6.json",
    "/configuration-files/configcat-sdk-1/a/config_v6.json",
    "/v2/configuration-files/abc/config_v6.json",
    "/configuration-files/%E0%A4%A/config_v6.json",
  ])("rejects %s", (path) => {
    expect(sdkKeyFromUrl(url(path))).toBeNull();
  });
});

describe("seed schema accepts every valid key shape (#802)", () => {
  it.each(shapes.valid.map((v) => [v.name, v.key]))("%s", (_name, key) => {
    expect(SeededKeySchema.safeParse({ sdkKey: key, payload: null }).success).toBe(true);
  });

  it("still refuses any other slash", () => {
    expect(SeededKeySchema.safeParse({ sdkKey: "a/b", payload: null }).success).toBe(false);
  });
});
