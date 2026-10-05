// SPDX-License-Identifier: MIT

/**
 * #803 FR-001 — the bytes ON THE WIRE, not the string the SDK built. Every
 * corpus case that pins `expected.requestPath` is replayed through sdk-node's
 * real `HttpConfigFetcher` and Node's real `fetch` (undici) to a raw
 * `node:http` server. `req.url` is the request-target exactly as it arrived on
 * the request line — never decoded or re-parsed — so a client that re-encodes
 * (`$` → `%24`), normalises, or escapes per UTF-16 unit cannot pass. The path
 * part must equal `expected.requestPath` byte for byte.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LoggerWrapper, NullLogger } from "@confeature/sdk-shared";
import wireCases from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases.json" with { type: "json" };
import type { WireCase } from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";

import { HttpConfigFetcher } from "../../src/config-fetcher.ts";
import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";

const PAYLOAD = '{"p":{"u":"https://cdn.example.test","r":0,"s":"v1"},"f":{},"s":[]}';

let server: Server;
let baseUrl = "";
const requestTargets: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestTargets.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(PAYLOAD);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const pathCases = (wireCases.cases as unknown as WireCase[]).filter(
  (c) => typeof c.expected.requestPath === "string",
);

describe("the request line on the wire = corpus expected.requestPath, byte for byte", () => {
  test("the corpus pins the malformed-key case (so this suite can't go vacuous)", () => {
    expect(pathCases.map((c) => c.id)).toContain("request-path-malformed-key");
  });

  for (const wireCase of pathCases) {
    test(wireCase.id, async () => {
      const sdkKey = wireCase.given.sdkKey;
      expect(typeof sdkKey, `${wireCase.id} pins given.sdkKey`).toBe("string");
      requestTargets.length = 0;

      const outcome = await new HttpConfigFetcher(
        baseUrl,
        new LoggerWrapper(new NullLogger()),
      ).fetchAsync(sdkKey!, null, new AbortController().signal);

      expect(outcome.status).toBe("fetched");
      expect(requestTargets).toHaveLength(1);
      const target = requestTargets[0]!;
      const q = target.indexOf("?");
      expect(q === -1 ? target : target.slice(0, q)).toBe(wireCase.expected.requestPath);
      expect(target.slice(q)).toBe(`?sdk=${CONFEATURE_SDK_VERSION}`);
    });
  }
});
