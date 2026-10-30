// SPDX-License-Identifier: MIT

/**
 * #803 FR-001 — the bytes ON THE WIRE, not the string the SDK built. Every
 * corpus case that pins `expected.requestPath` is replayed through sdk-node's
 * real `HttpConfigFetcher` and Node's real `fetch` (undici) to a raw
 * `node:http` server. `req.url` is the request-target exactly as it arrived on
 * the request line — never decoded or re-parsed — so a client that re-encodes
 * (`$` → `%24`), normalises, or escapes per UTF-16 unit cannot pass. The path
 * part must equal `expected.requestPath` byte for byte.
 *
 * The corpus 1.4 redirect cases (#834) run the same way, over real TLS: an
 * https origin answers the case's 30x, and the http downgrade target — the
 * same `host:port`, told apart by scheme — counts what reaches it on the wire.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LoggerWrapper, NullLogger } from "@confeature/sdk-shared";
import configBoolean from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.boolean.json" with { type: "json" };
import wireCases from "@confeature/test-fixtures-sdk-parity/fixtures/wire-cases.json" with { type: "json" };
import {
  assertWireCase,
  sdkKeyFor,
  type WireCase,
} from "@confeature/test-fixtures-sdk-parity/wire-test-helpers";

import { HttpConfigFetcher } from "../../src/config-fetcher.ts";
import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";
import { selfSignedLoopbackCert } from "./self-signed-cert.ts";

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

// ---- Corpus 1.4 redirect cases, over real TLS (#834) ----------------------

const redirectCases = (wireCases.cases as unknown as WireCase[]).filter(
  (c) => c.server.redirect !== undefined,
);
const REDIRECT_SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("redirect cases on the wire: an https origin, its http downgrade target", () => {
  let front: ReturnType<typeof createNetServer>;
  let tlsServer: ReturnType<typeof createTlsServer>;
  let plainServer: Server;
  let authority = "";
  let wireCase: WireCase;
  const httpsTargets: string[] = [];
  const downgradeTargets: string[] = [];
  const defaultCAs = getCACertificates("default");

  /** The case's target answer: its status, headers and config body. */
  const answerTarget = (res: ServerResponse): void => {
    res.writeHead(wireCase.server.status, wireCase.server.headers);
    res.end(JSON.stringify(configBoolean));
  };

  beforeAll(async () => {
    const { cert, key } = selfSignedLoopbackCert();
    // Trust the throwaway cert for this file's worker only; restored below.
    setDefaultCACertificates([...defaultCAs, cert]);
    tlsServer = createTlsServer({ cert, key }, (req, res) => {
      httpsTargets.push(req.url ?? "");
      if (httpsTargets.length > 1) return answerTarget(res);
      const redirect = wireCase.server.redirect!;
      const location = redirect.location
        .replace("{origin}", authority)
        .replace("{samePath}", req.url ?? "/");
      res.writeHead(redirect.status, { Location: location });
      res.end();
    });
    plainServer = createServer((req, res) => {
      downgradeTargets.push(req.url ?? "");
      answerTarget(res);
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const tlsPort = (tlsServer.address() as AddressInfo).port;
    // One port for both schemes, as `{origin}` demands: a TLS ClientHello
    // starts with 0x16, anything else is plain HTTP. TLS is relayed to the
    // https server over loopback — a TLS socket reads the raw handle, so the
    // sniffed first bytes could not be handed back to it in place.
    front = createNetServer((socket: Socket) => {
      socket.once("data", (first: Buffer) => {
        if (first[0] !== 0x16) {
          socket.pause();
          socket.unshift(first);
          plainServer.emit("connection", socket);
          socket.resume();
          return;
        }
        const upstream = connect(tlsPort, "127.0.0.1", () => {
          upstream.write(first);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    authority = `127.0.0.1:${String((front.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    setDefaultCACertificates(defaultCAs);
    tlsServer.closeAllConnections();
    plainServer.closeAllConnections();
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  test("the corpus carries both redirect cases (so this suite can't go vacuous)", () => {
    expect(redirectCases.map((c) => c.id).sort()).toEqual([
      "redirect-https-to-http-refused",
      "redirect-https-to-https-followed",
    ]);
  });

  for (const c of redirectCases) {
    test(c.id, async () => {
      wireCase = c;
      httpsTargets.length = 0;
      downgradeTargets.length = 0;
      const sdkKey = sdkKeyFor(c, REDIRECT_SDK_KEY);

      const outcome = await new HttpConfigFetcher(
        `https://${authority}`,
        new LoggerWrapper(new NullLogger()),
      ).fetchAsync(sdkKey, c.given.previousEtag, AbortSignal.timeout(5_000));

      // The request the SDK sent first, as the https origin received it.
      expect(httpsTargets.length).toBeGreaterThan(0);
      assertWireCase(
        c,
        outcome,
        {
          url: `https://${authority}${httpsTargets[0]!}`,
          ifNoneMatch: null,
          downgradeTargetRequests: downgradeTargets.length,
        },
        sdkKey,
        CONFEATURE_SDK_VERSION,
      );
    });
  }
});
