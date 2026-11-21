// SPDX-License-Identifier: MIT

// This test helper remains live only while the packed consumer is running.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const listener = process.env.LIVE_HARNESS_URL;
const fixtureKey = process.env.OPENFEATURE_RUST_FIXTURE_KEY;
if (!command || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(listener ?? "")) {
  throw new Error("The Rust fixture requires a bound HTTP loopback listener and a command");
}
if (fixtureKey !== "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB") {
  throw new Error("The Rust harness requires the registered synthetic fixture key");
}
const fixtureUrl = new URL(`/configuration-files/${fixtureKey}/config_v6.json`, listener);
const proof = await mkdtemp(join(tmpdir(), "confeature-rust-proxy-"));
const cancellation = join(proof, "cancelled");

const stats = {
  blocked: 0,
  connect: 0,
  forwarded: 0,
  redirects: 0,
  delayed: 0,
  cancelled: 0,
  canary: 0,
};
const canary = createServer((_request, response) => {
  stats.canary += 1;
  response.writeHead(500).end();
});
const canaryOrigin = await listen(canary);
const proxy = createServer((incoming, response) => {
  if (incoming.method !== "GET" || incoming.url !== fixtureUrl.href) {
    stats.blocked += 1;
    return response.writeHead(403).end();
  }
  if (incoming.headers["x-confeature-fixture-redirect"] === "1") {
    stats.redirects += 1;
    return response.writeHead(302, { location: `${canaryOrigin}/redirected` }).end();
  }
  stats.forwarded += 1;
  const headers = {};
  for (const name of ["if-none-match", "user-agent", "x-configcat-useragent"]) {
    const value = incoming.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const delayed = incoming.headers["x-confeature-fixture-delay"] === "1";
  let sent = false;
  let timer;
  let reply;
  const upstream = request(fixtureUrl, { method: "GET", headers }, (result) => {
    reply = result;
    const forward = () => {
      sent = true;
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    };
    if (delayed) timer = setTimeout(forward, 5000);
    else forward();
  });
  upstream.once("error", () => {
    if (!response.destroyed && !response.headersSent) response.writeHead(502).end();
  });
  if (delayed) {
    stats.delayed += 1;
    response.once("close", () => {
      clearTimeout(timer);
      if (!sent) {
        stats.cancelled += 1;
        writeFileSync(cancellation, "closed\n");
      }
      reply?.destroy();
      upstream.destroy();
    });
  }
  upstream.end();
});
proxy.on("connect", (_incoming, socket) => {
  stats.connect += 1;
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});

try {
  const env = {
    ...process.env,
    OPENFEATURE_RUST_PROXY: await listen(proxy),
    OPENFEATURE_RUST_CANARY: canaryOrigin,
    OPENFEATURE_RUST_CANCEL_ACK: cancellation,
  };
  const child = spawn(command, args, { env, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, forward);
  let code;
  try {
    [code] = await once(child, "exit");
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
  if (code !== 0) throw new Error(`The Rust packed consumer exited with ${code}`);
  if (
    stats.canary !== 0 ||
    stats.blocked !== 1 ||
    stats.connect !== 1 ||
    stats.redirects !== 1 ||
    stats.delayed !== 1 ||
    stats.cancelled !== 1 ||
    stats.forwarded < 1
  ) {
    throw new Error(`Rust transport checks did not execute as expected: ${JSON.stringify(stats)}`);
  }
  console.log(`Rust guarded loopback: ${JSON.stringify(stats)}`);
} finally {
  for (const server of [proxy, canary]) {
    server.closeAllConnections();
    server.close();
  }
  await rm(proof, { force: true, recursive: true });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
