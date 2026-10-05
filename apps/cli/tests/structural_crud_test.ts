// SPDX-License-Identifier: MIT

/*
 * `product` / `config` / `environment` `create` + `delete` command tests
 * (#678, epic #676 — CLI write-command parity; no dedicated spec, built directly).
 *
 * Every case drives the command through a MOCK `fetch` (the read seam's
 * injectable `ReadDeps`) so the orchestration is asserted without the network —
 * mirroring the #677 `flag_crud_test.ts` pattern (stub fetch, assert method +
 * URL + body + `Authorization: Bearer`).
 *
 * Coverage per command:
 *   - create success: correct method / path / body / bearer.
 *   - create logged-out: NotLoggedInError, NO network call.
 *   - create missing-required-option: USAGE error naming the option, NO network.
 *   - create `--json`: emits the created model.
 *   - create empty-after-trim `--name`: USAGE error, NO network call.
 *   - delete `--yes` deletes (correct method / path / bearer) vs no-`--yes`
 *     aborts (exit 0) with NO network call.
 *   - delete logged-out: NotLoggedInError, NO network call (even with `--yes`).
 *   - delete missing-required-option: USAGE error naming it.
 *   - delete `--json`: stable success object.
 *   - the bearer token is NEVER printed (create + delete).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runProductCreate, runProductDelete } from "../src/cli/commands/product.ts";
import { runConfigCreate, runConfigDelete } from "../src/cli/commands/config.ts";
import { runEnvironmentCreate, runEnvironmentDelete } from "../src/cli/commands/environment.ts";
import { CliError } from "../src/cli/errors.ts";
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

function ctx(io: Io, args: string[], overrides: Partial<Globals> = {}): RunContext {
  return { globals: globals({ apiUrl: "https://api.example", ...overrides }), args, io };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ORG = { organizationId: "org-1", name: "Acme Inc" };

/** A minimal ProductModel as the create endpoint returns it. */
function product(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    organization: ORG,
    productId: "p-1",
    name: "Web App",
    description: null,
    order: 0,
    reasonRequired: false,
    ...overrides,
  };
}

/** A minimal ConfigModel as the create endpoint returns it. */
function config(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    product: product(),
    configId: "cfg-1",
    name: "Main config",
    description: null,
    order: 0,
    migratedConfigId: null,
    evaluationVersion: "v2",
    ...overrides,
  };
}

/** A minimal EnvironmentModel as the create endpoint returns it. */
function environment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    product: product(),
    environmentId: "env-1",
    name: "Production",
    color: null,
    description: null,
    order: 0,
    reasonRequired: false,
    ...overrides,
  };
}

/** Record every request a command issues: method + URL + body + auth header. */
interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function recordingFetch(
  routes: (call: Call) => Response,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init.headers).get("Authorization");
    const call = { method, url, body, auth };
    calls.push(call);
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

// A fetch stub that flips a flag when called and otherwise 201s — used to prove
// a command NEVER reached the network on the offline / usage-error paths.
function trippingFetch(): { fetch: () => Promise<Response>; called: () => boolean } {
  let tripped = false;
  return {
    fetch: () => {
      tripped = true;
      return Promise.resolve(jsonResponse(201, {}));
    },
    called: () => tripped,
  };
}

const PRODUCTS_PATH = "/v1/products";
const PRODUCT_PATH = "/v1/products/p-1";
const CONFIGS_PATH = "/v1/products/p-1/configs";
const CONFIG_PATH = "/v1/configs/cfg-1";
const ENVIRONMENTS_PATH = "/v1/products/p-1/environments";
const ENVIRONMENT_PATH = "/v1/environments/env-1";

// ── product create ────────────────────────────────────────────────────────────

