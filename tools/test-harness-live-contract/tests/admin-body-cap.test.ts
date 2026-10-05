// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AdminState,
  PayloadTooLargeError,
  handleSeed,
  maxAdminBodyBytes,
  readJsonBody,
  handleReset,
} from "../src/admin-routes.js";

/**
 * #341 — admin endpoints must cap the request body (default 1 MiB, env-
 * configurable but always enforced) and answer 413 when exceeded.
 */

function makeReq(chunks: Buffer[]): IncomingMessage {
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) yield c;
  }
  const iterator = gen();
  return {
    // The shape of a legitimate test client, so the admin caller guard
    // (plan 680 US4) lets it through to the body cap under test.
    socket: { remoteAddress: "127.0.0.1", localPort: 4100 },
    headers: { host: "127.0.0.1:4100" },
    destroy() {
      /* no-op for the mock */
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      if (body) captured.body = body;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

const orig = process.env.LC_HARNESS_MAX_BODY_BYTES;
afterEach(() => {
  if (orig === undefined) delete process.env.LC_HARNESS_MAX_BODY_BYTES;
  else process.env.LC_HARNESS_MAX_BODY_BYTES = orig;
});

describe("admin body-size cap (#341)", () => {
  it("defaults to 1 MiB", () => {
    delete process.env.LC_HARNESS_MAX_BODY_BYTES;
    expect(maxAdminBodyBytes()).toBe(1024 * 1024);
  });

  it("falls back to the default on an invalid env value (always enforced)", () => {
    process.env.LC_HARNESS_MAX_BODY_BYTES = "-5";
    expect(maxAdminBodyBytes()).toBe(1024 * 1024);
    process.env.LC_HARNESS_MAX_BODY_BYTES = "not-a-number";
    expect(maxAdminBodyBytes()).toBe(1024 * 1024);
  });

  it("reads a body under the cap (200 path)", async () => {
    const out = await readJsonBody(makeReq([Buffer.from(JSON.stringify({ a: 1 }))]));
    expect(out).toEqual({ a: 1 });
  });

  it("throws PayloadTooLargeError when the body exceeds the cap", async () => {
    process.env.LC_HARNESS_MAX_BODY_BYTES = "8";
    await expect(readJsonBody(makeReq([Buffer.alloc(64, 0x61)]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("handleSeed answers 413 when the body exceeds the cap (413 path)", async () => {
    process.env.LC_HARNESS_MAX_BODY_BYTES = "8";
    const { res, captured } = makeRes();
    const deps = {
      host: { seed: async () => undefined } as unknown as Parameters<typeof handleSeed>[2]["host"],
      state: new AdminState(),
      cwd: process.cwd(),
    };
    await handleSeed(makeReq([Buffer.alloc(64, 0x61)]), res, deps);
    expect(captured.status).toBe(413);
    expect(captured.body).toMatch(/exceeds/);
  });
});

describe("admin handlers map a KV failure to 500 (plan 680 FR-004)", () => {
  it("handleReset answers 500 and leaves the fault state untouched", async () => {
    const { res, captured } = makeRes();
    const state = new AdminState();
    state.setFault("live", "5xx");
    const deps = {
      host: {
        clear: async () => undefined,
        seed: async () => {
          throw new Error("KV down");
        },
      } as unknown as Parameters<typeof handleReset>[2]["host"],
      state,
      cwd: process.cwd(),
    };
    const seed = { schemaVersion: "1.0", keys: [{ sdkKey: "a", payload: null, fault: "404" }] };
    await handleReset(makeReq([Buffer.from(JSON.stringify({ seed }))]), res, deps);
    expect(captured.status).toBe(500);
    expect(captured.body).toMatch(/KV reset failed: KV down/);
    expect(Object.fromEntries(state.faults)).toEqual({ live: "5xx" });
  });
});
