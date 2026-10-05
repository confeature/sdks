// SPDX-License-Identifier: MIT

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runOrgLs } from "../src/cli/commands/org.ts";
import { runProductLs } from "../src/cli/commands/product.ts";
import { NotLoggedInError } from "../src/cli/read.ts";
import type { RunContext } from "../src/cli/commands/registry.ts";
import type { Globals } from "../src/cli/globals.ts";
import type { Io } from "../src/cli/io.ts";
import { ExitCode } from "../src/cli/exit.ts";

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function globals(overrides: Partial<Globals> = {}): Globals {
  return { help: false, version: false, outputJson: false, ...overrides };
}

function ctx(io: Io, overrides: Partial<Globals> = {}, args: string[] = []): RunContext {
  return { globals: globals(overrides), args, io };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ORG_ALPHA = { organizationId: "org-alpha", name: "Alpha Inc" };
const ORG_BETA = { organizationId: "org-beta", name: "Beta LLC" };

/** A minimal ProductModel for the org it belongs to. */
function product(productId: string, name: string, org: { organizationId: string; name: string }) {
  return {
    organization: org,
    productId,
    name,
    description: null,
    order: 0,
    reasonRequired: false,
  };
}

// ── org ls (R1) ─────────────────────────────────────────────────────────────

Deno.test("org ls: renders the user's organizations (R1)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runOrgLs(ctx(io, { apiUrl: "https://api.example" }), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(jsonResponse(200, [ORG_ALPHA, ORG_BETA]));
    },
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(urls, ["https://api.example/v1/organizations"]);
  const text = out.join("\n");
  assertStringIncludes(text, "org-alpha");
  assertStringIncludes(text, "Alpha Inc");
  assertStringIncludes(text, "org-beta");
  assertStringIncludes(text, "Beta LLC");
});

Deno.test("org ls: --json emits a stable, parseable array (R7)", async () => {
  const { io, out } = captureIo();
  const code = await runOrgLs(ctx(io, { apiUrl: "https://api.example", outputJson: true }), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, [ORG_ALPHA, ORG_BETA])),
  });

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n"));
  assertEquals(parsed, [ORG_ALPHA, ORG_BETA]);
});

Deno.test("org ls: empty result → 'none found', exit 0 (R10)", async () => {
  const { io, out } = captureIo();
  const code = await runOrgLs(ctx(io, { apiUrl: "https://api.example" }), {
    readToken: () => Promise.resolve("tok"),
    fetch: () => Promise.resolve(jsonResponse(200, [])),
  });

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no organizations");
});

Deno.test("org ls: logged out → NotLoggedInError, NO network call (R8)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runOrgLs(ctx(io, { apiUrl: "https://api.example" }), {
      readToken: () => Promise.resolve(null),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, []));
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals((thrown as NotLoggedInError).exitCode, ExitCode.AUTH);
  assertStringIncludes((thrown as NotLoggedInError).message, "not logged in");
  assertEquals(fetchCalled, false, "logged-out reads must never touch the network");
});

Deno.test("org ls: a server-side 401 also reads as not logged in (R8)", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runOrgLs(ctx(io, { apiUrl: "https://api.example" }), {
      readToken: () => Promise.resolve("revoked"),
      fetch: () => Promise.resolve(jsonResponse(401, { message: "unauthorized" })),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
});

Deno.test("org ls: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  await runOrgLs(ctx(io, { apiUrl: "https://api.example" }), {
    readToken: () => Promise.resolve("SECRET-BEARER"),
    fetch: () => Promise.resolve(jsonResponse(200, [ORG_ALPHA])),
  });
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── product ls (R2) ───────────────────────────────────────────────────────────

Deno.test("product ls: aggregates per-org calls and labels each row with its org (R2)", async () => {
  const { io, out } = captureIo();
  const urls: string[] = [];
  const code = await runProductLs(ctx(io, { apiUrl: "https://api.example" }), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      urls.push(url);
      if (url.endsWith("/v1/organizations")) {
        return Promise.resolve(jsonResponse(200, [ORG_ALPHA, ORG_BETA]));
      }
      if (url.includes("organizationId=org-alpha")) {
        return Promise.resolve(
          jsonResponse(200, [product("p-1", "Web App", ORG_ALPHA)]),
        );
      }
      if (url.includes("organizationId=org-beta")) {
        return Promise.resolve(
          jsonResponse(200, [product("p-2", "Mobile", ORG_BETA)]),
        );
      }
      return Promise.resolve(jsonResponse(404, { message: "not found" }));
    },
  });

  assertEquals(code, ExitCode.OK);
  // One org-list call + one products call per org (bounded by membership count).
  assertEquals(urls, [
    "https://api.example/v1/organizations",
    "https://api.example/v1/products?organizationId=org-alpha",
    "https://api.example/v1/products?organizationId=org-beta",
  ]);
  const text = out.join("\n");
  assertStringIncludes(text, "Web App");
  assertStringIncludes(text, "Mobile");
  // Each row carries its org label (cross-org column).
  assertStringIncludes(text, "Alpha Inc");
  assertStringIncludes(text, "Beta LLC");
});

Deno.test("product ls: --json emits the aggregated array (R7)", async () => {
  const { io, out } = captureIo();
  const alpha = product("p-1", "Web App", ORG_ALPHA);
  const beta = product("p-2", "Mobile", ORG_BETA);
  const code = await runProductLs(ctx(io, { apiUrl: "https://api.example", outputJson: true }), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      if (url.endsWith("/v1/organizations")) {
        return Promise.resolve(jsonResponse(200, [ORG_ALPHA, ORG_BETA]));
      }
      if (url.includes("organizationId=org-alpha")) {
        return Promise.resolve(jsonResponse(200, [alpha]));
      }
      return Promise.resolve(jsonResponse(200, [beta]));
    },
  });

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n"));
  assertEquals(parsed, [alpha, beta]);
});

Deno.test("product ls: no products across any org → 'no products', exit 0 (R10)", async () => {
  const { io, out } = captureIo();
  const code = await runProductLs(ctx(io, { apiUrl: "https://api.example" }), {
    readToken: () => Promise.resolve("tok"),
    fetch: (url) => {
      if (url.endsWith("/v1/organizations")) {
        return Promise.resolve(jsonResponse(200, [ORG_ALPHA]));
      }
      return Promise.resolve(jsonResponse(200, []));
    },
  });

  assertEquals(code, ExitCode.OK);
  assertStringIncludes(out.join("\n").toLowerCase(), "no products");
});

Deno.test("product ls: logged out → NotLoggedInError, NO network call (R8)", async () => {
  const { io } = captureIo();
  let fetchCalled = false;
  let thrown: unknown;
  try {
    await runProductLs(ctx(io, { apiUrl: "https://api.example" }), {
      readToken: () => Promise.resolve(null),
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, []));
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(fetchCalled, false, "logged-out reads must never touch the network");
});