Deno.test("product create: POSTs createProduct with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(PRODUCTS_PATH)) {
      return jsonResponse(201, product());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runProductCreate(
    ctx(io, ["--name", "Web App"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, PRODUCTS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Web App");

  const text = out.join("\n");
  assertStringIncludes(text, "p-1");
  assertStringIncludes(text, "Web App");
});

Deno.test("product create: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(201, product()));

  await runProductCreate(
    ctx(io, ["--name", "  Web App  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Web App");
});

Deno.test("product create: --json emits the created ProductModel", async () => {
  const { io, out } = captureIo();
  const created = product({ productId: "p-7" });
  const { fetch } = recordingFetch(() => jsonResponse(201, created));

  const code = await runProductCreate(
    ctx(io, ["--name", "Web App"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), created);
});

Deno.test("product create: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductCreate(ctx(io, ["--name", "Web App"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out create must never touch the network");
});

Deno.test("product create: missing --name → USAGE error naming it, no network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductCreate(ctx(io, []), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "a usage error must precede any network call");
});

Deno.test("product create: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductCreate(ctx(io, ["--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("product create: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(201, product()));
  await runProductCreate(
    ctx(io, ["--name", "Web App"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── product delete ────────────────────────────────────────────────────────────

Deno.test("product delete: --yes DELETEs the product with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "DELETE" && call.url.endsWith(PRODUCT_PATH)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runProductDelete(
    ctx(io, ["--product-id", "p-1", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "DELETE");
  assertStringIncludes(calls[0]!.url, PRODUCT_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertStringIncludes(out.join("\n").toLowerCase(), "deleted");
});

Deno.test("product delete: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();

  const code = await runProductDelete(ctx(io, ["--product-id", "p-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: trip.fetch,
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed delete must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "p-1");
  assertStringIncludes(text, "--yes");
});

Deno.test("product delete: --json emits a stable success object", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));

  const code = await runProductDelete(
    ctx(io, ["--product-id", "p-1", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assertEquals(parsed.productId, "p-1");
  assertEquals(parsed.deleted, true);
});

Deno.test("product delete: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runProductDelete(ctx(io, ["--product-id", "p-1", "--yes"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out delete must never touch the network");
});

Deno.test("product delete: missing --product-id → USAGE error naming it", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runProductDelete(ctx(io, ["--yes"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--product-id");
});

Deno.test("product delete: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  await runProductDelete(
    ctx(io, ["--product-id", "p-1", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── config create ─────────────────────────────────────────────────────────────

Deno.test("config create: POSTs createConfig with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(CONFIGS_PATH)) {
      return jsonResponse(201, config());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runConfigCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Main config"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, CONFIGS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Main config");

  const text = out.join("\n");
  assertStringIncludes(text, "cfg-1");
  assertStringIncludes(text, "Main config");
});

Deno.test("config create: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(201, config()));

  await runConfigCreate(
    ctx(io, ["--product-id", "p-1", "--name", "  Main config  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Main config");
});

Deno.test("config create: --json emits the created ConfigModel", async () => {
  const { io, out } = captureIo();
  const created = config({ configId: "cfg-7" });
  const { fetch } = recordingFetch(() => jsonResponse(201, created));

  const code = await runConfigCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Main config"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), created);
});

Deno.test("config create: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runConfigCreate(ctx(io, ["--product-id", "p-1", "--name", "Main config"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out create must never touch the network");
});

Deno.test("config create: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--name", "Main config"], "--product-id"],
      [["--product-id", "p-1"], "--name"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runConfigCreate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("config create: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runConfigCreate(ctx(io, ["--product-id", "p-1", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("config create: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(201, config()));
  await runConfigCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Main config"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── config delete ─────────────────────────────────────────────────────────────

Deno.test("config delete: --yes DELETEs the config with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "DELETE" && call.url.endsWith(CONFIG_PATH)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runConfigDelete(
    ctx(io, ["--config-id", "cfg-1", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "DELETE");
  assertStringIncludes(calls[0]!.url, CONFIG_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertStringIncludes(out.join("\n").toLowerCase(), "deleted");
});

Deno.test("config delete: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();

  const code = await runConfigDelete(ctx(io, ["--config-id", "cfg-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: trip.fetch,
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed delete must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "cfg-1");
  assertStringIncludes(text, "--yes");
});

Deno.test("config delete: --json emits a stable success object", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));

  const code = await runConfigDelete(
    ctx(io, ["--config-id", "cfg-1", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assertEquals(parsed.configId, "cfg-1");
  assertEquals(parsed.deleted, true);
});

Deno.test("config delete: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runConfigDelete(ctx(io, ["--config-id", "cfg-1", "--yes"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out delete must never touch the network");
});

Deno.test("config delete: missing --config-id → USAGE error naming it", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runConfigDelete(ctx(io, ["--yes"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--config-id");
});

Deno.test("config delete: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  await runConfigDelete(
    ctx(io, ["--config-id", "cfg-1", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── environment create ──────────────────────────────────────────────────────────

Deno.test("environment create: POSTs createEnvironment with {name} + bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "POST" && call.url.endsWith(ENVIRONMENTS_PATH)) {
      return jsonResponse(201, environment());
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runEnvironmentCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Production"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "POST");
  assertStringIncludes(calls[0]!.url, ENVIRONMENTS_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertEquals((calls[0]!.body as { name: unknown }).name, "Production");

  const text = out.join("\n");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "Production");
});

Deno.test("environment create: --name is TRIMMED before it is placed in the body", async () => {
  const { io } = captureIo();
  const { fetch, calls } = recordingFetch(() => jsonResponse(201, environment()));

  await runEnvironmentCreate(
    ctx(io, ["--product-id", "p-1", "--name", "  Production  "]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals((calls[0]!.body as { name: unknown }).name, "Production");
});

Deno.test("environment create: --json emits the created EnvironmentModel", async () => {
  const { io, out } = captureIo();
  const created = environment({ environmentId: "env-7" });
  const { fetch } = recordingFetch(() => jsonResponse(201, created));

  const code = await runEnvironmentCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Production"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(JSON.parse(out.join("\n")), created);
});

Deno.test("environment create: logged out → NotLoggedInError, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runEnvironmentCreate(ctx(io, ["--product-id", "p-1", "--name", "Production"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out create must never touch the network");
});

Deno.test("environment create: each missing required option → USAGE error naming it, no network call", async () => {
  for (
    const [args, option] of [
      [["--name", "Production"], "--product-id"],
      [["--product-id", "p-1"], "--name"],
    ] as const
  ) {
    const { io } = captureIo();
    const trip = trippingFetch();
    let thrown: unknown;
    try {
      await runEnvironmentCreate(ctx(io, [...args]), {
        readToken: () => Promise.resolve("tok"),
        fetch: trip.fetch,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof CliError, true, `${option} should raise`);
    assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
    assertStringIncludes((thrown as CliError).message, option);
    assertEquals(trip.called(), false, `${option} usage error must precede any network call`);
  }
});

Deno.test("environment create: empty-after-trim --name → USAGE error, NO network call", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runEnvironmentCreate(ctx(io, ["--product-id", "p-1", "--name", "   "]), {
      readToken: () => Promise.resolve("tok"),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--name");
  assertEquals(trip.called(), false, "an empty name must not reach the network");
});

Deno.test("environment create: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => jsonResponse(201, environment()));
  await runEnvironmentCreate(
    ctx(io, ["--product-id", "p-1", "--name", "Production"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});

// ── environment delete ──────────────────────────────────────────────────────────

Deno.test("environment delete: --yes DELETEs the environment with the bearer (success)", async () => {
  const { io, out } = captureIo();
  const { fetch, calls } = recordingFetch((call) => {
    if (call.method === "DELETE" && call.url.endsWith(ENVIRONMENT_PATH)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: "not_found" });
  });

  const code = await runEnvironmentDelete(
    ctx(io, ["--environment-id", "env-1", "--yes"]),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.method, "DELETE");
  assertStringIncludes(calls[0]!.url, ENVIRONMENT_PATH);
  assertEquals(calls[0]!.auth, "Bearer tok");
  assertStringIncludes(out.join("\n").toLowerCase(), "deleted");
});

Deno.test("environment delete: WITHOUT --yes aborts (exit 0) with NO network call", async () => {
  const { io, out } = captureIo();
  const trip = trippingFetch();

  const code = await runEnvironmentDelete(ctx(io, ["--environment-id", "env-1"]), {
    readToken: () => Promise.resolve("tok"),
    fetch: trip.fetch,
  });

  assertEquals(code, ExitCode.OK);
  assertEquals(trip.called(), false, "an unconfirmed delete must never touch the network");
  const text = out.join("\n");
  assertStringIncludes(text, "env-1");
  assertStringIncludes(text, "--yes");
});

Deno.test("environment delete: --json emits a stable success object", async () => {
  const { io, out } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));

  const code = await runEnvironmentDelete(
    ctx(io, ["--environment-id", "env-1", "--yes"], { outputJson: true }),
    { readToken: () => Promise.resolve("tok"), fetch },
  );

  assertEquals(code, ExitCode.OK);
  const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
  assertEquals(parsed.environmentId, "env-1");
  assertEquals(parsed.deleted, true);
});

Deno.test("environment delete: logged out → NotLoggedInError, NO network call (even with --yes)", async () => {
  const { io } = captureIo();
  const trip = trippingFetch();
  let thrown: unknown;
  try {
    await runEnvironmentDelete(ctx(io, ["--environment-id", "env-1", "--yes"]), {
      readToken: () => Promise.resolve(null),
      fetch: trip.fetch,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof NotLoggedInError, true);
  assertEquals(trip.called(), false, "logged-out delete must never touch the network");
});

Deno.test("environment delete: missing --environment-id → USAGE error naming it", async () => {
  const { io } = captureIo();
  let thrown: unknown;
  try {
    await runEnvironmentDelete(ctx(io, ["--yes"]), {
      readToken: () => Promise.resolve("tok"),
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof CliError, true);
  assertEquals((thrown as CliError).exitCode, ExitCode.USAGE);
  assertStringIncludes((thrown as CliError).message, "--environment-id");
});

Deno.test("environment delete: never prints the bearer token", async () => {
  const { io, out, err } = captureIo();
  const { fetch } = recordingFetch(() => new Response(null, { status: 204 }));
  await runEnvironmentDelete(
    ctx(io, ["--environment-id", "env-1", "--yes"]),
    { readToken: () => Promise.resolve("SECRET-BEARER"), fetch },
  );
  assertEquals([...out, ...err].join("\n").includes("SECRET-BEARER"), false);
});
