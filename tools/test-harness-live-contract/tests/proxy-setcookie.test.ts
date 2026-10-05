// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { writeResponse } from "../src/proxy-server.js";

/**
 * #342 — the proxy must forward multiple Set-Cookie headers as distinct
 * occurrences, never comma-folded (RFC 6265 §3 — Expires legally contains
 * a comma). Unit-tests writeResponse against a synthetic upstream Response.
 */

function makeRes(): {
  res: ServerResponse;
  captured: { status: number; headers: Record<string, string | string[]>; ended: boolean };
} {
  const captured = { status: 0, headers: {} as Record<string, string | string[]>, ended: false };
  const res = {
    writeHead(status: number, headers: Record<string, string | string[]>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    write() {
      return true;
    },
    end() {
      captured.ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

describe("proxy writeResponse Set-Cookie handling (#342)", () => {
  it("forwards multiple Set-Cookie headers as distinct values (no comma-fold)", async () => {
    const response = new Response("ok", {
      headers: [
        ["set-cookie", "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT"],
        ["set-cookie", "b=2; Path=/"],
      ],
    });
    const { res, captured } = makeRes();
    await writeResponse(res, response);

    const sc = captured.headers["set-cookie"];
    expect(Array.isArray(sc)).toBe(true);
    expect(sc).toEqual(["a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT", "b=2; Path=/"]);
    // The whole point: it must NOT collapse to a single comma-joined string.
    expect(typeof sc).not.toBe("string");
    expect(captured.ended).toBe(true);
  });

  it("omits Set-Cookie when the upstream emits none, passing other headers through", async () => {
    const response = new Response("ok", { headers: { "content-type": "text/plain" } });
    const { res, captured } = makeRes();
    await writeResponse(res, response);

    expect(captured.headers["set-cookie"]).toBeUndefined();
    expect(captured.headers["content-type"]).toBe("text/plain");
  });
});
