// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { AdminState, enforceAdminCaller } from "../src/admin-routes.js";

/**
 * Unit-test the admin caller guard directly. The harness only binds to
 * 127.0.0.1 so simulating a non-loopback caller end-to-end is not
 * possible without OS-level fakery. The guard is a single function;
 * unit-testing it with a mocked socket gives the same coverage with
 * zero infra cost.
 */

type FakeRes = {
  statusCode: number;
  written: string;
  headers: Record<string, string>;
  writeHead(this: FakeRes, code: number, headers: Record<string, string>): void;
  end(this: FakeRes, body: string): void;
  headersSent?: boolean;
};

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    written: "",
    headers: {},
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.written = body;
    },
  };
}

type Guard = typeof enforceAdminCaller;

/** A request as the guard sees it: source address, bound port, headers. */
function call(
  remoteAddress: string,
  headers: Record<string, string> = { host: "127.0.0.1:4100" },
): { ok: boolean; res: FakeRes } {
  const res = makeRes();
  const ok = enforceAdminCaller(
    { socket: { remoteAddress, localPort: 4100 }, headers } as unknown as Parameters<Guard>[0],
    res as unknown as Parameters<Guard>[1],
  );
  return { ok, res };
}

describe("admin caller guard — loopback source (FR-014)", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("allows %s", (remote) => {
    const { ok, res } = call(remote);
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(200); // unmodified
  });

  it.each(["192.168.1.42", ""])("refuses remote %j with 403", (remote) => {
    const { ok, res } = call(remote);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.written).toMatch(/loopback-only/);
  });
});

describe("admin caller guard — a browser cannot drive it (plan 680 US4)", () => {
  it("allows the Node fetch shape: loopback Host, no Origin, no Sec-Fetch-Site", () => {
    expect(
      call("127.0.0.1", { host: "127.0.0.1:4100", "content-type": "application/json" }).ok,
    ).toBe(true);
  });

  it("allows the python-requests shape: localhost Host, no browser headers", () => {
    expect(
      call("127.0.0.1", { host: "localhost:4100", "user-agent": "python-requests/2.32" }).ok,
    ).toBe(true);
  });

  it("allows Sec-Fetch-Site: none (a user-typed navigation, not a cross-site request)", () => {
    expect(call("127.0.0.1", { host: "127.0.0.1:4100", "sec-fetch-site": "none" }).ok).toBe(true);
  });

  it.each([
    ["an Origin header", { host: "127.0.0.1:4100", origin: "https://evil.example" }, /Origin/],
    [
      "Sec-Fetch-Site: cross-site",
      { host: "127.0.0.1:4100", "sec-fetch-site": "cross-site" },
      /Sec-Fetch-Site/,
    ],
    [
      "Sec-Fetch-Site: same-site",
      { host: "127.0.0.1:4100", "sec-fetch-site": "same-site" },
      /Sec-Fetch-Site/,
    ],
    ["a rebound Host", { host: "evil.example:4100" }, /Host/],
    ["a Host on another port", { host: "127.0.0.1:9999" }, /Host/],
    ["no Host at all", {}, /Host/],
  ])("refuses %s with 403 even from loopback", (_name, headers, reason) => {
    const { ok, res } = call("127.0.0.1", headers as Record<string, string>);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.written).toMatch(reason);
  });
});

describe("AdminState fault map", () => {
  it("setFault returns the previous value and overwrites in-place", () => {
    const state = new AdminState();
    expect(state.setFault("k1", "5xx")).toBe(null);
    expect(state.setFault("k1", "404")).toBe("5xx");
    expect(state.getFault("k1")).toBe("404");
  });

  it("setFault('none') clears the entry", () => {
    const state = new AdminState();
    state.setFault("k1", "5xx");
    expect(state.setFault("k1", "none")).toBe("5xx");
    expect(state.getFault("k1")).toBeUndefined();
  });
});
